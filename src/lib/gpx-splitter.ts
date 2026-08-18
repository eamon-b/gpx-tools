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
 * Return a filename that has not been used yet, appending _2, _3, ...
 * before the extension if the candidate collides with a previous one.
 */
function uniqueFilename(candidate: string, used: Set<string>): string {
  let filename = candidate;
  if (used.has(filename)) {
    const stem = candidate.replace(/\.gpx$/i, '');
    let n = 2;
    while (used.has(`${stem}_${n}.gpx`)) {
      n++;
    }
    filename = `${stem}_${n}.gpx`;
  }
  used.add(filename);
  return filename;
}

/**
 * Split a GPX file into smaller chunks with associated waypoints.
 * Routes (<rte>) are treated as pseudo-tracks and written as tracks
 * in the output chunks.
 */
export function splitGpx(
  gpxContent: string,
  options: Partial<SplitOptions> = {}
): SplitResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!Number.isFinite(opts.maxPoints) || opts.maxPoints <= 0) {
    throw new Error('maxPoints must be a positive number');
  }

  const gpxData = parseGpx(gpxContent);
  const results: SplitResult[] = [];
  const usedFilenames = new Set<string>();

  // Treat routes as pseudo-tracks so route-only files get split too
  const pseudoTracks: { name: string; points: GpxPoint[] }[] = [
    ...gpxData.tracks.map(track => ({
      name: track.name,
      points: track.segments.flatMap(segment => segment.points),
    })),
    ...gpxData.routes.map(route => ({
      name: route.name,
      points: route.points,
    })),
  ];

  for (let trackIndex = 0; trackIndex < pseudoTracks.length; trackIndex++) {
    const track = pseudoTracks[trackIndex];
    const trackName = sanitizeFilename(track.name) || `Track_${trackIndex}`;

    const allPoints = track.points;
    const totalPoints = allPoints.length;
    const needsSplitting = totalPoints > opts.maxPoints;

    // Split into chunks. Each chunk after the first starts at the previous
    // chunk's last point, so consecutive files share a point and the route
    // doesn't jump between them on a device.
    for (let chunkIdx = 0, start = 0; start < totalPoints; chunkIdx++) {
      const chunkPoints = allPoints.slice(start, start + opts.maxPoints);

      // Find waypoints close to this chunk
      const closeWaypoints = findCloseWaypoints(
        chunkPoints,
        gpxData.waypoints,
        opts.waypointMaxDistance
      );

      // Generate filename (deduplicated across same-named tracks/routes)
      const baseFilename = needsSplitting
        ? `${trackName}_${chunkIdx + 1}.gpx`
        : `${trackName}.gpx`;
      const filename = uniqueFilename(baseFilename, usedFilenames);

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

      const end = start + chunkPoints.length;
      if (end >= totalPoints) {
        break;
      }
      // Overlap by one point; Math.max guarantees progress when maxPoints === 1
      start = Math.max(end - 1, start + 1);
    }
  }

  return results;
}

export { DEFAULT_OPTIONS as GPX_SPLITTER_DEFAULTS };
