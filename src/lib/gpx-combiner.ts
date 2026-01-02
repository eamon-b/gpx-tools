import type { GpxPoint, GpxWaypoint, CombineOptions, CombineResult } from './types';
import { parseGpx, generateGpx } from './gpx-parser';

const DEFAULT_OPTIONS: CombineOptions = {
  trackName: 'Combined Track',
  removeDuplicateWaypoints: true,
  mergeAllSegments: true,
};

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

  const allPoints: GpxPoint[] = [];
  const allWaypoints: GpxWaypoint[] = [];

  // Parse and combine all GPX files
  for (const gpxContent of gpxContents) {
    const gpxData = parseGpx(gpxContent);

    // Combine all track points
    for (const track of gpxData.tracks) {
      for (const segment of track.segments) {
        allPoints.push(...segment.points);
      }
    }

    // Combine all route points
    for (const route of gpxData.routes) {
      allPoints.push(...route.points);
    }

    // Combine waypoints
    allWaypoints.push(...gpxData.waypoints);
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
  };
}

/**
 * Remove duplicate waypoints based on coordinates and name
 */
function removeDuplicateWaypoints(waypoints: GpxWaypoint[]): GpxWaypoint[] {
  const seen = new Set<string>();
  const unique: GpxWaypoint[] = [];

  for (const wpt of waypoints) {
    const key = `${wpt.lat},${wpt.lon},${wpt.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(wpt);
    }
  }

  return unique;
}

export { DEFAULT_OPTIONS as GPX_COMBINER_DEFAULTS };
