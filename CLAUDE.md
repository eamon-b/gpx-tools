# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start Vite dev server (static site only, port 5173)
npm run build        # Production build (TS compile + Vite)
npm test             # Run all tests with Vitest
npm test -- --watch  # Watch mode
npm test -- src/lib/distance.test.ts  # Run specific test file
npm run lint         # Run ESLint
vercel dev           # Run with serverless functions (requires Vercel CLI)
```

## Architecture Overview

**GPX Tools** is a TypeScript web application for GPS route processing with two entry points:

1. **Web UI** (`src/web/`) - Vanilla TypeScript client-side tools built with Vite
2. **Serverless API** (`src/api/`) - Vercel functions for POI queries

### Core Library (`src/lib/`)

All processing logic lives here as reusable modules exported via `index.ts`:
- `gpx-parser.ts` - GPX XML parsing/generation via DOM APIs. `waypointChildElements` is the one place a `GpxWaypoint`'s name/cmt/desc/link/sym/type are serialised; every writer of one (including the optimizer's) goes through it (`exportPOIsToGPX` writes OSM POIs, not `GpxWaypoint`s, and has its own). `generateGpx` flattens everything into one track (what the splitter/optimiser want); `writeGpx` serialises a whole `GpxData` - every track with its segments, every waypoint with the optional `type`/`cmt`/`sym`/`link` - for when track boundaries matter
- `kml-parser.ts` - KML/KMZ reader (`parseKml`, `parseKmz` via jszip) producing placemarks with their folder path, geometry and attributes, plus `kmlToGpxData` to map them onto `GpxData` through a caller-supplied `classify`. Trail authorities often publish a richer KMZ than GPX, so this is the way one enters the pipeline. Parsing walks the DOM by `localName`, not CSS selectors, because KML in the wild is inconsistent about namespace prefixes. `parseDescriptionFields` recovers the attribute table that ArcGIS exports bury in `<description>` as HTML; `<ExtendedData>` wins over it when both are present
- `gpx-splitter.ts` - Split large GPX into chunks
- `gpx-combiner.ts` - Merge multiple GPX files
- `gpx-optimizer.ts` - Simplify, smooth elevation, truncate. Stats are measured per segment (`measureTracks`): the gap between segments or tracks is not distance or climb
- `csv-processor.ts` - Parse Caltopo CSV exports
- `csv-safe.ts` - `csvSafeRows` guards CSV output against spreadsheet formula injection; run every user-derived table through it before `Papa.unparse`
- `distance.ts` - Haversine distance calculations (3D with elevation). `haversineDistance2D` is an alias of `haversineDistance`
- `osm-poi.ts` - POI catalog, Overpass QL builder (`nwr` + `out center`), area validation, corridor chunking, route geometry
- `overpass-client.ts` - Direct Overpass fetcher (retries/throttling) for Node scripts
- `poi-enrichment.ts` - OpenStreetMap POI queries
- `route-comparison.ts` - Compare two routes. A point is "shared" when it is within the threshold of the other route's LINE (point-to-segment, not vertex-to-vertex), looked up through a grid index over the segments (`createPolylineIndex`) - symmetric in both routes, and linear in their size. Longitudes are unwrapped along the route (antimeridian-safe); above 85 degrees of latitude it measures every segment instead of trusting the grid
- `daylight.ts` - Sunrise/sunset via suncalc. Days are always exact 24 h steps from an anchor (never `setDate`, which moves in the machine's time zone); `getDaylightAlongRoute` samples by distance
- `gpx-datasheet.ts` - Generate datasheets with waypoint visits, resupply points, distances
- `api-client.ts` - Client-side wrapper for the POI API (retries, backoff, cancellation)

### Web Tools (`src/web/tools/`)

Each tool is an HTML + TypeScript pair. Tools process files client-side (no upload) and export results as ZIP using jszip/file-saver.

What the tools have in common lives in `src/web/shared/`: `file-utils.ts` (the single-file upload area, `formatFileSize`, `stripExtension`), `prefs.ts` (`savePrefs` - each tool's section of the one `gpx-tools-prefs` localStorage entry; never throws), `html-utils.ts` (`escapeHtml` - use it for anything file-derived that goes through `innerHTML`), `error-banner.ts` (`setupErrorBanner` - the one inline, dismissible error every tool shows in its `#error-banner`; never `alert()`) and `map-utils.ts` (Leaflet setup).

### Serverless API (`src/api/`)

- `overpass.ts` - OpenStreetMap POI proxy. Accepts a corridor (`{corridor, radiusMeters, types}`, where `corridor` is one polyline `[[lat,lon],...]` or several `[[[lat,lon],...],...]`, 400 vertices total) or bbox (`{bounds, types}`) body, validates it with `validateOverpassArea`/`parseOverpassArea` and builds the query with `buildOverpassQuery` from `src/lib/osm-poi.ts` - it owns no tag rules of its own. Coordinates are canonicalised with `roundCoord` so the sha256 cache key and the query text agree.
- `health.ts` - Service health check (GET/HEAD). A probe result is reused for 30 s per instance and concurrent requests share one probe; fresh probes are rate limited per IP
- `_cors.ts`, `_logger.ts`, `_env.ts` - Shared utilities. Read numeric settings with `envPositiveInt`, never bare `parseInt(process.env.X)`: NaN silently disables a limit

API features: CORS (configured via `ALLOWED_ORIGINS` env), per-IP rate limiting shared in `_ratelimit.ts` (overpass 10 req/min via `RATE_LIMIT_PER_MINUTE`; fails open, and is charged only for upstream work - a response served from the cache does not count), Redis caching via `@upstash/redis` (shared client in `_redis.ts`).

`POI_CATALOG` in `src/lib/osm-poi.ts` is the single source of truth for the OSM tag rules: the same rules generate the server's Overpass selectors and the client's `categorizePOI` predicate, so add or change a POI tag there and nowhere else.

Corridor queries carry a global `[bbox:]` setting padded by the radius (without it Overpass walks the planet-wide tag index per selector and times out on long routes), and `enrichRoute` packs short disjoint polylines (side trips) into one query via `packCorridorChunks`. A 200 from Overpass is validated with `overpassPayloadError` before it is cached or returned: runtime errors (query timed out) arrive as 200 with a `remark`.

Redis is best effort in `overpass.ts`: cache reads/writes and the rate-limit counter are wrapped so an outage logs and falls open (`X-Cache: BYPASS`) instead of failing the request. Timeouts are tied to `vercel.json`'s `maxDuration: 30` - Overpass `[timeout:22]`, HTTP abort at 27 s; an upstream 429/504 or timeout becomes a `503` with `Retry-After`.

**Note:** Root `api/` contains thin re-export stubs (e.g. `export { default } from '../src/api/overpass'`) required by Vercel's function discovery. Actual logic lives in `src/api/`.

### Path Alias

`@lib` maps to `src/lib/` (configured in vite.config.ts and tsconfig.json).

## Key Patterns

- **Library-first**: Core logic in `src/lib/`, web and API consume it
- **Type-driven**: Shared interfaces in `types.ts`
- **Client-side processing**: Files processed in browser, only API calls for external data
- **Large tracks**: never `push(...points)` or `Math.min(...values)` over track points - spreading
  more than ~125k elements into arguments overflows the call stack. Use `flatMap`/`concat` or a loop.
- **Formatting**: `.prettierrc` records the house style - single quotes, 100 columns,
  `es5` trailing commas, no parens on single-argument arrows. The tree predates it and is
  not uniformly formatted, so format the code you touch rather than whole files: a blanket
  `prettier --write` would bury the change in reformatting.

## Environment

Required for `vercel dev` (serverless functions):
- `ALLOWED_ORIGINS` - Comma-separated allowed CORS origins
- Redis (Upstash) env vars - `KV_REST_API_URL` / `KV_REST_API_TOKEN` (from Vercel's Redis integration) or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` - for caching in `overpass.ts` and the check in `health.ts`

These are not needed for `npm run dev` (static site only).

## Testing

Tests use Vitest with jsdom. Test files are colocated with source (`*.test.ts` in `src/lib/` and `src/api/`). API handler tests opt out of jsdom with `// @vitest-environment node` (the handlers are plain `Request` -> `Response` functions) and mock `./_redis` with `vi.mock`.
