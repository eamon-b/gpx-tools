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
  waypointsFile?: string;  // Now optional - can extract from GPX
  climateFile?: string;
  description?: string;
}

interface GpxPoint {
  lat: number;
  lon: number;
  ele: number;
  time: string | null;
}

interface Waypoint {
  name: string;
  lat: number;
  lon: number;
  type: string;
  description?: string;
}

interface EnrichedWaypoint extends Waypoint {
  elevation: number;
  distance: number;        // segment distance from previous waypoint (km)
  totalDistance: number;   // cumulative distance along route (km)
  ascent: number;          // segment ascent from previous waypoint (m)
  descent: number;         // segment descent from previous waypoint (m)
  totalAscent: number;     // cumulative ascent (m)
  totalDescent: number;    // cumulative descent (m)
  trackIndex: number;      // index in track points array
}

interface WaypointVisit {
  waypoint: Waypoint;
  trackIndex: number;
  distanceFromTrack: number;
}

interface RouteVariant {
  name: string;
  type: 'alternate' | 'side-trip';
  points: { lat: number; lon: number; ele: number }[];
  distance: number;
  elevation: { ascent: number; descent: number };
  // Junction point data - where variant connects to main route
  startDistance?: number;     // km along main route where it branches
  startTrackIndex?: number;   // index in track points array
  endDistance?: number;       // km where alternate rejoins (alternates only)
  endTrackIndex?: number;     // track index where it rejoins
}

interface ProcessedTrail {
  config: TrailConfig;
  track: {
    points: { lat: number; lon: number; ele: number; dist: number }[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints: EnrichedWaypoint[];
  alternates: RouteVariant[];
  sideTrips: RouteVariant[];
  climate: Record<string, unknown> | null;
}

interface CaltopoData {
  waypointCategories: Map<string, string>;
  waypointDescriptions: Map<string, string>;
  alternates: RouteVariant[];
  sideTrips: RouteVariant[];
}

/** Waypoint type inference from name prefixes (CalTopo convention) */
const WAYPOINT_PREFIX_MAP: Record<string, string> = {
  'C ': 'campsite',
  'W ': 'water',
  'H ': 'hut',
  'WT:': 'water-tank',
  'WT ': 'water-tank',
  'ST:': 'side-trip',
  'ST ': 'side-trip',
  'M ': 'mountain',
};

/** Known town/resupply names (add more as needed) */
const KNOWN_TOWNS = new Set([
  'mt hotham', 'adaminaby', 'falls creek', 'omeo', 'thredbo',
  'glengarry', 'rawson', 'walhalla', 'jindabyne', 'khancoban',
]);

function inferWaypointType(name: string): string {
  const nameLower = name.toLowerCase();

  // Check for known towns
  if (KNOWN_TOWNS.has(nameLower)) {
    return 'town';
  }

  // Check for prefix patterns
  for (const [prefix, type] of Object.entries(WAYPOINT_PREFIX_MAP)) {
    if (name.startsWith(prefix)) {
      return type;
    }
  }

  // Infer from name content
  if (nameLower.includes('hut') || nameLower.includes('shelter')) return 'hut';
  if (nameLower.includes('camp')) return 'campsite';
  if (nameLower.includes('water') || nameLower.includes('creek') || nameLower.includes('river') || nameLower.includes('spring')) return 'water';
  if (nameLower.includes('tank')) return 'water-tank';
  if (nameLower.includes('mt ') || nameLower.includes('mount') || nameLower.includes('peak')) return 'mountain';

  return 'waypoint';
}

function cleanWaypointName(name: string): string {
  // Remove type prefixes from display name
  for (const prefix of Object.keys(WAYPOINT_PREFIX_MAP)) {
    if (name.startsWith(prefix)) {
      return name.slice(prefix.length).trim();
    }
  }
  return name;
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
 * Extracts both track points and waypoints
 */
function parseGpxNode(xml: string): { points: GpxPoint[]; waypoints: Waypoint[]; name: string | null; trackInfo: { name: string; pointCount: number }[] } {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  // Extract GPX name from metadata
  const gpxName = doc.querySelector('metadata name')?.textContent || null;

  // Get all tracks and their info
  const tracks = doc.querySelectorAll('trk');
  const trackInfo: { name: string; pointCount: number; points: GpxPoint[] }[] = [];

  for (const track of Array.from(tracks) as Element[]) {
    const trackName = track.querySelector('name')?.textContent || 'Unnamed';
    const trackPoints = track.querySelectorAll('trkseg trkpt');
    const points = (Array.from(trackPoints) as Element[]).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
      ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
      time: pt.querySelector('time')?.textContent || null,
    }));
    trackInfo.push({ name: trackName, pointCount: points.length, points });
  }

  // Find the main track - look for "main" in name, or use the longest track
  let mainTrackIndex = trackInfo.findIndex(t =>
    t.name.toLowerCase().includes('main') &&
    !t.name.toLowerCase().includes('side') &&
    !t.name.toLowerCase().includes('alt')
  );

  // If no "main" track found, use the track with the most points
  if (mainTrackIndex === -1 && trackInfo.length > 0) {
    mainTrackIndex = trackInfo.reduce((maxIdx, track, idx, arr) =>
      track.pointCount > arr[maxIdx].pointCount ? idx : maxIdx, 0);
  }

  let points: GpxPoint[] = [];
  if (mainTrackIndex >= 0) {
    points = trackInfo[mainTrackIndex].points;
    console.log(`  Using track "${trackInfo[mainTrackIndex].name}" (${points.length} points)`);
    if (trackInfo.length > 1) {
      console.log(`  (${trackInfo.length - 1} other tracks: alternates/side trips)`);
    }
  }

  // If no track points, try route points
  if (points.length === 0) {
    const routePoints = doc.querySelectorAll('rte rtept');
    points = (Array.from(routePoints) as Element[]).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
      ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
      time: pt.querySelector('time')?.textContent || null,
    }));
  }

  // Extract waypoints from <wpt> elements
  const wptElements = doc.querySelectorAll('wpt');
  const waypoints: Waypoint[] = (Array.from(wptElements) as Element[]).map(wpt => {
    const name = wpt.querySelector('name')?.textContent || 'Unnamed';
    const inferredType = inferWaypointType(name);
    return {
      name: cleanWaypointName(name),
      lat: parseFloat(wpt.getAttribute('lat') || '0'),
      lon: parseFloat(wpt.getAttribute('lon') || '0'),
      type: inferredType,
      description: wpt.querySelector('desc')?.textContent || undefined,
    };
  });

  return {
    points,
    waypoints,
    name: gpxName,
    trackInfo: trackInfo.map(t => ({ name: t.name, pointCount: t.pointCount }))
  };
}

/**
 * Calculate distance and elevation for a set of points
 */
function calculateRouteStats(points: { lat: number; lon: number; ele: number }[]): { distance: number; ascent: number; descent: number } {
  let distance = 0;
  let ascent = 0;
  let descent = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    distance += haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);

    const elevDiff = curr.ele - prev.ele;
    if (elevDiff > 0) ascent += elevDiff;
    else descent += Math.abs(elevDiff);
  }

  return { distance, ascent, descent };
}

/**
 * Find the nearest point on the main track to a given point.
 * Returns the track index and distance from track.
 */
function findNearestTrackPoint(
  point: { lat: number; lon: number },
  trackPoints: { lat: number; lon: number; ele: number; dist?: number }[]
): { trackIndex: number; distanceFromTrack: number } {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < trackPoints.length; i++) {
    const trackPoint = trackPoints[i];
    const distance = haversineDistanceMeters(point.lat, point.lon, trackPoint.lat, trackPoint.lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return { trackIndex: bestIndex, distanceFromTrack: bestDistance };
}

/**
 * Enrich route variants with junction point data.
 * Finds where each variant branches from and rejoins the main track.
 */
function findVariantJunctions(
  variants: RouteVariant[],
  trackPoints: { lat: number; lon: number; ele: number; dist: number }[],
  maxJunctionDistance: number = 500 // meters - variants should start/end within this distance of track
): RouteVariant[] {
  return variants.map(variant => {
    if (variant.points.length === 0) {
      return variant;
    }

    // Find where variant starts (branches from main track)
    const startPoint = variant.points[0];
    const startJunction = findNearestTrackPoint(startPoint, trackPoints);

    // Find where variant ends (rejoins main track for alternates)
    const endPoint = variant.points[variant.points.length - 1];
    const endJunction = findNearestTrackPoint(endPoint, trackPoints);

    // Only set junction data if within reasonable distance of track
    const enriched: RouteVariant = { ...variant };

    if (startJunction.distanceFromTrack <= maxJunctionDistance) {
      enriched.startTrackIndex = startJunction.trackIndex;
      enriched.startDistance = Math.round(trackPoints[startJunction.trackIndex].dist * 100) / 100;
    }

    // For alternates, also record where they rejoin
    // For side trips, only record end if it's a different point (loop back)
    if (endJunction.distanceFromTrack <= maxJunctionDistance) {
      const isSameAsStart = Math.abs(endJunction.trackIndex - startJunction.trackIndex) < 10;

      if (variant.type === 'alternate' || !isSameAsStart) {
        enriched.endTrackIndex = endJunction.trackIndex;
        enriched.endDistance = Math.round(trackPoints[endJunction.trackIndex].dist * 100) / 100;
      }
    }

    return enriched;
  });
}

/**
 * Find all waypoint visits along the route.
 * Walks through track points and records a "visit" when the route passes near a waypoint.
 *
 * Uses hysteresis to prevent "flickering" - the exit threshold is larger than
 * the entry threshold, so the track must move significantly away before a new
 * visit can be recorded for the same waypoint.
 */
function findWaypointVisits(
  waypoints: Waypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[],
  maxDistanceMeters: number = 200
): WaypointVisit[] {
  if (trackPoints.length === 0 || waypoints.length === 0) {
    return [];
  }

  const visits: WaypointVisit[] = [];

  // Hysteresis: exit threshold is 200% larger (3x) than entry threshold
  // This prevents flickering when the track oscillates around the threshold boundary
  // E.g., with 200m entry threshold, must exit past 600m before a new visit can start
  const exitThreshold = maxDistanceMeters * 3.0;

  const activeProximity: Map<number, { bestDistance: number; bestTrackIndex: number }> = new Map();

  for (let trackIdx = 0; trackIdx < trackPoints.length; trackIdx++) {
    const trackPoint = trackPoints[trackIdx];

    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
      const waypoint = waypoints[wpIdx];
      const distance = haversineDistanceMeters(waypoint.lat, waypoint.lon, trackPoint.lat, trackPoint.lon);

      const existing = activeProximity.get(wpIdx);

      if (existing) {
        // Already tracking this waypoint
        if (distance < existing.bestDistance) {
          // Update if this is closer
          existing.bestDistance = distance;
          existing.bestTrackIndex = trackIdx;
        }
        // Use exit threshold (with hysteresis) to determine when to record visit
        if (distance > exitThreshold) {
          // Exited the hysteresis zone - record the visit at the best point
          visits.push({
            waypoint: waypoints[wpIdx],
            trackIndex: existing.bestTrackIndex,
            distanceFromTrack: existing.bestDistance,
          });
          activeProximity.delete(wpIdx);
        }
      } else if (distance <= maxDistanceMeters) {
        // Not tracking yet and within entry threshold - start tracking
        activeProximity.set(wpIdx, { bestDistance: distance, bestTrackIndex: trackIdx });
      }
    }
  }

  // Handle waypoints still inside at end of track
  for (const [wpIdx, data] of activeProximity.entries()) {
    visits.push({
      waypoint: waypoints[wpIdx],
      trackIndex: data.bestTrackIndex,
      distanceFromTrack: data.bestDistance,
    });
  }

  visits.sort((a, b) => a.trackIndex - b.trackIndex);
  return visits;
}

/**
 * Calculate segment statistics between two track indices
 */
function calculateSegmentStats(
  points: { lat: number; lon: number; ele: number }[],
  fromIndex: number,
  toIndex: number
): { distance: number; ascent: number; descent: number } {
  let distance = 0;
  let ascent = 0;
  let descent = 0;

  for (let i = fromIndex; i < toIndex && i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    distance += haversineDistanceKm(p1.lat, p1.lon, p2.lat, p2.lon);

    const elevDiff = p2.ele - p1.ele;
    if (elevDiff > 0) ascent += elevDiff;
    else descent += Math.abs(elevDiff);
  }

  return { distance, ascent, descent };
}

/**
 * Enrich waypoints with distance and elevation data by matching to track
 */
function enrichWaypoints(
  waypoints: Waypoint[],
  trackPoints: { lat: number; lon: number; ele: number }[]
): EnrichedWaypoint[] {
  if (trackPoints.length === 0 || waypoints.length === 0) {
    return [];
  }

  const visits = findWaypointVisits(waypoints, trackPoints);

  if (visits.length === 0) {
    return [];
  }

  const enriched: EnrichedWaypoint[] = [];
  let prevTrackIndex = 0;
  let runningDistance = 0;
  let runningAscent = 0;
  let runningDescent = 0;

  for (const visit of visits) {
    const segmentStats = calculateSegmentStats(trackPoints, prevTrackIndex, visit.trackIndex);

    runningDistance += segmentStats.distance;
    runningAscent += segmentStats.ascent;
    runningDescent += segmentStats.descent;

    const trackPoint = trackPoints[visit.trackIndex];

    enriched.push({
      ...visit.waypoint,
      elevation: Math.round(trackPoint.ele),
      distance: Math.round(segmentStats.distance * 100) / 100,
      totalDistance: Math.round(runningDistance * 100) / 100,
      ascent: Math.round(segmentStats.ascent),
      descent: Math.round(segmentStats.descent),
      totalAscent: Math.round(runningAscent),
      totalDescent: Math.round(runningDescent),
      trackIndex: visit.trackIndex,
    });

    prevTrackIndex = visit.trackIndex;
  }

  return enriched;
}

/**
 * Parse CalTopo GeoJSON for waypoint categorization, descriptions, and route variants
 */
function parseCaltopoGeojson(jsonPath: string): CaltopoData {
  const result: CaltopoData = {
    waypointCategories: new Map<string, string>(),
    waypointDescriptions: new Map<string, string>(),
    alternates: [],
    sideTrips: [],
  };

  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const geojson = JSON.parse(content);

    // Build folder ID -> name map
    const folderNames = new Map<string, string>();
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Folder') {
        folderNames.set(feature.id, feature.properties.title?.toLowerCase() || '');
      }
    }

    // Process markers (waypoints)
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Marker') {
        const waypointName = feature.properties.title || '';
        const folderId = feature.properties.folderId;
        const folderName = folderId ? folderNames.get(folderId) || '' : '';

        // Categorize by folder
        let category = 'waypoint';
        if (folderName.includes('hut')) category = 'hut';
        else if (folderName.includes('campsite')) category = 'campsite';
        else if (folderName.includes('water tank')) category = 'water-tank';
        else if (folderName.includes('water source')) category = 'water';
        else if (folderName.includes('mountain')) category = 'mountain';
        else if (folderName.includes('side trip')) category = 'side-trip';
        else if (folderName.includes('town')) category = 'town';

        result.waypointCategories.set(waypointName, category);

        // Extract description if available
        if (feature.properties.description) {
          result.waypointDescriptions.set(waypointName, feature.properties.description);
        }
      }
    }

    // Process shapes (lines) for alternates and side trips
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Shape' &&
          feature.geometry?.type === 'LineString' &&
          feature.geometry?.coordinates?.length > 0) {

        const title = feature.properties.title || 'Unnamed';
        const titleLower = title.toLowerCase();
        const folderId = feature.properties.folderId;
        const folderName = folderId ? folderNames.get(folderId) || '' : '';

        // Determine if this is an alternate or side trip
        const isAlternate = titleLower.includes('alt') || folderName.includes('alternate');
        const isSideTrip = titleLower.startsWith('st ') || titleLower.startsWith('st:') ||
                          folderName.includes('side trip');

        if (isAlternate || isSideTrip) {
          // Convert coordinates [lon, lat, ele, ?] to points
          const points = feature.geometry.coordinates.map((coord: number[]) => ({
            lat: coord[1],
            lon: coord[0],
            ele: coord[2] || 0,
          }));

          const stats = calculateRouteStats(points);

          const variant: RouteVariant = {
            name: title,
            type: isAlternate ? 'alternate' : 'side-trip',
            points,
            distance: Math.round(stats.distance * 10) / 10,
            elevation: {
              ascent: Math.round(stats.ascent),
              descent: Math.round(stats.descent),
            },
          };

          if (isAlternate) {
            result.alternates.push(variant);
          } else {
            result.sideTrips.push(variant);
          }
        }
      }
    }
  } catch (e) {
    // GeoJSON parsing failed, fall back to GPX-only
    console.log(`  Warning: Could not parse GeoJSON: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  return result;
}

/**
 * Find the first GPX file in a directory
 */
function findGpxFile(trailDir: string): string | null {
  const files = fs.readdirSync(trailDir);
  const gpxFile = files.find(f => f.toLowerCase().endsWith('.gpx'));
  return gpxFile || null;
}

/**
 * Find a CalTopo GeoJSON file in a directory
 */
function findGeojsonFile(trailDir: string): string | null {
  const files = fs.readdirSync(trailDir);
  const jsonFile = files.find(f => f.toLowerCase().endsWith('.json') && f !== 'trail.json');
  return jsonFile || null;
}

/**
 * Generate trail.json config from GPX file analysis
 */
function generateTrailConfig(trailDir: string, gpxFile: string, gpxData: { points: GpxPoint[]; waypoints: Waypoint[]; name: string | null }): TrailConfig {
  const trailId = path.basename(trailDir).toLowerCase();

  // Calculate total distance
  let totalDistance = 0;
  for (let i = 1; i < gpxData.points.length; i++) {
    const prev = gpxData.points[i - 1];
    const curr = gpxData.points[i];
    totalDistance += haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);
  }

  // Derive name from GPX metadata or directory name
  const gpxName = gpxData.name;
  const dirName = path.basename(trailDir);
  const name = gpxName || dirName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return {
    id: trailId,
    name,
    shortName: dirName.toUpperCase(),
    region: 'Unknown',  // User should fill this in
    lengthKm: Math.round(totalDistance * 10) / 10,
    difficulty: 'unknown',  // User should fill this in
    bestMonths: [],  // User should fill this in
    gpxFile,
    description: `Trail data auto-generated from ${gpxFile}. Edit trail.json to customize.`,
  };
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

function validateTrailDirectory(trailDir: string): { errors: string[]; needsAutoConfig: boolean } {
  const errors: string[] = [];
  const trailId = path.basename(trailDir);
  let needsAutoConfig = false;

  const configPath = path.join(trailDir, 'trail.json');
  if (!fs.existsSync(configPath)) {
    // Check if we can auto-generate config from GPX
    const gpxFile = findGpxFile(trailDir);
    if (gpxFile) {
      needsAutoConfig = true;
      console.log(`  ${trailId}: No trail.json found, will auto-generate from ${gpxFile}`);
    } else {
      errors.push(`${trailId}: Missing trail.json and no GPX file found for auto-generation`);
    }
    return { errors, needsAutoConfig };
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (!config.gpxFile) {
      // Try to find GPX file automatically
      const gpxFile = findGpxFile(trailDir);
      if (!gpxFile) {
        errors.push(`${trailId}: trail.json missing gpxFile and no GPX file found`);
      }
    } else if (!fs.existsSync(path.join(trailDir, config.gpxFile))) {
      errors.push(`${trailId}: GPX file not found: ${config.gpxFile}`);
    }

    // waypointsFile is now optional - waypoints can come from GPX

    if (!config.id || !config.name) {
      errors.push(`${trailId}: trail.json missing required id or name field`);
    }
  } catch (e) {
    errors.push(`${trailId}: Invalid trail.json - ${e instanceof Error ? e.message : 'parse error'}`);
  }

  return { errors, needsAutoConfig };
}

async function processTrail(trailDir: string, autoGenConfig: boolean = false): Promise<ProcessedTrail> {
  const configPath = path.join(trailDir, 'trail.json');

  // Find GPX file
  let gpxFile: string;
  if (autoGenConfig) {
    gpxFile = findGpxFile(trailDir)!;
  } else {
    const existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    gpxFile = existingConfig.gpxFile || findGpxFile(trailDir)!;
  }

  // Parse GPX
  const gpxPath = path.join(trailDir, gpxFile);
  const gpxContent = fs.readFileSync(gpxPath, 'utf-8');
  const gpxData = parseGpxNode(gpxContent);

  // Generate or load config
  let config: TrailConfig;
  if (autoGenConfig) {
    config = generateTrailConfig(trailDir, gpxFile, gpxData);
    // Write generated config for user to customize later
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`  ✓ Generated trail.json`);
  } else {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Fill in gpxFile if missing
    if (!config.gpxFile) {
      config.gpxFile = gpxFile;
    }
  }

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

  // Get waypoints - prefer GPX waypoints, fall back to CSV if specified
  let waypoints: Waypoint[] = gpxData.waypoints;
  let alternates: RouteVariant[] = [];
  let sideTrips: RouteVariant[] = [];

  // If GeoJSON exists, use it to enhance data
  const geojsonFile = findGeojsonFile(trailDir);
  if (geojsonFile) {
    const geojsonPath = path.join(trailDir, geojsonFile);
    const caltopoData = parseCaltopoGeojson(geojsonPath);

    if (caltopoData.waypointCategories.size > 0) {
      console.log(`  ✓ Using ${geojsonFile} for waypoint categorization`);
      // Update waypoint types and descriptions from GeoJSON
      waypoints = waypoints.map(wp => {
        // Look up by original name (with prefix)
        for (const [prefix] of Object.entries(WAYPOINT_PREFIX_MAP)) {
          const originalName = prefix + wp.name;
          if (caltopoData.waypointCategories.has(originalName)) {
            const desc = caltopoData.waypointDescriptions.get(originalName);
            return {
              ...wp,
              type: caltopoData.waypointCategories.get(originalName)!,
              description: desc || wp.description,
            };
          }
        }
        // Try direct match
        if (caltopoData.waypointCategories.has(wp.name)) {
          const desc = caltopoData.waypointDescriptions.get(wp.name);
          return {
            ...wp,
            type: caltopoData.waypointCategories.get(wp.name)!,
            description: desc || wp.description,
          };
        }
        return wp;
      });
    }

    // Add alternates and side trips from GeoJSON
    if (caltopoData.alternates.length > 0) {
      alternates = caltopoData.alternates;
      console.log(`  ✓ Found ${alternates.length} alternate routes`);
    }
    if (caltopoData.sideTrips.length > 0) {
      sideTrips = caltopoData.sideTrips;
      console.log(`  ✓ Found ${sideTrips.length} side trips`);
    }
  }

  // Fall back to CSV waypoints if no GPX waypoints and CSV exists
  if (waypoints.length === 0 && config.waypointsFile) {
    const waypointsPath = path.join(trailDir, config.waypointsFile);
    if (fs.existsSync(waypointsPath)) {
      const waypointsContent = fs.readFileSync(waypointsPath, 'utf-8');
      const waypointsResult = Papa.parse(waypointsContent, { header: true });
      waypoints = (waypointsResult.data as Record<string, unknown>[])
        .filter(row => row.name && row.lat && row.lon)
        .map(row => ({
          name: String(row.name),
          lat: parseFloat(String(row.lat)),
          lon: parseFloat(String(row.lon)),
          type: String(row.type || 'waypoint'),
          description: row.description ? String(row.description) : undefined,
        }));
    }
  }

  // Parse climate if exists
  let climate: Record<string, unknown> | null = null;
  if (config.climateFile) {
    const climatePath = path.join(trailDir, config.climateFile);
    if (fs.existsSync(climatePath)) {
      climate = JSON.parse(fs.readFileSync(climatePath, 'utf-8'));
    }
  }

  // Update config with calculated distance
  config.lengthKm = Math.round(totalDistance * 10) / 10;

  // Enrich waypoints with distance and elevation data
  const enrichedWaypoints = enrichWaypoints(waypoints, gpxData.points);

  // Enrich variants with junction point data (where they connect to main track)
  const enrichedAlternates = findVariantJunctions(alternates, points);
  const enrichedSideTrips = findVariantJunctions(sideTrips, points);

  return {
    config,
    track: {
      points,
      totalDistance,
      totalAscent,
      totalDescent,
    },
    waypoints: enrichedWaypoints,
    alternates: enrichedAlternates,
    sideTrips: enrichedSideTrips,
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
  const autoGenTrails = new Set<string>();

  for (const trailDir of trailDirs) {
    const { errors, needsAutoConfig } = validateTrailDirectory(trailDir);
    allErrors.push(...errors);
    if (needsAutoConfig) {
      autoGenTrails.add(trailDir);
    }
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
    const needsAutoGen = autoGenTrails.has(trailDir);
    console.log(`Processing: ${trailId}${needsAutoGen ? ' (auto-generating config)' : ''}`);

    try {
      const processed = await processTrail(trailDir, needsAutoGen);

      // Write processed data
      const outputPath = path.join(OUTPUT_DIR, `${processed.config.id}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(processed, null, 2));
      console.log(`  ✓ Written to ${outputPath}`);
      console.log(`    Distance: ${processed.track.totalDistance.toFixed(1)} km`);
      console.log(`    Elevation: +${Math.round(processed.track.totalAscent)}m / -${Math.round(processed.track.totalDescent)}m`);
      console.log(`    Waypoints: ${processed.waypoints.length}`);

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
