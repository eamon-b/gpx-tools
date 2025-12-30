import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import { JSDOM } from 'jsdom';
import { haversineDistance as haversineDistanceMeters } from '../src/lib/distance.js';

/** Calculate haversine distance in km */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
}

interface TrailConfig {
  id: string;
  name: string;
  shortName: string;
  region: string;
  lengthKm: number;
  difficulty: string;
  bestMonths: number[];
  gpxFile: string;
  waypointsFile: string;
  climateFile?: string;
}

interface GpxPoint {
  lat: number;
  lon: number;
  ele: number;
  time: string | null;
}

interface ProcessedTrail {
  config: TrailConfig;
  track: {
    points: { lat: number; lon: number; ele: number; dist: number }[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints: Record<string, unknown>[];
  climate: Record<string, unknown> | null;
}

// Handle both Windows and Unix paths from import.meta.url
const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data/trails');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data/generated');
const TRAIL_PAGES_DIR = path.join(PROJECT_ROOT, 'src/web/trails');
const TRAIL_TEMPLATE_PATH = path.join(TRAIL_PAGES_DIR, 'trail-template.html');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse GPX XML content using jsdom (for Node.js environment)
 */
function parseGpxNode(xml: string): { points: GpxPoint[] } {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  // Try to get points from tracks first
  let points: GpxPoint[] = [];

  const trackPoints = doc.querySelectorAll('trk trkseg trkpt');
  if (trackPoints.length > 0) {
    points = Array.from(trackPoints).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
      ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
      time: pt.querySelector('time')?.textContent || null,
    }));
  }

  // If no track points, try route points
  if (points.length === 0) {
    const routePoints = doc.querySelectorAll('rte rtept');
    points = Array.from(routePoints).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
      ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
      time: pt.querySelector('time')?.textContent || null,
    }));
  }

  return { points };
}


function validateDataDirectory(): void {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`Note: Data directory does not exist: ${DATA_DIR}`);
    console.log('Creating directory structure...');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('');
    console.log('To add trail data, create directories like:');
    console.log('  data/trails/');
    console.log('    └── trail-id/');
    console.log('        ├── trail.json');
    console.log('        ├── track.gpx');
    console.log('        └── waypoints.csv');
    console.log('');
  }

  const entries = fs.readdirSync(DATA_DIR);
  const trailDirs = entries.filter(name => {
    const fullPath = path.join(DATA_DIR, name);
    return fs.statSync(fullPath).isDirectory();
  });

  if (trailDirs.length === 0) {
    console.log('Note: No trail directories found in', DATA_DIR);
    console.log('The build will complete but no trail data will be generated.');
    console.log('');
  }
}

function validateTrailDirectory(trailDir: string): string[] {
  const errors: string[] = [];
  const trailId = path.basename(trailDir);

  const configPath = path.join(trailDir, 'trail.json');
  if (!fs.existsSync(configPath)) {
    errors.push(`${trailId}: Missing trail.json`);
    return errors; // Can't validate further without config
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (!config.gpxFile) {
      errors.push(`${trailId}: trail.json missing gpxFile field`);
    } else if (!fs.existsSync(path.join(trailDir, config.gpxFile))) {
      errors.push(`${trailId}: GPX file not found: ${config.gpxFile}`);
    }

    if (!config.waypointsFile) {
      errors.push(`${trailId}: trail.json missing waypointsFile field`);
    } else if (!fs.existsSync(path.join(trailDir, config.waypointsFile))) {
      errors.push(`${trailId}: Waypoints file not found: ${config.waypointsFile}`);
    }

    if (!config.id || !config.name) {
      errors.push(`${trailId}: trail.json missing required id or name field`);
    }
  } catch (e) {
    errors.push(`${trailId}: Invalid trail.json - ${e instanceof Error ? e.message : 'parse error'}`);
  }

  return errors;
}

async function processTrail(trailDir: string): Promise<ProcessedTrail> {
  const configPath = path.join(trailDir, 'trail.json');
  const config: TrailConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Parse GPX
  const gpxPath = path.join(trailDir, config.gpxFile);
  const gpxContent = fs.readFileSync(gpxPath, 'utf-8');
  const gpxData = parseGpxNode(gpxContent);

  // Calculate cumulative distance and elevation
  let totalDistance = 0;
  let totalAscent = 0;
  let totalDescent = 0;

  const points = gpxData.points.map((p, i, arr) => {
    if (i > 0) {
      const prev = arr[i - 1];
      const dist = haversineDistanceKm(prev.lat, prev.lon, p.lat, p.lon);
      totalDistance += dist;

      const elevDiff = (p.ele || 0) - (prev.ele || 0);
      if (elevDiff > 0) totalAscent += elevDiff;
      else totalDescent += Math.abs(elevDiff);
    }
    return {
      lat: p.lat,
      lon: p.lon,
      ele: p.ele || 0,
      dist: totalDistance,
    };
  });

  // Parse waypoints
  const waypointsPath = path.join(trailDir, config.waypointsFile);
  const waypointsContent = fs.readFileSync(waypointsPath, 'utf-8');
  const waypointsResult = Papa.parse(waypointsContent, { header: true });
  const waypoints = waypointsResult.data as Record<string, unknown>[];

  // Parse climate if exists
  let climate: Record<string, unknown> | null = null;
  if (config.climateFile) {
    const climatePath = path.join(trailDir, config.climateFile);
    if (fs.existsSync(climatePath)) {
      climate = JSON.parse(fs.readFileSync(climatePath, 'utf-8'));
    }
  }

  return {
    config,
    track: {
      points,
      totalDistance,
      totalAscent,
      totalDescent,
    },
    waypoints,
    climate,
  };
}

/**
 * Generate an HTML page for a trail from the template
 */
function generateTrailPage(trail: ProcessedTrail): void {
  if (!fs.existsSync(TRAIL_TEMPLATE_PATH)) {
    console.log('  Note: Trail template not found, skipping HTML generation');
    return;
  }

  const template = fs.readFileSync(TRAIL_TEMPLATE_PATH, 'utf-8');

  // Format best months
  const bestMonths = (trail.config.bestMonths || [])
    .map(m => MONTH_NAMES[m - 1] || '')
    .filter(Boolean)
    .join(', ') || 'Year-round';

  // Replace placeholders
  const html = template
    .replace(/\{\{TRAIL_ID\}\}/g, trail.config.id)
    .replace(/\{\{TRAIL_NAME\}\}/g, trail.config.name)
    .replace(/\{\{TRAIL_SHORT_NAME\}\}/g, trail.config.shortName || trail.config.name)
    .replace(/\{\{TRAIL_REGION\}\}/g, trail.config.region || 'Unknown')
    .replace(/\{\{TRAIL_DIFFICULTY\}\}/g, trail.config.difficulty || 'Unknown')
    .replace(/\{\{TRAIL_BEST_MONTHS\}\}/g, bestMonths);

  // Create trail directory and write HTML
  const trailPageDir = path.join(TRAIL_PAGES_DIR, trail.config.id);
  if (!fs.existsSync(trailPageDir)) {
    fs.mkdirSync(trailPageDir, { recursive: true });
  }

  const htmlPath = path.join(trailPageDir, 'index.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`  ✓ Generated ${htmlPath}`);
}

async function main() {
  console.log('Trail Build Script');
  console.log('==================\n');

  // Validate data directory exists and has content
  validateDataDirectory();

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Find all trail directories
  if (!fs.existsSync(DATA_DIR)) {
    console.log('No data directory found. Skipping trail processing.');
    // Write empty index
    const indexPath = path.join(OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify([], null, 2));
    console.log(`Empty trail index written to ${indexPath}`);
    return;
  }

  const trailDirs = fs.readdirSync(DATA_DIR)
    .map(name => path.join(DATA_DIR, name))
    .filter(p => fs.statSync(p).isDirectory());

  if (trailDirs.length === 0) {
    console.log('No trail directories found. Writing empty index.');
    const indexPath = path.join(OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify([], null, 2));
    console.log(`Empty trail index written to ${indexPath}`);
    return;
  }

  // Validate all trails before processing
  console.log(`Found ${trailDirs.length} trail directories\n`);
  console.log('Validating trail data...');

  const allErrors: string[] = [];
  for (const trailDir of trailDirs) {
    const errors = validateTrailDirectory(trailDir);
    allErrors.push(...errors);
  }

  if (allErrors.length > 0) {
    console.error('\nValidation errors found:');
    allErrors.forEach(err => console.error(`  - ${err}`));
    console.error('\nFix these errors before building.');
    process.exit(1);
  }

  console.log('All trails validated successfully.\n');

  const trailIndex: { id: string; name: string; shortName: string; lengthKm: number }[] = [];

  for (const trailDir of trailDirs) {
    const trailId = path.basename(trailDir);
    console.log(`Processing: ${trailId}`);

    try {
      const processed = await processTrail(trailDir);

      // Write processed data
      const outputPath = path.join(OUTPUT_DIR, `${trailId}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(processed, null, 2));
      console.log(`  ✓ Written to ${outputPath}`);

      // Generate HTML page for this trail
      generateTrailPage(processed);

      trailIndex.push({
        id: processed.config.id,
        name: processed.config.name,
        shortName: processed.config.shortName,
        lengthKm: processed.config.lengthKm,
      });
    } catch (error) {
      console.error(`  ✗ Error processing ${trailId}:`, error);
    }
  }

  // Write trail index
  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(trailIndex, null, 2));
  console.log(`\nTrail index written to ${indexPath}`);
}

main().catch(console.error);
