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

# Run tests
npm run test
```

## Deployment

The app automatically deploys to GitHub Pages when you push to the `main` branch. You can also manually trigger deployment from the Actions tab.

## Project Structure

```
gpx-tools/
├── src/
│   ├── lib/           # Core processing library
│   │   ├── types.ts
│   │   ├── gpx-parser.ts
│   │   ├── distance.ts
│   │   ├── gpx-splitter.ts
│   │   ├── csv-processor.ts
│   │   └── index.ts
│   └── web/           # Web application
│       ├── index.html
│       ├── app.ts
│       └── styles.css
├── .github/
│   └── workflows/
│       └── deploy.yml
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## License

MIT
