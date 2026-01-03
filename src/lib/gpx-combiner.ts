import type { GpxPoint, GpxWaypoint, CombineOptions, CombineResult, RouteGap } from './types';
import { parseGpx, generateGpx } from './gpx-parser';
import { haversineDistance2D } from './distance';

const DEFAULT_OPTIONS: CombineOptions = {
  trackName: 'Combined Track',
  removeDuplicateWaypoints: true,
  autoOrder: false,
  gapThresholdMeters: 100,
};

/** A segment of points extracted from a GPX file */
interface RouteSegment {
  points: GpxPoint[];
  originalIndex: number;
  reversed: boolean;
}

/**
 * Get the start point of a segment
 */
function getStartPoint(segment: RouteSegment): GpxPoint {
  return segment.points[0];
}

/**
 * Get the end point of a segment
 */
function getEndPoint(segment: RouteSegment): GpxPoint {
  return segment.points[segment.points.length - 1];
}

/**
 * Calculate distance between two points
 */
function distanceBetween(p1: GpxPoint, p2: GpxPoint): number {
  return haversineDistance2D(p1.lat, p1.lon, p2.lat, p2.lon);
}

/**
 * Find the best next segment to connect to the current chain.
 * Returns the segment index and whether it should be reversed.
 */
function findBestNextSegment(
  currentEnd: GpxPoint,
  remainingSegments: RouteSegment[]
): { index: number; reverse: boolean; distance: number } {
  let bestIndex = 0;
  let bestDistance = Infinity;
  let bestReverse = false;

  for (let i = 0; i < remainingSegments.length; i++) {
    const seg = remainingSegments[i];

    // Distance to start of this segment (no reversal needed)
    const distToStart = distanceBetween(currentEnd, getStartPoint(seg));
    if (distToStart < bestDistance) {
      bestDistance = distToStart;
      bestIndex = i;
      bestReverse = false;
    }

    // Distance to end of this segment (would need reversal)
    const distToEnd = distanceBetween(currentEnd, getEndPoint(seg));
    if (distToEnd < bestDistance) {
      bestDistance = distToEnd;
      bestIndex = i;
      bestReverse = true;
    }
  }

  return { index: bestIndex, reverse: bestReverse, distance: bestDistance };
}

/**
 * Order segments for best geographic continuity using a greedy nearest-neighbor approach.
 * Also determines if segments need to be reversed.
 */
function orderSegments(segments: RouteSegment[]): RouteSegment[] {
  if (segments.length <= 1) {
    return segments;
  }

  const remaining = [...segments];
  const ordered: RouteSegment[] = [];

  // Start with the first segment (could be improved with a smarter starting point selection)
  ordered.push(remaining.shift()!);

  while (remaining.length > 0) {
    const currentEnd = getEndPoint(ordered[ordered.length - 1]);
    const { index, reverse } = findBestNextSegment(currentEnd, remaining);

    const nextSegment = remaining.splice(index, 1)[0];

    if (reverse) {
      // Reverse the points and mark it as reversed
      ordered.push({
        points: [...nextSegment.points].reverse(),
        originalIndex: nextSegment.originalIndex,
        reversed: !nextSegment.reversed,
      });
    } else {
      ordered.push(nextSegment);
    }
  }

  return ordered;
}

/**
 * Detect gaps between ordered segments
 */
function detectGaps(segments: RouteSegment[], thresholdMeters: number): RouteGap[] {
  const gaps: RouteGap[] = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const endPoint = getEndPoint(segments[i]);
    const startPoint = getStartPoint(segments[i + 1]);
    const distance = distanceBetween(endPoint, startPoint);

    if (distance > thresholdMeters) {
      gaps.push({
        afterSegmentIndex: i,
        distanceMeters: Math.round(distance),
        fromPoint: { lat: endPoint.lat, lon: endPoint.lon },
        toPoint: { lat: startPoint.lat, lon: startPoint.lon },
      });
    }
  }

  return gaps;
}

/**
 * Check if segment order changed from original input order
 */
function wasReordered(segments: RouteSegment[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].originalIndex !== i || segments[i].reversed) {
      return true;
    }
  }
  return false;
}

/**
 * Combine multiple GPX files into a single GPX file
 */
export function combineGpx(
  gpxContents: string[],
  options: Partial<CombineOptions> = {}
): CombineResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (gpxContents.length === 0) {
    throw new Error('At least one GPX file is required');
  }

  const segments: RouteSegment[] = [];
  const allWaypoints: GpxWaypoint[] = [];

  // Parse and extract segments from all GPX files
  for (let fileIndex = 0; fileIndex < gpxContents.length; fileIndex++) {
    const gpxContent = gpxContents[fileIndex];
    const gpxData = parseGpx(gpxContent);
    const filePoints: GpxPoint[] = [];

    // Collect all track points from this file
    for (const track of gpxData.tracks) {
      for (const segment of track.segments) {
        filePoints.push(...segment.points);
      }
    }

    // Collect all route points from this file
    for (const route of gpxData.routes) {
      filePoints.push(...route.points);
    }

    // Create a segment for this file if it has points
    if (filePoints.length > 0) {
      segments.push({
        points: filePoints,
        originalIndex: fileIndex,
        reversed: false,
      });
    }

    // Combine waypoints
    allWaypoints.push(...gpxData.waypoints);
  }

  // Order segments if auto-ordering is enabled
  const orderedSegments = opts.autoOrder ? orderSegments(segments) : segments;

  // Detect gaps between segments
  const gaps = detectGaps(orderedSegments, opts.gapThresholdMeters);

  // Check if reordering occurred
  const reordered = opts.autoOrder && wasReordered(orderedSegments);

  // Combine all points from ordered segments
  const allPoints: GpxPoint[] = [];
  for (const segment of orderedSegments) {
    allPoints.push(...segment.points);
  }

  // Remove duplicate waypoints if requested
  const finalWaypoints = opts.removeDuplicateWaypoints
    ? removeDuplicateWaypoints(allWaypoints)
    : allWaypoints;

  // Generate combined GPX content
  const content = generateGpx(opts.trackName, allPoints, finalWaypoints);

  return {
    content,
    pointCount: allPoints.length,
    waypointCount: finalWaypoints.length,
    fileCount: gpxContents.length,
    gaps,
    wasReordered: reordered,
    segmentOrder: orderedSegments.map(s => s.originalIndex),
  };
}

/**
 * Round coordinate to 6 decimal places (~0.1m precision) for comparison
 */
function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Remove duplicate waypoints based on coordinates and name
 */
function removeDuplicateWaypoints(waypoints: GpxWaypoint[]): GpxWaypoint[] {
  const seen = new Set<string>();
  const unique: GpxWaypoint[] = [];

  for (const wpt of waypoints) {
    const key = `${roundCoord(wpt.lat)},${roundCoord(wpt.lon)},${wpt.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(wpt);
    }
  }

  return unique;
}

export { DEFAULT_OPTIONS as GPX_COMBINER_DEFAULTS };
