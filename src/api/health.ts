import { getCorsHeaders } from './_cors';
import { logError } from './_logger';
import { checkRateLimit, clientIp } from './_ratelimit';
import { createRedisClient } from './_redis';

const HEALTH_CHECK_KEY = 'health:check';

/**
 * How long one probe result is reused. The endpoint is public and linked from
 * the landing page, and a probe is a Redis write plus a request to a service
 * other people run for free; nobody needs a fresher answer than this.
 */
const RESULT_TTL_MS = 30_000;

/** Fresh probes one client may trigger per minute once the cached result expires. */
const PROBE_LIMIT_PER_MINUTE = 6;

const PROBE_TIMEOUT_MS = 5000;

const redis = createRedisClient();

interface HealthResult {
  status: number;
  body: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Record<string, boolean>;
    details?: Record<string, string>;
    timestamp: string;
  };
}

/** Last probe result of this function instance, and the probe in flight, if any. */
let cached: { at: number; result: HealthResult } | null = null;
let inFlight: Promise<HealthResult> | null = null;

/** Test hook: forget the cached result. */
export function resetHealthCache(): void {
  cached = null;
  inFlight = null;
}

type Check = { ok: boolean; detail?: string };

async function checkRedis(): Promise<Check> {
  try {
    const testValue = `health-${Date.now()}`;
    await redis.set(HEALTH_CHECK_KEY, testValue, { ex: 60 });
    const retrieved = await redis.get<string>(HEALTH_CHECK_KEY);
    // A concurrent instance may have overwritten the key between the two
    // calls; any health value read back proves the round trip works.
    const ok = typeof retrieved === 'string' && retrieved.startsWith('health-');
    return ok ? { ok } : { ok, detail: 'Read/write mismatch' };
  } catch (error) {
    // The client's error text can name the store's host; keep it in the logs.
    logError('health:kv', error);
    return { ok: false, detail: 'Unreachable' };
  }
}

async function checkUpstream(context: string, url: string): Promise<Check> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    // Only the status matters; release the connection without reading the body.
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    logError(context, error);
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, detail: timedOut ? 'Timed out' : 'Network error' };
  }
}

async function probe(): Promise<HealthResult> {
  // Independent checks: run them side by side rather than up to 15 s in a row.
  const [kv, overpass] = await Promise.all([
    checkRedis(),
    checkUpstream('health:overpass', 'https://overpass-api.de/api/status'),
  ]);

  const checks: Record<string, boolean> = {
    kv: kv.ok,
    overpass: overpass.ok,
  };
  const details: Record<string, string> = {};
  if (kv.detail) details.kv = kv.detail;
  if (overpass.detail) details.overpass = overpass.detail;

  const allHealthy = Object.values(checks).every(v => v);
  // Degraded if at least KV works but the external service is down
  const isDegraded = checks.kv && !checks.overpass;

  return {
    status: allHealthy || isDegraded ? 200 : 503,
    body: {
      status: allHealthy ? 'healthy' : isDegraded ? 'degraded' : 'unhealthy',
      checks,
      details: Object.keys(details).length > 0 ? details : undefined,
      timestamp: new Date().toISOString(),
    },
  };
}

function respond(
  req: Request,
  result: HealthResult,
  corsHeaders: Record<string, string>,
  ageMs: number
): Response {
  const headers = {
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Age: String(Math.max(0, Math.floor(ageMs / 1000))),
  };
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(result.body), {
    status: result.status,
    headers,
  });
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'GET, HEAD, OPTIONS' },
    });
  }

  // A recent result answers the request without touching Redis or anyone
  // else's server, however often the endpoint is hit.
  const now = Date.now();
  if (cached && now - cached.at < RESULT_TTL_MS) {
    return respond(req, cached.result, corsHeaders, now - cached.at);
  }

  // A fresh probe is the expensive part, so that is what gets rationed. Fails
  // open: when Redis is the thing that is down, reporting it matters most.
  if (!inFlight) {
    try {
      const limit = await checkRateLimit(
        redis,
        `ratelimit:health:${clientIp(req)}`,
        PROBE_LIMIT_PER_MINUTE
      );
      if (!limit.allowed) {
        // Prefer a stale answer to no answer.
        if (cached) {
          return respond(req, cached.result, corsHeaders, now - cached.at);
        }
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded', resetIn: limit.resetIn }),
          {
            status: 429,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Retry-After': String(limit.resetIn),
            },
          }
        );
      }
    } catch (error) {
      logError('health:ratelimit', error);
    }
  }

  // Concurrent requests share one probe instead of each starting their own.
  if (!inFlight) {
    inFlight = probe().finally(() => {
      inFlight = null;
    });
  }
  const result = await inFlight;
  cached = { at: Date.now(), result };
  return respond(req, result, corsHeaders, 0);
}
