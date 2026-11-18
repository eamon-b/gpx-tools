# GPX Tools

A web application for trail planning and GPX file processing. Features client-side tools and a serverless API endpoint for route enrichment with POI data.

## Features

### GPX Splitter (`/tools/splitter.html`)
- Split large GPX files into bike-computer-sized chunks (default: 5000 points)
- Preserves waypoints that are near each track segment
- Configurable max points per file and waypoint inclusion distance

### Travel Plan Processor (`/tools/planner.html`)
- Parse Caltopo CSV travel plan exports, or build the same datasheet from a GPX file's track and waypoints
- Calculate cumulative distance, ascent, and descent
- Automatically identify resupply points based on keywords
- Generate processed travel plan and resupply summary CSVs

### POI Enrichment (`/tools/enrich.html`)
- Enrich GPX routes with Points of Interest from OpenStreetMap
- Find water sources, camping, resupply shops, restaurants and cafes, transport, and emergency services
- Corridor search: queries a buffer around the route itself (`around:`), not a bounding box, so a long or dog-legged trail does not drag in POIs hundreds of kilometres off-route
- Matches nodes, ways and relations (`nwr`), so features mapped as areas — a supermarket building, a campsite polygon — are found and reduced to their centre point
- Filter POIs by distance from route (exact cross-track distance to the nearest segment)
- Export enriched data as CSV or GPX waypoints

### Route Comparison (`/tools/compare.html`)
- Compare two GPX routes to identify shared and divergent segments
- Calculate distance, ascent, and descent differences
- Identify divergence and convergence points
- Export comparison summary as CSV

### Daylight Calculator (`/tools/daylight.html`)
- Calculate sunrise, sunset, and daylight hours along a route
- Plan multi-day hikes with daylight-aware scheduling
- Moon phase and illumination data
- Export daylight plans as CSV

### GPX Combiner (`/tools/combiner.html`)
- Merge multiple GPX files into a single continuous route
- Drag to reorder files, or auto-order for best geographic continuity
- Remove duplicate waypoints
- Warn about large gaps between combined tracks (configurable threshold)

### GPX Optimizer (`/tools/optimizer.html`)
- Reduce GPX file size while preserving route accuracy
- Simplify tracks with a configurable tolerance (meters)
- Smooth elevation data and remove elevation spikes
- Truncate route start/end for privacy
- Control timestamp preservation and coordinate precision

## Development

```bash
# Install dependencies
npm install

# Start dev server (static site only)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run with serverless functions (requires Vercel CLI)
vercel dev
```

`npm run dev` serves the client-side tools at http://localhost:5173. Tools that call the serverless API (e.g. POI Enrichment) also need `vercel dev` running on port 3000; with both running, the Vite dev server proxies `/api` requests to `vercel dev` automatically.

## Testing

### Automated Tests

The project uses [Vitest](https://vitest.dev/) with jsdom for testing. Tests are colocated with the code they cover: the processing modules in `src/lib/` and the API handlers have a `*.test.ts` next to them.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run a specific test file
npm test -- src/lib/distance.test.ts
```

### Sample Data

`sample-test-gpx.test.ts` and `gpx-sample-comparison.test.ts` are integration tests that run against real files in a `samples/` directory at the repository root. The directory is not checked in, so they are skipped unless you add one:

- GPX files with tracks and waypoints for testing the splitter
- CSV files exported from Caltopo for testing the travel plan processor

### Manual Testing

1. Start the dev server: `npm run dev`
2. Open http://localhost:5173
3. Test GPX Splitter:
   - Upload a GPX file
   - Adjust max points (e.g., 1000) to force splitting
   - Verify waypoints are included in split files
4. Test CSV Processor:
   - Upload a Caltopo CSV export
   - Verify distance/elevation parsing (supports feet/miles and meters/km)
   - Check resupply point detection
   - Test unit conversion options (km/mi, m/ft)

## API Endpoints

The application includes serverless API endpoints for POI data:

| Endpoint | Description |
|----------|-------------|
| `POST /api/overpass` | Query OpenStreetMap for POIs along a route corridor (`{corridor, radiusMeters, types}`, max 400 vertices and 10 km radius) or, as a fallback, within a bounding box (`{bounds, types}`, max 1.5° per side). `types` must be a non-empty subset of `water`, `camping`, `resupply`, `restaurant`, `transport`, `emergency`. Returns the raw Overpass JSON. |
| `GET /api/health` | Health check for Redis and Overpass |

Request bodies for `/api/overpass` (corridor vertices travel as compact `[lat, lon]` pairs):

```jsonc
{ "corridor": [[-37.8136, 144.9631], [-37.9, 145.0]], "radiusMeters": 2000, "types": ["water", "resupply"] }
{ "bounds": { "south": -37.9, "north": -37.8, "west": 144.9, "east": 145.0 }, "types": ["water"] }
```

Features:
- Rate limiting per IP (configurable; default 10 requests/minute). Only requests that reach Overpass count: responses served from the cache are free and carry no `X-RateLimit-Remaining`; a cache miss does
- `/api/health` reuses a probe result for 30 seconds, so polling it does not hammer Redis or Overpass
- Response caching via Redis (Upstash), keyed by the coordinate-rounded request (`X-Cache: HIT` / `MISS` / `BYPASS`)
- Redis is best effort: if it is unreachable the request is still served (cache bypassed, rate limit fails open)
- Transient upstream failures (Overpass 429/504 or a timeout) are returned as `503` with `Retry-After`; other upstream errors as `502`
- Automatic retry with exponential backoff (client-side)

## Deployment

### Vercel

Vercel supports both the static site and serverless API functions.

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy preview
vercel

# Deploy production
vercel --prod
```

#### Setup Steps

1. **Create project**: Run `vercel` and follow prompts
2. **Set up Redis**: Dashboard → Storage → Create → Upstash for Redis → Connect to project (this provisions `KV_REST_API_URL` / `KV_REST_API_TOKEN`; native Upstash `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are also accepted)
3. **Add environment variables**:
   ```bash
   vercel env add ALLOWED_ORIGINS          # Required: comma-separated allowed origins
   vercel env add RATE_LIMIT_PER_MINUTE    # Optional, default: 10 (POI queries per IP)
   vercel env add CACHE_TTL_SECONDS        # Optional, default: 604800 (7 days)
   ```

   > **Security Note:** Always configure `ALLOWED_ORIGINS` in production (e.g., `https://yourdomain.com,https://www.yourdomain.com`). Without this, cross-origin API requests will be denied.
4. **Enable auto-deploy**: Dashboard → Settings → Git → Connect repository

#### Verify Deployment

```bash
curl https://your-url/api/health
# Expected: {"status":"healthy","checks":{"kv":true,"overpass":true}}
```
