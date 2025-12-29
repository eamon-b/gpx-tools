import Papa from 'papaparse';
import { parseGpx } from './gpx-parser';
import { haversineDistance3D, waypointToPointDistance } from './distance';
import type {
  GpxPoint,
  GpxWaypoint,
  GpxProcessOptions,
  WaypointVisit,
  ProcessResult,
  ProcessedRow,
  ResupplyRow,
  DistanceUnit,
  ElevationUnit,
} from './types';

// Default options for GPX processing
const DEFAULT_RESUPPLY_KEYWORDS = [
  'grocer', 'market', 'foodland', 'iga',
  'wool', 'coles', 'general', 'servo'
];

const DEFAULT_GPX_OPTIONS: GpxProcessOptions = {
  resupplyKeywords: DEFAULT_RESUPPLY_KEYWORDS,
  includeEndAsResupply: true,
  includeStartAsResupply: false,
  distanceUnit: 'km',
  elevationUnit: 'm',
  csvDelimiter: ',',
  waypointMaxDistance: 200, // meters
};

// Unit conversion constants
const KM_TO_MI = 0.621371;
const M_TO_FT = 3.28084;

/**
 * Convert distance value based on selected unit
 */
function formatDistance(km: number, unit: DistanceUnit): number {
  const value = unit === 'mi' ? km * KM_TO_MI : km;
  return Math.round(value * 1000) / 1000;
}

/**
 * Convert elevation value based on selected unit
 */
function formatElevation(meters: number, unit: ElevationUnit): number {
  const value = unit === 'ft' ? meters * M_TO_FT : meters;
  return Math.round(value * 10) / 10;
}

/**
 * Check if text contains any resupply keywords
 */
function hasResupplyKeyword(text: string | null | undefined, keywords: string[]): boolean {
  if (!text) return false;
  const lowerText = String(text).toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Find all waypoint visits along the route.
 *
 * This walks through track points in order and records a "visit" each time
 * the route enters proximity of a waypoint. The same waypoint can be visited
 * multiple times if the route passes it multiple times.
 *
 * For each continuous passage through the threshold zone, we record one visit
 * at the point of closest approach within that passage.
 */
export function findWaypointVisits(
  waypoints: GpxWaypoint[],
  trackPoints: GpxPoint[],
  maxDistanceMeters: number
): WaypointVisit[] {
  if (trackPoints.length === 0 || waypoints.length === 0) {
    return [];
  }

  const visits: WaypointVisit[] = [];

  // Track which waypoints we're currently "inside" (within threshold)
  // Key: waypoint index, Value: { bestDistance, bestTrackIndex }
  const activeProximity: Map<number, { bestDistance: number; bestTrackIndex: number }> = new Map();

  for (let trackIdx = 0; trackIdx < trackPoints.length; trackIdx++) {
    const trackPoint = trackPoints[trackIdx];

    // Check each waypoint
    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
      const waypoint = waypoints[wpIdx];
      const distance = waypointToPointDistance(waypoint, trackPoint);

      if (distance <= maxDistanceMeters) {
        // We're within threshold of this waypoint
        const existing = activeProximity.get(wpIdx);

        if (existing) {
          // Already tracking this waypoint, update if this is closer
          if (distance < existing.bestDistance) {
            existing.bestDistance = distance;
            existing.bestTrackIndex = trackIdx;
          }
        } else {
          // Just entered proximity of this waypoint
          activeProximity.set(wpIdx, { bestDistance: distance, bestTrackIndex: trackIdx });
        }
      } else {
        // We're outside threshold
        const existing = activeProximity.get(wpIdx);
        if (existing) {
          // Just exited proximity - record the visit at the best point
          visits.push({
            waypoint: waypoints[wpIdx],
            trackIndex: existing.bestTrackIndex,
            distanceFromTrack: existing.bestDistance,
          });
          activeProximity.delete(wpIdx);
        }
      }
    }
  }

  // Handle any waypoints we're still inside at the end of the track
  for (const [wpIdx, data] of activeProximity.entries()) {
    visits.push({
      waypoint: waypoints[wpIdx],
      trackIndex: data.bestTrackIndex,
      distanceFromTrack: data.bestDistance,
    });
  }

  // Sort visits by track position
  visits.sort((a, b) => a.trackIndex - b.trackIndex);

  return visits;
}

/**
 * Calculate segment statistics between two track indices.
 * Returns distance in kilometers, and ascent/descent in meters.
 */
export function calculateSegmentStats(
  points: GpxPoint[],
  fromIndex: number,
  toIndex: number
): { distance: number; ascent: number; descent: number } {
  let distance = 0;
  let ascent = 0;
  let descent = 0;

  for (let i = fromIndex; i < toIndex && i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];

    // Calculate 3D distance between consecutive points
    distance += haversineDistance3D(
      p1.lat, p1.lon, p1.ele,
      p2.lat, p2.lon, p2.ele
    );

    // Calculate elevation change
    const elevDiff = p2.ele - p1.ele;
    if (elevDiff > 0) {
      ascent += elevDiff;
    } else {
      descent += Math.abs(elevDiff);
    }
  }

  // Convert distance from meters to kilometers
  return {
    distance: distance / 1000,
    ascent,
    descent,
  };
}

/**
 * Flatten track segments from a single track into an array of points.
 */
function flattenSingleTrackPoints(track: { segments: { points: GpxPoint[] }[] }): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (const segment of track.segments) {
    points.push(...segment.points);
  }
  return points;
}

/**
 * Process a single track/route to generate waypoint data.
 * Internal helper function used by processGpxTravelPlan.
 */
function processSingleTrack(
  trackPoints: GpxPoint[],
  waypoints: GpxWaypoint[],
  opts: GpxProcessOptions
): { processedRows: ProcessedRow[]; resupplyRows: ResupplyRow[] } | null {
  if (trackPoints.length === 0) {
    return null;
  }

  // Find all waypoint visits along this track
  const visits = findWaypointVisits(waypoints, trackPoints, opts.waypointMaxDistance);

  if (visits.length === 0) {
    return null;
  }

  // Build processed rows
  const processedRows: ProcessedRow[] = [];
  let runningDistance = 0;
  let runningAscent = 0;
  let runningDescent = 0;
  let prevTrackIndex = 0;

  for (let i = 0; i < visits.length; i++) {
    const visit = visits[i];

    // Calculate segment stats from previous point to this one
    const segmentStats = calculateSegmentStats(trackPoints, prevTrackIndex, visit.trackIndex);

    runningDistance += segmentStats.distance;
    runningAscent += segmentStats.ascent;
    runningDescent += segmentStats.descent;

    // Get elevation from the track point (more consistent with distance/ascent/descent calculations)
    const elevation = trackPoints[visit.trackIndex].ele;

    // Combine name and desc for notes, checking both for resupply keywords
    const notes = visit.waypoint.desc || '';

    processedRows.push({
      location: visit.waypoint.name || `Waypoint ${i + 1}`,
      elevation,
      ascent: segmentStats.ascent,
      descent: segmentStats.descent,
      distance: segmentStats.distance,
      totalDistance: Math.round(runningDistance * 1000) / 1000,
      totalAscent: Math.round(runningAscent * 10) / 10,
      totalDescent: Math.round(runningDescent * 10) / 10,
      notes,
    });

    prevTrackIndex = visit.trackIndex;
  }

  // Create resupply points
  const resupplyRows: ResupplyRow[] = [];
  let prevResupplyDistance = 0;
  let prevResupplyAscent = 0;
  let prevResupplyDescent = 0;

  for (let i = 0; i < processedRows.length; i++) {
    const row = processedRows[i];
    const isFirst = i === 0;
    const isLast = i === processedRows.length - 1;

    // Check both name and notes for resupply keywords
    const nameHasKeyword = hasResupplyKeyword(row.location, opts.resupplyKeywords);
    const notesHasKeyword = hasResupplyKeyword(row.notes, opts.resupplyKeywords);
    const isResupply = nameHasKeyword || notesHasKeyword;

    const isStart = opts.includeStartAsResupply && isFirst;
    const isEnd = opts.includeEndAsResupply && isLast;

    if (isResupply || isStart || isEnd) {
      const segmentDistance = row.totalDistance - prevResupplyDistance;
      const segmentAscent = row.totalAscent - prevResupplyAscent;
      const segmentDescent = row.totalDescent - prevResupplyDescent;

      resupplyRows.push({
        location: row.location,
        notes: row.notes,
        totalDistance: row.totalDistance,
        distance: Math.round(segmentDistance * 1000) / 1000,
        ascent: Math.round(segmentAscent * 10) / 10,
        descent: Math.round(segmentDescent * 10) / 10,
        totalAscent: row.totalAscent,
        totalDescent: row.totalDescent,
      });

      prevResupplyDistance = row.totalDistance;
      prevResupplyAscent = row.totalAscent;
      prevResupplyDescent = row.totalDescent;
    }
  }

  return { processedRows, resupplyRows };
}

/**
 * Process a GPX file to generate a travel plan datasheet.
 *
 * This function:
 * 1. Parses the GPX file
 * 2. Processes each track/route separately (not concatenated)
 * 3. Finds all waypoint visits along each track
 * 4. Calculates distance/ascent/descent for each segment
 * 5. Returns the combined ProcessResult for all tracks
 *
 * Each track is processed independently with its own cumulative totals.
 * Track names are used as section headers in the output.
 */
export function processGpxTravelPlan(
  gpxContent: string,
  options: Partial<GpxProcessOptions> = {}
): ProcessResult {
  const opts = { ...DEFAULT_GPX_OPTIONS, ...options };

  // Parse GPX
  const gpxData = parseGpx(gpxContent);

  // Validate GPX has required data (tracks or routes)
  if (gpxData.tracks.length === 0 && gpxData.routes.length === 0) {
    throw new Error('GPX file has no track or route data. Track or route data is required to calculate distances.');
  }

  if (gpxData.waypoints.length === 0) {
    throw new Error('GPX file has no waypoints. Waypoints are required to generate a datasheet.');
  }

  // Collect all tracks and routes to process
  const tracksToProcess: Array<{ name: string; points: GpxPoint[] }> = [];

  // Add tracks
  for (const track of gpxData.tracks) {
    const points = flattenSingleTrackPoints(track);
    if (points.length > 0) {
      tracksToProcess.push({
        name: track.name || `Track ${tracksToProcess.length + 1}`,
        points,
      });
    }
  }

  // Add routes
  for (const route of gpxData.routes) {
    if (route.points.length > 0) {
      tracksToProcess.push({
        name: route.name || `Route ${tracksToProcess.length + 1}`,
        points: route.points,
      });
    }
  }

  if (tracksToProcess.length === 0) {
    throw new Error('GPX file has no track points. Track points are required to calculate distances.');
  }

  // Process each track separately
  const allProcessedRows: ProcessedRow[] = [];
  const allResupplyRows: ResupplyRow[] = [];
  const trackResults: Array<{ name: string; processedRows: ProcessedRow[]; resupplyRows: ResupplyRow[] }> = [];

  for (const trackData of tracksToProcess) {
    const result = processSingleTrack(trackData.points, gpxData.waypoints, opts);
    if (result && result.processedRows.length > 0) {
      trackResults.push({
        name: trackData.name,
        processedRows: result.processedRows,
        resupplyRows: result.resupplyRows,
      });
      allProcessedRows.push(...result.processedRows);
      allResupplyRows.push(...result.resupplyRows);
    }
  }

  if (trackResults.length === 0) {
    throw new Error(
      `No waypoints found on any track/route. Ensure waypoints are within ${opts.waypointMaxDistance}m of the tracks.`
    );
  }

  // Generate output CSVs with unit labels
  const distLabel = opts.distanceUnit === 'mi' ? 'mi' : 'km';
  const eleLabel = opts.elevationUnit === 'ft' ? 'ft' : 'm';

  const processedPlanHeaders = [
    'Location', `Elevation (${eleLabel})`, `Ascent (${eleLabel})`, `Descent (${eleLabel})`, `Distance (${distLabel})`,
    `Total Distance (${distLabel})`, `Total Ascent (${eleLabel})`, `Total Descent (${eleLabel})`, 'Notes'
  ];

  // Build processed plan data with track headers
  const processedPlanData: (string | number)[][] = [];

  for (const trackResult of trackResults) {
    // Add track header row (empty except for track name in Location column)
    if (trackResults.length > 1) {
      processedPlanData.push([trackResult.name, '', '', '', '', '', '', '', '']);
    }

    // Add waypoint rows for this track
    for (const row of trackResult.processedRows) {
      processedPlanData.push([
        row.location,
        formatElevation(row.elevation, opts.elevationUnit),
        formatElevation(row.ascent, opts.elevationUnit),
        formatElevation(row.descent, opts.elevationUnit),
        formatDistance(row.distance, opts.distanceUnit),
        formatDistance(row.totalDistance, opts.distanceUnit),
        formatElevation(row.totalAscent, opts.elevationUnit),
        formatElevation(row.totalDescent, opts.elevationUnit),
        row.notes,
      ]);
    }
  }

  const processedPlan = Papa.unparse({
    fields: processedPlanHeaders,
    data: processedPlanData,
  }, { quotes: true, delimiter: opts.csvDelimiter });

  const resupplyHeaders = [
    'Location', 'Notes', `Total Distance (${distLabel})`, `Distance (${distLabel})`,
    `Ascent (${eleLabel})`, `Descent (${eleLabel})`, `Total Ascent (${eleLabel})`, `Total Descent (${eleLabel})`
  ];

  // Build resupply data with track headers
  const resupplyData: (string | number)[][] = [];

  for (const trackResult of trackResults) {
    if (trackResult.resupplyRows.length === 0) continue;

    // Add track header row
    if (trackResults.length > 1) {
      resupplyData.push([trackResult.name, '', '', '', '', '', '', '']);
    }

    // Add resupply rows for this track
    for (const row of trackResult.resupplyRows) {
      resupplyData.push([
        row.location,
        row.notes,
        formatDistance(row.totalDistance, opts.distanceUnit),
        formatDistance(row.distance, opts.distanceUnit),
        formatElevation(row.ascent, opts.elevationUnit),
        formatElevation(row.descent, opts.elevationUnit),
        formatElevation(row.totalAscent, opts.elevationUnit),
        formatElevation(row.totalDescent, opts.elevationUnit),
      ]);
    }
  }

  const resupplyPoints = Papa.unparse({
    fields: resupplyHeaders,
    data: resupplyData,
  }, { quotes: true, delimiter: opts.csvDelimiter });

  // Calculate stats (in km and m for consistency with CSV processor)
  // Note: These are totals across ALL tracks
  const totalDistance = allProcessedRows.reduce((sum, r) => sum + r.distance, 0);
  const totalAscent = allProcessedRows.reduce((sum, r) => sum + r.ascent, 0);
  const totalDescent = allProcessedRows.reduce((sum, r) => sum + r.descent, 0);

  return {
    processedPlan,
    resupplyPoints,
    stats: {
      totalPoints: allProcessedRows.length,
      resupplyCount: allResupplyRows.length,
      totalDistance: Math.round(totalDistance * 100) / 100,
      totalAscent: Math.round(totalAscent),
      totalDescent: Math.round(totalDescent),
    },
  };
}

export { DEFAULT_GPX_OPTIONS as GPX_DATASHEET_DEFAULTS, DEFAULT_RESUPPLY_KEYWORDS as GPX_DEFAULT_RESUPPLY_KEYWORDS };
