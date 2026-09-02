import { createHash } from "crypto";
import { getCorsHeaders } from "./_cors";
import { logError, logInfo } from "./_logger";
import { createRedisClient } from "./_redis";
import {
  POI_TYPES,
  buildOverpassQuery,
  parseOverpassArea,
  roundCoord,
  validateOverpassArea,
  type OverpassArea,
  type POIType,
} from "../lib/osm-poi";

// Cache entries are raw JSON strings that we hand straight back as the response
// body, so disable automatic (de)serialization to keep them byte-for-byte on
// read. (@upstash/redis stores strings verbatim but JSON.parses them on read by
// default, which would turn the cached payload back into an object.)
const redis = createRedisClient({ automaticDeserialization: false });

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "10");
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || "604800"); // 7 days

// vercel.json gives this function maxDuration 30. Overpass gets 22 s to run the
// query and the HTTP call is aborted at 27 s, which leaves room to still emit a
// structured 503 before the platform kills the invocation.
const OVERPASS_TIMEOUT_SECONDS = 22;
const FETCH_TIMEOUT_MS = 27000;

// Upstash rejects values above 1 MB; stay under it with room for encoding
// overhead rather than failing the request on an unusually dense area.
const MAX_CACHE_BYTES = 900 * 1024;

const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 3600;

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/**
 * Every coordinate rounded to the shared ~11 m grid, so that the cache key and
 * the query text are derived from exactly the same numbers. Two requests whose
 * corridors differ only below that precision therefore share a cache entry.
 */
function canonicalizeArea(area: OverpassArea): OverpassArea {
  if ("corridor" in area) {
    return {
      corridor: area.corridor.map((p) => ({
        lat: roundCoord(p.lat),
        lon: roundCoord(p.lon),
      })),
      radiusMeters: Math.round(area.radiusMeters),
    };
  }
  return {
    bounds: {
      south: roundCoord(area.bounds.south),
      north: roundCoord(area.bounds.north),
      west: roundCoord(area.bounds.west),
      east: roundCoord(area.bounds.east),
    },
  };
}

/** Reject anything that is not a non-empty array of known POI types. */
function validateTypes(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return `types must be a non-empty array. Known types: ${POI_TYPES.join(", ")}`;
  }
  for (const type of value) {
    if (typeof type !== "string" || !POI_TYPES.includes(type as POIType)) {
      return `Unknown POI type: ${JSON.stringify(type)}. Known types: ${POI_TYPES.join(", ")}`;
    }
  }
  return null;
}

/** sha256 over the canonical (rounded) area plus the deduped, sorted types. */
function hashRequest(area: OverpassArea, types: POIType[]): string {
  const canonical = JSON.stringify({ area, types });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Overpass sends `Retry-After` as either a delta in seconds or an HTTP date.
 * Anything we cannot make sense of falls back to a sane fixed delay.
 */
function parseRetryAfter(header: string | null): number {
  const clamp = (n: number) =>
    Math.min(Math.max(Math.ceil(n), 1), MAX_RETRY_AFTER_SECONDS);

  if (!header) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return clamp(seconds);
  }
  const timestamp = Date.parse(header);
  if (!Number.isNaN(timestamp)) {
    const delta = (timestamp - Date.now()) / 1000;
    if (delta > 0) {
      return clamp(delta);
    }
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Redis is a cache and a courtesy limiter, not a dependency: if it is
 * unreachable we log and carry on (fail-open) rather than failing a request the
 * user could otherwise have served from Overpass.
 */
async function bestEffort<T>(
  context: string,
  operation: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    logError(context, error);
    return { ok: false };
  }
}

async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const key = `ratelimit:${ip}`;

  // Use atomic increment to avoid race conditions
  // INCR creates the key with value 1 if it doesn't exist
  const count = await redis.incr(key);

  // Set expiry only on first request (when count is 1)
  // This is still a race but harmless - worst case we reset the window slightly
  if (count === 1) {
    await redis.expire(key, 60);
  }

  if (count > RATE_LIMIT) {
    const ttl = await redis.ttl(key);
    return { allowed: false, remaining: 0, resetIn: ttl > 0 ? ttl : 60 };
  }

  return { allowed: true, remaining: RATE_LIMIT - count, resetIn: 60 };
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // Set when any Redis call fails, so the response can say the cache was
  // bypassed instead of claiming a MISS that will never become a HIT.
  let redisDegraded = false;

  try {
    // Rate limiting (fail-open: a Redis outage must not lock everyone out)
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    const limit = await bestEffort("overpass:ratelimit", () =>
      checkRateLimit(ip)
    );
    if (!limit.ok) {
      redisDegraded = true;
    }
    const rateLimit: RateLimitResult = limit.ok
      ? limit.value
      : { allowed: true, remaining: RATE_LIMIT, resetIn: 60 };

    if (!rateLimit.allowed) {
      return jsonResponse(
        { error: "Rate limit exceeded", resetIn: rateLimit.resetIn },
        429,
        {
          ...corsHeaders,
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": rateLimit.resetIn.toString(),
          "Retry-After": rateLimit.resetIn.toString(),
        }
      );
    }

    // Parse request
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
    }

    // Validate the area (corridor or bbox) and the requested POI types
    const areaError = validateOverpassArea(body);
    if (areaError) {
      return jsonResponse({ error: areaError }, 400, corsHeaders);
    }
    const typesError = validateTypes((body as { types?: unknown }).types);
    if (typesError) {
      return jsonResponse({ error: typesError }, 400, corsHeaders);
    }

    const parsed = parseOverpassArea(body);
    if (!parsed) {
      return jsonResponse(
        {
          error:
            "Could not parse area. Expected {corridor, radiusMeters} or {bounds}.",
        },
        400,
        corsHeaders
      );
    }

    // Canonical form drives BOTH the cache key and the query text.
    const area = canonicalizeArea(parsed);
    const types: POIType[] = [
      ...new Set((body as { types: POIType[] }).types),
    ].sort();

    const cacheKey = `overpass:${hashRequest(area, types)}`;
    const cacheRead = await bestEffort("overpass:cache-get", () =>
      redis.get<string>(cacheKey)
    );
    if (!cacheRead.ok) {
      redisDegraded = true;
    }
    const cached = cacheRead.ok ? cacheRead.value : null;

    if (typeof cached === "string" && cached.length > 0) {
      return new Response(cached, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Cache": "HIT",
          "X-RateLimit-Remaining": rateLimit.remaining.toString(),
        },
      });
    }

    // Build and execute query
    const query = buildOverpassQuery(area, types, {
      timeoutSeconds: OVERPASS_TIMEOUT_SECONDS,
    });

    let overpassResponse: Response;
    try {
      overpassResponse = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      logError("overpass:fetch", error, { aborted });
      if (aborted) {
        // A timeout is a "come back later", not a permanent failure.
        return jsonResponse(
          {
            error: "Overpass API timed out",
            retryAfter: DEFAULT_RETRY_AFTER_SECONDS,
            resetIn: DEFAULT_RETRY_AFTER_SECONDS,
          },
          503,
          {
            ...corsHeaders,
            "Retry-After": String(DEFAULT_RETRY_AFTER_SECONDS),
          }
        );
      }
      return jsonResponse(
        { error: "Overpass API unreachable" },
        502,
        corsHeaders
      );
    }

    if (!overpassResponse.ok) {
      const errorText = await overpassResponse.text().catch(() => "");
      logError("overpass:api", errorText, { status: overpassResponse.status });

      // 429 (slot/quota exhausted) and 504 (gateway timeout) are transient:
      // tell the client to retry rather than reporting a hard upstream error.
      if (overpassResponse.status === 429 || overpassResponse.status === 504) {
        const retryAfter = parseRetryAfter(
          overpassResponse.headers.get("retry-after")
        );
        return jsonResponse(
          {
            error: "Overpass API is busy. Please retry shortly.",
            status: overpassResponse.status,
            retryAfter,
            // `resetIn` is what the client's backoff reads.
            resetIn: retryAfter,
          },
          503,
          { ...corsHeaders, "Retry-After": String(retryAfter) }
        );
      }

      return jsonResponse(
        { error: "Overpass API error", status: overpassResponse.status },
        502,
        corsHeaders
      );
    }

    const data = await overpassResponse.text();

    // Cache response (best effort; an oversize payload is simply not cached)
    if (Buffer.byteLength(data, "utf8") <= MAX_CACHE_BYTES) {
      const written = await bestEffort("overpass:cache-set", () =>
        redis.set(cacheKey, data, { ex: CACHE_TTL })
      );
      if (!written.ok) {
        redisDegraded = true;
      }
    } else {
      logInfo("overpass:cache-skip", "Payload too large to cache", {
        bytes: Buffer.byteLength(data, "utf8"),
        limit: MAX_CACHE_BYTES,
      });
    }

    return new Response(data, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": redisDegraded ? "BYPASS" : "MISS",
        "X-RateLimit-Remaining": rateLimit.remaining.toString(),
      },
    });
  } catch (error) {
    logError("overpass:handler", error);
    return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
  }
}
