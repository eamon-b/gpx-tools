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
2. **Serverless API** (`src/api/`) - Vercel functions for POI queries and elevation data

### Core Library (`src/lib/`)

All processing logic lives here as reusable modules exported via `index.ts`:
- `gpx-parser.ts` - GPX XML parsing/generation via DOM APIs
- `gpx-splitter.ts` - Split large GPX into chunks
- `gpx-combiner.ts` - Merge multiple GPX files
- `gpx-optimizer.ts` - Simplify, smooth elevation, truncate
- `csv-processor.ts` - Parse Caltopo CSV exports
- `distance.ts` - Haversine distance calculations (3D with elevation)
- `poi-enrichment.ts` - OpenStreetMap POI queries
- `route-comparison.ts` - Compare two routes
- `daylight.ts` - Sunrise/sunset via suncalc
- `gpx-datasheet.ts` - Generate datasheets with waypoint visits, resupply points, distances
- `api-client.ts` - Client-side wrapper for POI/elevation API calls

### Web Tools (`src/web/tools/`)

Each tool is a self-contained HTML + TypeScript pair. Tools process files client-side (no upload) and export results as ZIP using jszip/file-saver.

### Serverless API (`src/api/`)

- `overpass.ts` - OpenStreetMap POI proxy with rate limiting and caching
- `elevation.ts` - Elevation data enrichment
- `health.ts` - Service health check
- `_cors.ts`, `_logger.ts` - Shared utilities

API features: CORS (configured via `ALLOWED_ORIGINS` env), rate limiting (default 10 req/min), Vercel KV caching.

**Note:** Root `api/` contains thin re-export stubs (e.g. `export { default } from '../src/api/overpass'`) required by Vercel's function discovery. Actual logic lives in `src/api/`.

### Path Alias

`@lib` maps to `src/lib/` (configured in vite.config.ts and tsconfig.json).

## Key Patterns

- **Library-first**: Core logic in `src/lib/`, web and API consume it
- **Type-driven**: Shared interfaces in `types.ts`
- **Client-side processing**: Files processed in browser, only API calls for external data

## Environment

Required for `vercel dev` (serverless functions):
- `ALLOWED_ORIGINS` - Comma-separated allowed CORS origins
- Vercel KV env vars (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) - for caching in `overpass.ts`

These are not needed for `npm run dev` (static site only).

## Testing

Tests use Vitest with jsdom. Test files are colocated with source (`*.test.ts` in `src/lib/`).
