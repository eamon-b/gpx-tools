import { kv } from '@vercel/kv';
import { getCorsHeaders } from './_cors';

const HEALTH_CHECK_KEY = 'health:check';

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const checks: Record<string, boolean> = {};
  const details: Record<string, string> = {};

  // Check KV connection with actual read/write test
  try {
    const testValue = `health-${Date.now()}`;
    await kv.set(HEALTH_CHECK_KEY, testValue, { ex: 60 });
    const retrieved = await kv.get<string>(HEALTH_CHECK_KEY);
    checks.kv = retrieved === testValue;
    if (!checks.kv) {
      details.kv = 'Read/write mismatch';
    }
  } catch (error) {
    checks.kv = false;
    details.kv = error instanceof Error ? error.message : 'Unknown error';
  }

  // Check Overpass API
  try {
    const response = await fetch('https://overpass-api.de/api/status', {
      signal: AbortSignal.timeout(5000),
    });
    checks.overpass = response.ok;
    if (!response.ok) {
      details.overpass = `HTTP ${response.status}`;
    }
  } catch (error) {
    checks.overpass = false;
    details.overpass = error instanceof Error ? error.message : 'Timeout or network error';
  }

  // Check Open Elevation
  try {
    const response = await fetch('https://api.open-elevation.com/api/v1/lookup?locations=0,0', {
      signal: AbortSignal.timeout(5000),
    });
    checks.elevation = response.ok;
    if (!response.ok) {
      details.elevation = `HTTP ${response.status}`;
    }
  } catch (error) {
    checks.elevation = false;
    details.elevation = error instanceof Error ? error.message : 'Timeout or network error';
  }

  const allHealthy = Object.values(checks).every(v => v);
  // Degraded if at least KV works but external services are down
  const isDegraded = checks.kv && (!checks.overpass || !checks.elevation);

  return new Response(JSON.stringify({
    status: allHealthy ? 'healthy' : (isDegraded ? 'degraded' : 'unhealthy'),
    checks,
    details: Object.keys(details).length > 0 ? details : undefined,
    timestamp: new Date().toISOString(),
  }), {
    status: allHealthy ? 200 : (isDegraded ? 200 : 503),
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
