import { getCorsHeaders } from './_cors';
import { envPositiveInt } from './_env';
import { logError, logWarn } from './_logger';
import { checkRateLimit, clientIp, type RateLimitResult } from './_ratelimit';
import { createRedisClient } from './_redis';
import { roundCoord } from '../lib/osm-poi';

// Values here are structured (circuit-breaker objects, numeric elevations), so
// keep @upstash/redis's default JSON (de)serialization.
const redis = createRedisClient();

interface ElevationRequest {
  locations: { lat: number; lon: number }[];
}

interface ElevationResult {
  lat: number;
  lon: number;
  elevation: number | null;
}

const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';
const MAX_POINTS_PER_REQUEST = 100;
const CACHE_TTL = 86400 * 365; // 1 year (elevation doesn't change)

// Requests per IP per minute. Each request can carry 1000 points and fan out to
// ten upstream calls, so without a limit this endpoint is a free open-elevation
// proxy billed to us. Higher than the Overpass default because the client sends
// a long route as several 200-point batches.
const RATE_LIMIT = envPositiveInt('ELEVATION_RATE_LIMIT_PER_MINUTE', 30);

// Circuit breaker state keys
const CIRCUIT_BREAKER_KEY = 'circuit:elevation';
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RESET_TIMEOUT = 60; // seconds

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

/**
 * Redis backs the cache, the circuit breaker and the rate limiter here, and
 * none of those is worth failing a request over: if it is unreachable, log and
 * carry on with `fallback` (no cache, breaker closed).
 */
async function bestEffort<T>(context: string, operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logError(context, error);
    return fallback;
  }
}

async function getCircuitState(): Promise<CircuitState> {
  const state = await redis.get<CircuitState>(CIRCUIT_BREAKER_KEY);
  return state || { failures: 0, lastFailure: 0, isOpen: false };
}

async function recordSuccess(): Promise<void> {
  // Reset circuit on success
  await redis.del(CIRCUIT_BREAKER_KEY);
}

/**
 * Count an upstream failure. Returns true when the circuit is (now) open.
 *
 * This also covers the half-open probe: a probe that fails pushes
 * `lastFailure` forward, so the circuit stays open for another full timeout
 * instead of letting every request through to a service that is still down.
 */
async function recordFailure(): Promise<boolean> {
  const state = await getCircuitState();

  state.failures++;
  state.lastFailure = Math.floor(Date.now() / 1000);
  state.isOpen = state.failures >= CIRCUIT_FAILURE_THRESHOLD;

  await redis.set(CIRCUIT_BREAKER_KEY, state, { ex: CIRCUIT_RESET_TIMEOUT * 2 });

  return state.isOpen;
}

/**
 * May this request call the upstream API?
 *
 * Closed: yes. Open: no, until the reset timeout has passed. After that the
 * circuit is half-open and exactly one request is let through as a probe:
 * admitting it restarts the timeout, so concurrent and following requests keep
 * being refused until the probe reports back - success closes the circuit
 * (`recordSuccess`), failure re-opens it (`recordFailure`), and a probe that
 * dies without reporting simply lets the next one through a timeout later.
 */
async function isCircuitOpen(): Promise<{ open: boolean; resetIn?: number }> {
  const state = await getCircuitState();
  const now = Math.floor(Date.now() / 1000);

  if (!state.isOpen) {
    return { open: false };
  }

  const timeSinceFailure = now - state.lastFailure;
  if (timeSinceFailure <= CIRCUIT_RESET_TIMEOUT) {
    return { open: true, resetIn: Math.max(1, CIRCUIT_RESET_TIMEOUT - timeSinceFailure) };
  }

  // Half-open: claim the probe.
  await redis.set(
    CIRCUIT_BREAKER_KEY,
    { ...state, lastFailure: now },
    { ex: CIRCUIT_RESET_TIMEOUT * 2 }
  );
  return { open: false };
}

// Keys use the shared ~11 m grid (4 decimal places), so nearby points - and
// the same point sent with different float noise - hit the same cache entry.
function elevationCacheKey(lat: number, lon: number): string {
  return `elev:${roundCoord(lat)}:${roundCoord(lon)}`;
}

/**
 * Cached elevations for a list of locations, in order; null where there is no
 * entry. One MGET for the whole request: a GET per point is up to a thousand
 * sequential HTTP round trips to Upstash, which alone can outlast the
 * function's 30 s budget.
 */
async function getCachedElevations(
  locations: { lat: number; lon: number }[]
): Promise<(number | null)[]> {
  const keys = locations.map(loc => elevationCacheKey(loc.lat, loc.lon));
  const values = await redis.mget<(number | null)[]>(...keys);
  return keys.map((_, i) => {
    const value = values?.[i];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
}

/** Cache a batch of elevations in a single pipelined request. */
async function setCachedElevations(
  entries: { lat: number; lon: number; elevation: number }[]
): Promise<void> {
  if (entries.length === 0) return;
  const pipeline = redis.pipeline();
  for (const entry of entries) {
    pipeline.set(elevationCacheKey(entry.lat, entry.lon), entry.elevation, { ex: CACHE_TTL });
  }
  await pipeline.exec();
}

const FETCH_TIMEOUT_MS = 15000; // 15 second timeout for external API

async function fetchElevations(locations: { lat: number; lon: number }[]): Promise<ElevationResult[]> {
  const response = await fetch(OPEN_ELEVATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Open Elevation API error: ${response.status}`);
  }

  const data = await response.json();
  return data.results.map((r: { latitude: number; longitude: number; elevation: number }) => ({
    lat: r.latitude,
    lon: r.longitude,
    elevation: r.elevation,
  }));
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    let body: ElevationRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!Array.isArray(body?.locations) || body.locations.length === 0) {
      return new Response(JSON.stringify({ error: 'No locations provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body.locations.length > 1000) {
      return new Response(JSON.stringify({ error: 'Maximum 1000 points per request' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate coordinate bounds
    for (const loc of body.locations) {
      if (
        !loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number' ||
        loc.lat < -90 || loc.lat > 90 ||
        loc.lon < -180 || loc.lon > 180
      ) {
        return new Response(JSON.stringify({
          error: 'Invalid coordinates. Latitude must be -90 to 90, longitude -180 to 180.',
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const results: ElevationResult[] = [];
    const uncached: { index: number; lat: number; lon: number }[] = [];

    // Check the cache for every point in one round trip
    const cachedElevations = await bestEffort(
      'elevation:cache-get',
      () => getCachedElevations(body.locations),
      body.locations.map(() => null)
    );
    for (let i = 0; i < body.locations.length; i++) {
      const loc = body.locations[i];
      const cached = cachedElevations[i];

      if (cached !== null) {
        results[i] = { lat: loc.lat, lon: loc.lon, elevation: cached };
      } else {
        uncached.push({ index: i, lat: loc.lat, lon: loc.lon });
      }
    }

    // The rate limit and the circuit breaker both guard the upstream API, so
    // they apply only when there is something to ask it. A request answered
    // entirely from the cache costs neither quota nor an upstream call, and
    // is served even while the upstream is down.
    if (uncached.length > 0) {
      // Rate limit, failing open: a Redis outage must not lock everyone out.
      let rateLimit: RateLimitResult | null = null;
      try {
        rateLimit = await checkRateLimit(redis, `ratelimit:elevation:${clientIp(req)}`, RATE_LIMIT);
      } catch (error) {
        logError('elevation:ratelimit', error);
      }
      if (rateLimit && !rateLimit.allowed) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded', resetIn: rateLimit.resetIn }), {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(rateLimit.resetIn),
            'Retry-After': String(rateLimit.resetIn),
          },
        });
      }

      // Check the circuit breaker before making external requests
      const circuit = await bestEffort('elevation:circuit', isCircuitOpen, { open: false });
      if (circuit.open) {
        return new Response(JSON.stringify({
          error: 'Elevation service temporarily unavailable',
          resetIn: circuit.resetIn,
          hint: 'The external elevation API is experiencing issues. Try again later.',
        }), {
          status: 503,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(circuit.resetIn || 60),
          },
        });
      }
    }

    // Fetch uncached points in batches
    for (let i = 0; i < uncached.length; i += MAX_POINTS_PER_REQUEST) {
      const batch = uncached.slice(i, i + MAX_POINTS_PER_REQUEST);
      const locations = batch.map(p => ({ lat: p.lat, lon: p.lon }));

      try {
        const elevations = await fetchElevations(locations);

        // Success - record it to potentially close circuit
        await bestEffort('elevation:circuit', recordSuccess, undefined);

        // Match results to points by coordinate, not by position: a reply that
        // is reordered or short must not cache one point's elevation under
        // another's key for a year. A point with no matching result gets null.
        const byKey = new Map<string, number>();
        for (const elev of elevations) {
          if (typeof elev.elevation === 'number' && Number.isFinite(elev.elevation)) {
            byKey.set(elevationCacheKey(elev.lat, elev.lon), elev.elevation);
          }
        }

        const toCache: { lat: number; lon: number; elevation: number }[] = [];
        for (const point of batch) {
          const elevation = byKey.get(elevationCacheKey(point.lat, point.lon)) ?? null;
          results[point.index] = { lat: point.lat, lon: point.lon, elevation };
          if (elevation !== null) {
            toCache.push({ lat: point.lat, lon: point.lon, elevation });
          }
        }
        await bestEffort('elevation:cache-set', () => setCachedElevations(toCache), undefined);
      } catch (error) {
        logError('elevation:fetch', error, { batchSize: batch.length });

        // Record failure for circuit breaker
        const circuitOpened = await bestEffort('elevation:circuit', recordFailure, false);
        if (circuitOpened) {
          logWarn('elevation:circuit', 'Circuit breaker opened for elevation API');
        }

        // Fill failed points with null
        for (const point of batch) {
          results[point.index] = { lat: point.lat, lon: point.lon, elevation: null };
        }

        // Once the circuit is open, stop: the remaining batches of this
        // request would only queue more calls onto a service that is down.
        if (circuitOpened) {
          for (const point of uncached.slice(i + MAX_POINTS_PER_REQUEST)) {
            results[point.index] = { lat: point.lat, lon: point.lon, elevation: null };
          }
          break;
        }
      }

      // Rate limit between batches
      if (i + MAX_POINTS_PER_REQUEST < uncached.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return new Response(JSON.stringify({
      results,
      cached: body.locations.length - uncached.length,
      fetched: uncached.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    logError('elevation:handler', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
