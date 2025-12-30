import type {
  GpxPoint,
  GpxData,
  GpxTrack,
  GpxSegment,
  OptimizationOptions,
  OptimizationResult,
  OptimizationStats
} from './types';
import { parseGpx } from './gpx-parser';
import { haversineDistance3D } from './distance';

// Default optimization options
export const GPX_OPTIMIZER_DEFAULTS: OptimizationOptions = {
  simplificationTolerance: 10,      // 10 meters - good balance for web display
  elevationSmoothing: true,
  elevationSmoothingWindow: 7,      // 7 points moving average
  spikeThreshold: 50,               // 50 meters - max valid elevation change between points
  truncateStart: 0,                 // disabled by default
  truncateEnd: 0,                   // disabled by default
  stripExtensions: true,
  preserveTimestamps: true,
  coordinatePrecision: 6            // ~0.11 meter precision
};

// Validation thresholds
const DISTANCE_CHANGE_WARNING_THRESHOLD = 0.05;  // 5%
const ELEVATION_CHANGE_WARNING_THRESHOLD = 0.15; // 15%
const FILE_SIZE_WARNING_THRESHOLD = 20 * 1024;   // 20KB

/**
 * Calculate perpendicular distance from a point to a line segment
 * Used by Douglas-Peucker algorithm
 */
function perpendicularDistance(
  point: GpxPoint,
  lineStart: GpxPoint,
  lineEnd: GpxPoint
): number {
  // Convert to cartesian coordinates for calculation
  const toRadians = (deg: number) => deg * Math.PI / 180;

  // Use equirectangular approximation for short distances
  const lat1 = toRadians(lineStart.lat);
  const lat2 = toRadians(lineEnd.lat);
  const latP = toRadians(point.lat);

  const lon1 = toRadians(lineStart.lon);
  const lon2 = toRadians(lineEnd.lon);
  const lonP = toRadians(point.lon);

  // Earth radius in meters
  const R = 6371000;

  // Project to flat surface (equirectangular approximation)
  const x1 = lon1 * Math.cos((lat1 + lat2) / 2) * R;
  const y1 = lat1 * R;
  const x2 = lon2 * Math.cos((lat1 + lat2) / 2) * R;
  const y2 = lat2 * R;
  const xP = lonP * Math.cos((lat1 + lat2) / 2) * R;
  const yP = latP * R;

  // Line length squared
  const lineLengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;

  if (lineLengthSquared === 0) {
    // Line start and end are the same point
    return Math.sqrt((xP - x1) ** 2 + (yP - y1) ** 2);
  }

  // Project point onto line
  const t = Math.max(0, Math.min(1,
    ((xP - x1) * (x2 - x1) + (yP - y1) * (y2 - y1)) / lineLengthSquared
  ));

  const projX = x1 + t * (x2 - x1);
  const projY = y1 + t * (y2 - y1);

  return Math.sqrt((xP - projX) ** 2 + (yP - projY) ** 2);
}

/**
 * Douglas-Peucker line simplification algorithm
 * Reduces number of points while preserving shape within tolerance
 */
export function douglasPeucker(points: GpxPoint[], tolerance: number): GpxPoint[] {
  if (points.length <= 2) {
    return points;
  }

  // Find point with maximum distance from line between first and last
  let maxDistance = 0;
  let maxIndex = 0;

  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  // If max distance exceeds tolerance, recursively simplify
  if (maxDistance > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIndex), tolerance);

    // Combine results (avoiding duplicate point at maxIndex)
    return [...left.slice(0, -1), ...right];
  }

  // All points within tolerance - keep only endpoints
  return [first, last];
}

/**
 * Remove elevation spikes that exceed physical possibility
 * Returns points with interpolated elevations where spikes detected
 */
export function removeElevationSpikes(
  points: GpxPoint[],
  spikeThreshold: number
): GpxPoint[] {
  if (points.length < 2) return points;

  const result: GpxPoint[] = [{ ...points[0] }];

  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const current = points[i];

    const elevationChange = Math.abs(current.ele - prev.ele);

    if (elevationChange > spikeThreshold) {
      // Spike detected - interpolate elevation
      result.push({
        ...current,
        ele: prev.ele // Use previous elevation
      });
    } else {
      result.push({ ...current });
    }
  }

  return result;
}

/**
 * Apply moving average smoothing to elevation data
 */
export function smoothElevation(
  points: GpxPoint[],
  windowSize: number
): GpxPoint[] {
  if (points.length < windowSize) return points;

  const halfWindow = Math.floor(windowSize / 2);
  const result: GpxPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(points.length - 1, i + halfWindow);

    let elevationSum = 0;
    let count = 0;

    for (let j = start; j <= end; j++) {
      elevationSum += points[j].ele;
      count++;
    }

    result.push({
      ...points[i],
      ele: elevationSum / count
    });
  }

  return result;
}

/**
 * Calculate total distance of a track in meters
 */
export function calculateTrackDistance(points: GpxPoint[]): number {
  if (points.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += haversineDistance3D(
      points[i - 1].lat, points[i - 1].lon, points[i - 1].ele,
      points[i].lat, points[i].lon, points[i].ele
    );
  }

  return totalDistance;
}

/**
 * Calculate elevation gain and loss for a track
 * Uses threshold to filter out noise
 */
export function calculateElevationStats(
  points: GpxPoint[],
  threshold: number = 3 // 3 meter threshold for counting elevation changes
): { gain: number; loss: number } {
  if (points.length < 2) return { gain: 0, loss: 0 };

  let gain = 0;
  let loss = 0;

  for (let i = 1; i < points.length; i++) {
    const diff = points[i].ele - points[i - 1].ele;
    if (Math.abs(diff) >= threshold) {
      if (diff > 0) {
        gain += diff;
      } else {
        loss += Math.abs(diff);
      }
    }
  }

  return { gain, loss };
}

/**
 * Truncate track by distance from start and/or end
 * Returns truncated points array
 */
export function truncateTrack(
  points: GpxPoint[],
  truncateStartMeters: number,
  truncateEndMeters: number
): GpxPoint[] {
  if (points.length < 2) return points;

  let startIndex = 0;
  let endIndex = points.length - 1;

  // Find start index
  if (truncateStartMeters > 0) {
    let accumulatedDistance = 0;
    for (let i = 1; i < points.length; i++) {
      accumulatedDistance += haversineDistance3D(
        points[i - 1].lat, points[i - 1].lon, points[i - 1].ele,
        points[i].lat, points[i].lon, points[i].ele
      );
      if (accumulatedDistance >= truncateStartMeters) {
        startIndex = i;
        break;
      }
    }
  }

  // Find end index
  if (truncateEndMeters > 0) {
    let accumulatedDistance = 0;
    for (let i = points.length - 1; i > startIndex; i--) {
      accumulatedDistance += haversineDistance3D(
        points[i].lat, points[i].lon, points[i].ele,
        points[i - 1].lat, points[i - 1].lon, points[i - 1].ele
      );
      if (accumulatedDistance >= truncateEndMeters) {
        endIndex = i;
        break;
      }
    }
  }

  // Ensure we have at least 2 points
  if (endIndex - startIndex < 1) {
    return points.slice(0, 2);
  }

  return points.slice(startIndex, endIndex + 1);
}

/**
 * Round coordinates to specified precision
 */
export function roundCoordinates(points: GpxPoint[], precision: number): GpxPoint[] {
  const factor = Math.pow(10, precision);
  return points.map(p => ({
    ...p,
    lat: Math.round(p.lat * factor) / factor,
    lon: Math.round(p.lon * factor) / factor,
    ele: Math.round(p.ele * 10) / 10 // 1 decimal for elevation
  }));
}

/**
 * Generate optimized GPX XML from processed data
 */
export function generateOptimizedGpx(
  tracks: GpxTrack[],
  options: OptimizationOptions
): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tools - Optimizer"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
`;

  for (const track of tracks) {
    const escapedName = track.name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    xml += `  <trk>
    <name>${escapedName}</name>
`;

    for (const segment of track.segments) {
      xml += `    <trkseg>
`;
      for (const pt of segment.points) {
        xml += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">
`;
        if (pt.ele !== 0) {
          xml += `        <ele>${pt.ele}</ele>
`;
        }
        if (options.preserveTimestamps && pt.time) {
          xml += `        <time>${pt.time}</time>
`;
        }
        xml += `      </trkpt>
`;
      }
      xml += `    </trkseg>
`;
    }

    xml += `  </trk>
`;
  }

  xml += `</gpx>`;
  return xml;
}

/**
 * Get all points from a GPX data structure (from all tracks and segments)
 */
function getAllPoints(gpxData: GpxData): GpxPoint[] {
  const points: GpxPoint[] = [];

  for (const track of gpxData.tracks) {
    for (const segment of track.segments) {
      points.push(...segment.points);
    }
  }

  // Also include route points
  for (const route of gpxData.routes) {
    points.push(...route.points);
  }

  return points;
}

/**
 * Calculate statistics for a set of points
 */
function calculateStats(points: GpxPoint[], content: string): OptimizationStats {
  const { gain, loss } = calculateElevationStats(points);

  return {
    pointCount: points.length,
    fileSize: new TextEncoder().encode(content).length,
    distance: calculateTrackDistance(points),
    elevationGain: gain,
    elevationLoss: loss
  };
}

/**
 * Process a single GPX track segment
 */
function processSegment(
  segment: GpxSegment,
  options: OptimizationOptions
): GpxSegment {
  let points = [...segment.points];

  // 1. Truncate start/end for privacy
  if (options.truncateStart > 0 || options.truncateEnd > 0) {
    points = truncateTrack(points, options.truncateStart, options.truncateEnd);
  }

  // 2. Remove elevation spikes
  if (options.elevationSmoothing) {
    points = removeElevationSpikes(points, options.spikeThreshold);
  }

  // 3. Apply elevation smoothing
  if (options.elevationSmoothing && options.elevationSmoothingWindow > 1) {
    points = smoothElevation(points, options.elevationSmoothingWindow);
  }

  // 4. Simplify track with Douglas-Peucker
  points = douglasPeucker(points, options.simplificationTolerance);

  // 5. Round coordinates
  points = roundCoordinates(points, options.coordinatePrecision);

  return { points };
}

/**
 * Main optimization function - optimize a GPX file
 */
export function optimizeGpx(
  gpxContent: string,
  filename: string,
  options: Partial<OptimizationOptions> = {}
): OptimizationResult {
  const opts: OptimizationOptions = { ...GPX_OPTIMIZER_DEFAULTS, ...options };
  const warnings: string[] = [];

  // Parse GPX
  const gpxData = parseGpx(gpxContent);

  // Get original stats
  const originalPoints = getAllPoints(gpxData);
  const originalStats = calculateStats(originalPoints, gpxContent);

  // Convert routes to tracks if present
  const allTracks: GpxTrack[] = [...gpxData.tracks];
  for (const route of gpxData.routes) {
    allTracks.push({
      name: route.name || 'Converted Route',
      segments: [{ points: route.points }]
    });
  }

  // Process each track
  const optimizedTracks: GpxTrack[] = allTracks.map(track => ({
    name: track.name,
    segments: track.segments.map(segment => processSegment(segment, opts))
  }));

  // Generate optimized GPX
  const optimizedContent = generateOptimizedGpx(optimizedTracks, opts);

  // Get optimized stats
  const optimizedPoints: GpxPoint[] = [];
  for (const track of optimizedTracks) {
    for (const segment of track.segments) {
      optimizedPoints.push(...segment.points);
    }
  }
  const optimizedStats = calculateStats(optimizedPoints, optimizedContent);

  // Validation checks
  if (originalStats.distance > 0) {
    const distanceChange = Math.abs(optimizedStats.distance - originalStats.distance) / originalStats.distance;
    if (distanceChange > DISTANCE_CHANGE_WARNING_THRESHOLD) {
      warnings.push(`Distance changed by ${(distanceChange * 100).toFixed(1)}% (threshold: ${DISTANCE_CHANGE_WARNING_THRESHOLD * 100}%)`);
    }
  }

  if (originalStats.elevationGain > 0) {
    const elevationChange = Math.abs(optimizedStats.elevationGain - originalStats.elevationGain) / originalStats.elevationGain;
    if (elevationChange > ELEVATION_CHANGE_WARNING_THRESHOLD) {
      warnings.push(`Elevation gain changed by ${(elevationChange * 100).toFixed(1)}% (threshold: ${ELEVATION_CHANGE_WARNING_THRESHOLD * 100}%)`);
    }
  }

  if (optimizedStats.fileSize > FILE_SIZE_WARNING_THRESHOLD) {
    warnings.push(`File size (${(optimizedStats.fileSize / 1024).toFixed(1)} KB) exceeds target of ${FILE_SIZE_WARNING_THRESHOLD / 1024} KB`);
  }

  if (optimizedStats.pointCount < 2) {
    warnings.push('Warning: Less than 2 points after optimization');
  }

  // Generate output filename
  const outputFilename = filename.replace(/\.gpx$/i, '-optimized.gpx');

  return {
    filename: outputFilename,
    content: optimizedContent,
    original: originalStats,
    optimized: optimizedStats,
    warnings,
    passed: warnings.length === 0
  };
}

/**
 * Batch process multiple GPX files
 */
export function optimizeGpxBatch(
  files: Array<{ name: string; content: string }>,
  options: Partial<OptimizationOptions> = {}
): OptimizationResult[] {
  return files.map(file => optimizeGpx(file.content, file.name, options));
}
