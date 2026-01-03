import { kv } from '@vercel/kv';
import { getCorsHeaders } from './_cors';
import { logError, logWarn } from './_logger';

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

// Circuit breaker state keys
const CIRCUIT_BREAKER_KEY = 'circuit:elevation';
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RESET_TIMEOUT = 60; // seconds

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

async function getCircuitState(): Promise<CircuitState> {
  const state = await kv.get<CircuitState>(CIRCUIT_BREAKER_KEY);
  return state || { failures: 0, lastFailure: 0, isOpen: false };
}

async function recordSuccess(): Promise<void> {
  // Reset circuit on success
  await kv.del(CIRCUIT_BREAKER_KEY);
}

async function recordFailure(): Promise<boolean> {
  const state = await getCircuitState();
  const now = Math.floor(Date.now() / 1000);

  // If circuit was open and timeout has passed, this is a test request
  if (state.isOpen && (now - state.lastFailure) > CIRCUIT_RESET_TIMEOUT) {
    // Allow this request through (half-open state)
    return false;
  }

  state.failures++;
  state.lastFailure = now;
  state.isOpen = state.failures >= CIRCUIT_FAILURE_THRESHOLD;

  await kv.set(CIRCUIT_BREAKER_KEY, state, { ex: CIRCUIT_RESET_TIMEOUT * 2 });

  return state.isOpen;
}

async function isCircuitOpen(): Promise<{ open: boolean; resetIn?: number }> {
  const state = await getCircuitState();
  const now = Math.floor(Date.now() / 1000);

  if (!state.isOpen) {
    return { open: false };
  }

  const timeSinceFailure = now - state.lastFailure;
  if (timeSinceFailure > CIRCUIT_RESET_TIMEOUT) {
    // Circuit is in half-open state, allow one request through
    return { open: false };
  }

  return { open: true, resetIn: CIRCUIT_RESET_TIMEOUT - timeSinceFailure };
}

// Round coordinates to ~11m precision (4 decimal places)
// This provides consistent cache keys regardless of minor coordinate variations
function roundCoord(coord: number, decimals: number = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(coord * factor) / factor;
}

function elevationCacheKey(lat: number, lon: number): string {
  // Round to 4 decimal places (~11m precision at equator)
  // This ensures nearby points hit the same cache entry
  return `elev:${roundCoord(lat, 4)}:${roundCoord(lon, 4)}`;
}

async function getCachedElevation(lat: number, lon: number): Promise<number | null> {
  const key = elevationCacheKey(lat, lon);
  return kv.get<number>(key);
}

async function setCachedElevation(lat: number, lon: number, elevation: number): Promise<void> {
  const key = elevationCacheKey(lat, lon);
  await kv.set(key, elevation, { ex: CACHE_TTL });
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
    const body: ElevationRequest = await req.json();

    if (!body.locations?.length) {
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
        typeof loc.lat !== 'number' || typeof loc.lon !== 'number' ||
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

    // Check circuit breaker before making external requests
    const circuit = await isCircuitOpen();
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

    const results: ElevationResult[] = [];
    const uncached: { index: number; lat: number; lon: number }[] = [];

    // Check cache for each point
    for (let i = 0; i < body.locations.length; i++) {
      const loc = body.locations[i];
      const cached = await getCachedElevation(loc.lat, loc.lon);

      if (cached !== null) {
        results[i] = { lat: loc.lat, lon: loc.lon, elevation: cached };
      } else {
        uncached.push({ index: i, ...loc });
      }
    }

    // Fetch uncached points in batches
    for (let i = 0; i < uncached.length; i += MAX_POINTS_PER_REQUEST) {
      const batch = uncached.slice(i, i + MAX_POINTS_PER_REQUEST);
      const locations = batch.map(p => ({ lat: p.lat, lon: p.lon }));

      try {
        const elevations = await fetchElevations(locations);

        // Success - record it to potentially close circuit
        await recordSuccess();

        for (let j = 0; j < batch.length; j++) {
          const point = batch[j];
          const elev = elevations[j];
          results[point.index] = elev;

          // Cache the result (only if we got a valid elevation)
          if (elev.elevation !== null) {
            await setCachedElevation(point.lat, point.lon, elev.elevation);
          }
        }
      } catch (error) {
        logError('elevation:fetch', error, { batchSize: batch.length });

        // Record failure for circuit breaker
        const circuitOpened = await recordFailure();
        if (circuitOpened) {
          logWarn('elevation:circuit', 'Circuit breaker opened for elevation API');
        }

        // Fill failed points with null
        for (const point of batch) {
          results[point.index] = { lat: point.lat, lon: point.lon, elevation: null };
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
