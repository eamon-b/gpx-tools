# GPX Tools

A web application for trail planning and GPX file processing. Features both client-side tools and serverless API endpoints for route enrichment with POI data and elevation information.

## Features

### GPX Splitter (`/tools/splitter`)
- Split large GPX files into bike-computer-sized chunks (default: 5000 points)
- Preserves waypoints that are near each track segment
- Configurable max points per file and waypoint inclusion distance

### Travel Plan Processor (`/tools/planner`)
- Parse Caltopo CSV travel plan exports
- Calculate cumulative distance, ascent, and descent
- Automatically identify resupply points based on keywords
- Generate processed travel plan and resupply summary CSVs

### POI Enrichment (`/tools/enrich`)
- Enrich GPX routes with Points of Interest from OpenStreetMap
- Find water sources, camping, resupply points, transport, and emergency services
- Filter POIs by distance from route
- Export enriched data as CSV or GPX waypoints

### Route Comparison (`/tools/compare`)
- Compare two GPX routes to identify shared and divergent segments
- Calculate distance, ascent, and descent differences
- Identify divergence and convergence points
- Export comparison summary as CSV

### Daylight Calculator (`/tools/daylight`)
- Calculate sunrise, sunset, and daylight hours along a route
- Plan multi-day hikes with daylight-aware scheduling
- Moon phase and illumination data
- Export daylight plans as CSV

### Trail Website (`/trails`)
- Pre-built trail pages with processed track data
- Waypoint and climate information
- Build-time data processing for fast page loads

## Development

```bash
# Install dependencies
npm install

# Start dev server (static site only)
npm run dev

# Build for production (includes trail data processing)
npm run build

# Preview production build
npm run preview

# Run with serverless functions (requires Vercel CLI)
vercel dev
```

## Testing

### Automated Tests

The project uses [Vitest](https://vitest.dev/) with jsdom for testing. Tests cover the core library modules.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with UI
npm test -- --ui

# Run a specific test file
npm test -- src/lib/distance.test.ts
```

### Test Files

| File | Coverage |
|------|----------|
| `distance.test.ts` | Haversine distance calculations, waypoint filtering |
| `gpx-parser.test.ts` | GPX XML parsing and generation |
| `csv-processor.test.ts` | CSV parsing, unit conversion, resupply detection |
| `gpx-splitter.test.ts` | Track splitting, waypoint association |
| `sample-test-gpx.test.ts` | Integration test with real sample GPX file |

### Sample Data

The `samples/` directory can contain test data files:

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

The application includes serverless API endpoints for POI and elevation data:

| Endpoint | Description |
|----------|-------------|
| `POST /api/overpass` | Query OpenStreetMap for POIs within a bounding box |
| `POST /api/elevation` | Get elevation data for a list of coordinates |
| `GET /api/health` | Health check for all external services |

Features:
- Rate limiting (configurable, default: 10 requests/minute)
- Response caching via Vercel KV
- Circuit breaker for external API failures
- Automatic retry with exponential backoff (client-side)

## Deployment

### Vercel (Recommended)

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
2. **Set up Vercel KV**: Dashboard → Storage → Create → KV → Connect to project
3. **Add environment variables**:
   ```bash
   vercel env add ALLOWED_ORIGINS          # Required: comma-separated allowed origins
   vercel env add RATE_LIMIT_PER_MINUTE    # Optional, default: 10
   vercel env add CACHE_TTL_SECONDS        # Optional, default: 604800 (7 days)
   ```

   > **Security Note:** Always configure `ALLOWED_ORIGINS` in production (e.g., `https://yourdomain.com,https://www.yourdomain.com`). Without this, cross-origin API requests will be denied.
4. **Enable auto-deploy**: Dashboard → Settings → Git → Connect repository

#### Verify Deployment

```bash
curl https://your-url/api/health
# Expected: {"status":"healthy","checks":{"kv":true,"overpass":true,"elevation":true}}
```

### GitHub Pages (Static Only)

Deploys automatically when you push to `main`. API endpoints won't work.

1. Go to repo Settings → Pages → Source: **GitHub Actions**
2. Push to `main` branch
3. Site available at `https://username.github.io/gpx-infra/`

See [INFRASTRUCTURE_SETUP.md](INFRASTRUCTURE_SETUP.md) for detailed architecture documentation.

## Project Structure

```
gpx-infra/
├── src/
│   ├── lib/                    # Core processing library
│   │   ├── types.ts            # Shared type definitions
│   │   ├── gpx-parser.ts       # GPX XML parsing/generation
│   │   ├── gpx-splitter.ts     # Track splitting logic
│   │   ├── csv-processor.ts    # Travel plan CSV processing
│   │   ├── distance.ts         # Haversine distance calculations
│   │   ├── gpx-datasheet.ts    # GPX to datasheet conversion
│   │   ├── api-client.ts       # API client with retry logic
│   │   ├── poi-enrichment.ts   # POI query and enrichment
│   │   ├── daylight.ts         # SunCalc wrapper for daylight
│   │   ├── route-comparison.ts # Route diff and merge
│   │   └── *.test.ts           # Unit tests
│   │
│   ├── web/                    # Static site
│   │   ├── index.html          # Landing page
│   │   ├── styles.css
│   │   ├── tools/              # Tool pages
│   │   │   ├── index.html      # Tools hub
│   │   │   ├── splitter.html   # GPX Splitter
│   │   │   ├── planner.html    # Travel Plan Processor
│   │   │   ├── enrich.html     # POI Enrichment
│   │   │   ├── compare.html    # Route Comparison
│   │   │   └── daylight.html   # Daylight Calculator
│   │   └── trails/             # Trail website
│   │       ├── index.html      # Trail listing
│   │       └── trail-template.html
│   │
│   └── api/                    # Serverless functions (Vercel)
│       ├── overpass.ts         # OSM POI queries
│       ├── elevation.ts        # Elevation data
│       └── health.ts           # Health check endpoint
│
├── data/                       # Trail data
│   ├── trails/                 # Source trail data
│   │   └── <trail-id>/
│   │       ├── trail.json      # Trail metadata
│   │       ├── track.gpx       # GPX track
│   │       └── waypoints.csv   # POI data
│   └── generated/              # Build output
│
├── scripts/                    # Build scripts
│   ├── build-trails.ts         # Process trail data
│   ├── fetch-elevation.ts      # Fill missing elevation
│   └── fetch-pois.ts           # Pre-fetch POIs
│
├── .github/workflows/          # CI/CD
├── vercel.json                 # Vercel configuration
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

## License

MIT
