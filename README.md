# GPX Tools

A client-side web application for splitting GPX files and processing Caltopo travel plan CSVs. All processing happens locally in your browser - your files are never uploaded anywhere.

## Features

### GPX Splitter
- Split large GPX files into bike-computer-sized chunks (default: 5000 points)
- Preserves waypoints that are near each track segment
- Configurable max points per file and waypoint inclusion distance

### Travel Plan Processor
- Parse Caltopo CSV travel plan exports
- Calculate cumulative distance, ascent, and descent
- Automatically identify resupply points based on keywords
- Generate processed travel plan and resupply summary CSVs

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
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

## Deployment

The app automatically deploys to GitHub Pages when you push to the `main` branch. You can also manually trigger deployment from the Actions tab.

## Project Structure

```
gpx-tools/
├── src/
│   ├── lib/                    # Core processing library
│   │   ├── types.ts
│   │   ├── gpx-parser.ts
│   │   ├── distance.ts
│   │   ├── gpx-splitter.ts
│   │   ├── csv-processor.ts
│   │   ├── index.ts
│   │   ├── *.test.ts           # Unit tests
│   │   └── sample-test-gpx.test.ts  # Integration test
│   └── web/                    # Web application
│       ├── index.html
│       ├── app.ts
│       └── styles.css
├── samples/                    # Test data (add your own GPX/CSV files)
├── .github/
│   └── workflows/
│       └── deploy.yml
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts            # Test configuration
```

## License

MIT
