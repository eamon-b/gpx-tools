import type { GpxPoint, SplitOptions, SplitResult } from './types';
import { parseGpx, generateGpx } from './gpx-parser';
import { findCloseWaypoints } from './distance';

const DEFAULT_OPTIONS: SplitOptions = {
  maxPoints: 5000,
  waypointMaxDistance: 5, // km
};

/**
 * Sanitize a track name to make it a valid filename
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .slice(0, 50);
}

/**
 * Split a GPX file into smaller chunks with associated waypoints
 */
export function splitGpx(
  gpxContent: string,
  options: Partial<SplitOptions> = {}
): SplitResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const gpxData = parseGpx(gpxContent);
  const results: SplitResult[] = [];

  for (let trackIndex = 0; trackIndex < gpxData.tracks.length; trackIndex++) {
    const track = gpxData.tracks[trackIndex];
    const trackName = sanitizeFilename(track.name) || `Track_${trackIndex}`;

    // Collect all points from all segments
    const allPoints: GpxPoint[] = [];
    for (const segment of track.segments) {
      allPoints.push(...segment.points);
    }

    const totalPoints = allPoints.length;
    const needsSplitting = totalPoints > opts.maxPoints;

    // Split into chunks
    for (let chunkIdx = 0, i = 0; i < totalPoints; chunkIdx++, i += opts.maxPoints) {
      const chunkPoints = allPoints.slice(i, i + opts.maxPoints);

      // Find waypoints close to this chunk
      const closeWaypoints = findCloseWaypoints(
        chunkPoints,
        gpxData.waypoints,
        opts.waypointMaxDistance
      );

      // Generate filename
      const filename = needsSplitting
        ? `${trackName}_${chunkIdx + 1}.gpx`
        : `${trackName}.gpx`;

      // Generate track name for this chunk
      const chunkTrackName = needsSplitting
        ? `${track.name || trackName} ${chunkIdx + 1}`
        : (track.name || trackName);

      // Generate GPX content
      const content = generateGpx(chunkTrackName, chunkPoints, closeWaypoints);

      results.push({
        filename,
        content,
        pointCount: chunkPoints.length,
        waypointCount: closeWaypoints.length,
      });
    }
  }

  return results;
}

export { DEFAULT_OPTIONS as GPX_SPLITTER_DEFAULTS };
