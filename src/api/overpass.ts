import { kv } from '@vercel/kv';
import { createHash } from 'crypto';
import { getCorsHeaders } from './_cors';
import { logError } from './_logger';

interface OverpassRequest {
  bounds: {
    south: number;
    north: number;
    west: number;
    east: number;
  };
  types: ('water' | 'camping' | 'resupply' | 'transport' | 'emergency')[];
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '10');
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '604800'); // 7 days

// OSM tag mappings for each POI type
const TYPE_QUERIES: Record<string, string> = {
  water: `
    node["amenity"="drinking_water"]({{bbox}});
    node["natural"="spring"]({{bbox}});
    node["man_made"="water_tap"]({{bbox}});
    way["natural"="water"]["name"]({{bbox}});
  `,
  camping: `
    node["tourism"="camp_site"]({{bbox}});
    node["tourism"="alpine_hut"]({{bbox}});
    node["tourism"="wilderness_hut"]({{bbox}});
    node["amenity"="shelter"]({{bbox}});
  `,
  resupply: `
    node["shop"="supermarket"]({{bbox}});
    node["shop"="convenience"]({{bbox}});
    node["shop"="general"]({{bbox}});
    node["amenity"="cafe"]({{bbox}});
    node["amenity"="restaurant"]({{bbox}});
  `,
  transport: `
    node["highway"="bus_stop"]({{bbox}});
    node["railway"="station"]({{bbox}});
    node["railway"="halt"]({{bbox}});
  `,
  emergency: `
    node["amenity"="hospital"]({{bbox}});
    node["amenity"="pharmacy"]({{bbox}});
    node["amenity"="police"]({{bbox}});
  `,
};

function buildOverpassQuery(bounds: OverpassRequest['bounds'], types: string[]): string {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const typeQueries = types
    .map(t => TYPE_QUERIES[t] || '')
    .join('\n')
    .replace(/\{\{bbox\}\}/g, bbox);

  return `
    [out:json][timeout:25];
    (
      ${typeQueries}
    );
    out center;
  `;
}

function hashRequest(req: OverpassRequest): string {
  const normalized = JSON.stringify({
    bounds: {
      south: Math.round(req.bounds.south * 100) / 100,
      north: Math.round(req.bounds.north * 100) / 100,
      west: Math.round(req.bounds.west * 100) / 100,
      east: Math.round(req.bounds.east * 100) / 100,
    },
    types: [...req.types].sort(),
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const key = `ratelimit:${ip}`;

  // Use atomic increment to avoid race conditions
  // INCR creates the key with value 1 if it doesn't exist
  const count = await kv.incr(key);

  // Set expiry only on first request (when count is 1)
  // This is still a race but harmless - worst case we reset the window slightly
  if (count === 1) {
    await kv.expire(key, 60);
  }

  if (count > RATE_LIMIT) {
    const ttl = await kv.ttl(key);
    return { allowed: false, remaining: 0, resetIn: ttl > 0 ? ttl : 60 };
  }

  return { allowed: true, remaining: RATE_LIMIT - count, resetIn: 60 };
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
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
    // Rate limiting
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    const rateLimit = await checkRateLimit(ip);

    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({
        error: 'Rate limit exceeded',
        resetIn: rateLimit.resetIn,
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateLimit.resetIn.toString(),
        },
      });
    }

    // Parse request
    const body: OverpassRequest = await req.json();

    // Validate bounds
    if (!body.bounds || !body.types?.length) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Limit bounding box size (prevent abuse and Overpass timeouts)
    // Client should use splitBounds() for larger areas - see api-client.ts
    const latSpan = body.bounds.north - body.bounds.south;
    const lonSpan = body.bounds.east - body.bounds.west;
    const MAX_DEGREES = 1.5; // Aligned with client-side splitBounds()
    if (latSpan > MAX_DEGREES || lonSpan > MAX_DEGREES) {
      return new Response(JSON.stringify({
        error: `Bounding box too large. Maximum ${MAX_DEGREES} degrees per side. Use chunked requests for larger areas.`,
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check cache
    const cacheKey = `overpass:${hashRequest(body)}`;
    const cached = await kv.get<string>(cacheKey);

    if (cached) {
      return new Response(cached, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
          'X-RateLimit-Remaining': rateLimit.remaining.toString(),
        },
      });
    }

    // Build and execute query
    const query = buildOverpassQuery(body.bounds, body.types);
    const overpassResponse = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(20000), // 20 second timeout (Overpass can be slow)
    });

    if (!overpassResponse.ok) {
      const errorText = await overpassResponse.text();
      logError('overpass:api', errorText, { status: overpassResponse.status });
      return new Response(JSON.stringify({
        error: 'Overpass API error',
        status: overpassResponse.status,
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await overpassResponse.text();

    // Cache response
    await kv.set(cacheKey, data, { ex: CACHE_TTL });

    return new Response(data, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Cache': 'MISS',
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
      },
    });

  } catch (error) {
    logError('overpass:handler', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
