# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start Vite dev server (static site only, port 5173)
npm run build        # Full production build (trails + TS compile + Vite)
npm test             # Run all tests with Vitest
npm test -- --watch  # Watch mode
npm test -- src/lib/distance.test.ts  # Run specific test file
npm run lint         # Run ESLint
vercel dev           # Run with serverless functions (requires Vercel CLI)
```

## Architecture Overview

**GPX Tools** is a TypeScript web application for GPS/trail data processing with three entry points:

1. **Web UI** (`src/web/`) - Vanilla TypeScript client-side tools built with Vite
2. **Serverless API** (`src/api/`) - Vercel functions for POI queries and elevation data
3. **Build Scripts** (`scripts/`) - Trail data processing run at build time with tsx

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

### Web Tools (`src/web/tools/`)

Each tool is a self-contained HTML + TypeScript pair. Tools process files client-side (no upload) and export results as ZIP using jszip/file-saver.

### Serverless API (`src/api/`)

- `overpass.ts` - OpenStreetMap POI proxy with rate limiting and caching
- `elevation.ts` - Elevation data enrichment
- `health.ts` - Service health check
- `_cors.ts`, `_logger.ts` - Shared utilities

API features: CORS (configured via `ALLOWED_ORIGINS` env), rate limiting (default 10 req/min), Vercel KV caching.

### Path Alias

`@lib` maps to `src/lib/` (configured in vite.config.ts and tsconfig.json).

## Key Patterns

- **Library-first**: Core logic in `src/lib/`, web and API consume it
- **Type-driven**: Shared interfaces in `types.ts`
- **Client-side processing**: Files processed in browser, only API calls for external data
- **Build-time trail data**: `scripts/build-trails.ts` generates static trail pages

## Testing

Tests use Vitest with jsdom. Test files are colocated with source (`*.test.ts` in `src/lib/`).
