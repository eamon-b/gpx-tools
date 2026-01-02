import { describe, it, expect } from 'vitest';
import { combineGpx, GPX_COMBINER_DEFAULTS } from './gpx-combiner';

describe('combineGpx', () => {
  // Helper to create a simple GPX file
  function createSimpleGpx(trackName: string, numPoints: number): string {
    const points = Array.from({ length: numPoints }, (_, i) => {
      const lat = -37.8136 + (i * 0.001);
      const lon = 144.9631 + (i * 0.001);
      return `      <trkpt lat="${lat}" lon="${lon}"><ele>${i}</ele></trkpt>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>${trackName}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
  }

  // Helper to create a GPX with waypoints
  function createGpxWithWaypoints(waypoints: Array<{ lat: number; lon: number; name: string }>): string {
    const wpts = waypoints.map(w => `  <wpt lat="${w.lat}" lon="${w.lon}">
    <name>${w.name}</name>
  </wpt>`).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
${wpts}
  <trk>
    <name>Test Track</name>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;
  }

  it('should combine multiple GPX files', () => {
    const gpx1 = createSimpleGpx('Track 1', 100);
    const gpx2 = createSimpleGpx('Track 2', 50);
    const gpx3 = createSimpleGpx('Track 3', 75);

    const result = combineGpx([gpx1, gpx2, gpx3]);

    expect(result.pointCount).toBe(225);
    expect(result.fileCount).toBe(3);
  });

  it('should use default track name', () => {
    const gpx1 = createSimpleGpx('Track 1', 10);
    const result = combineGpx([gpx1]);

    expect(result.content).toContain('<name>Combined Track</name>');
  });

  it('should use custom track name', () => {
    const gpx1 = createSimpleGpx('Track 1', 10);
    const result = combineGpx([gpx1], { trackName: 'My Custom Track' });

    expect(result.content).toContain('<name>My Custom Track</name>');
  });

  it('should combine waypoints from multiple files', () => {
    const gpx1 = createGpxWithWaypoints([{ lat: -37.8136, lon: 144.9631, name: 'Waypoint 1' }]);
    const gpx2 = createGpxWithWaypoints([{ lat: -37.8137, lon: 144.9632, name: 'Waypoint 2' }]);

    const result = combineGpx([gpx1, gpx2]);

    expect(result.waypointCount).toBe(2);
    expect(result.content).toContain('Waypoint 1');
    expect(result.content).toContain('Waypoint 2');
  });

  it('should remove duplicate waypoints by default', () => {
    const gpx1 = createGpxWithWaypoints([
      { lat: -37.8136, lon: 144.9631, name: 'Waypoint 1' },
      { lat: -37.8137, lon: 144.9632, name: 'Waypoint 2' }
    ]);
    const gpx2 = createGpxWithWaypoints([
      { lat: -37.8136, lon: 144.9631, name: 'Waypoint 1' }, // Duplicate
      { lat: -37.8138, lon: 144.9633, name: 'Waypoint 3' }
    ]);

    const result = combineGpx([gpx1, gpx2]);

    expect(result.waypointCount).toBe(3);
  });

  it('should keep duplicate waypoints when option is disabled', () => {
    const gpx1 = createGpxWithWaypoints([
      { lat: -37.8136, lon: 144.9631, name: 'Waypoint 1' }
    ]);
    const gpx2 = createGpxWithWaypoints([
      { lat: -37.8136, lon: 144.9631, name: 'Waypoint 1' } // Duplicate
    ]);

    const result = combineGpx([gpx1, gpx2], { removeDuplicateWaypoints: false });

    expect(result.waypointCount).toBe(2);
  });

  it('should handle routes in addition to tracks', () => {
    const gpxWithRoute = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <rte>
    <name>Test Route</name>
    <rtept lat="-37.8136" lon="144.9631"><ele>0</ele></rtept>
    <rtept lat="-37.8137" lon="144.9632"><ele>1</ele></rtept>
  </rte>
</gpx>`;
    const gpxWithTrack = createSimpleGpx('Track 1', 10);

    const result = combineGpx([gpxWithRoute, gpxWithTrack]);

    expect(result.pointCount).toBe(12); // 2 from route + 10 from track
  });

  it('should generate valid GPX content', () => {
    const gpx1 = createSimpleGpx('Track 1', 50);
    const result = combineGpx([gpx1]);

    expect(result.content).toContain('<?xml version="1.0"');
    expect(result.content).toContain('<gpx version="1.1"');
    expect(result.content).toContain('<trk>');
    expect(result.content).toContain('</gpx>');
  });

  it('should handle single GPX file', () => {
    const gpx = createSimpleGpx('Track 1', 100);
    const result = combineGpx([gpx]);

    expect(result.pointCount).toBe(100);
    expect(result.fileCount).toBe(1);
  });

  it('should throw error when no GPX files provided', () => {
    expect(() => combineGpx([])).toThrow('At least one GPX file is required');
  });

  it('should handle GPX files with multiple segments', () => {
    const gpxWithSegments = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Multi-segment Track</name>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"><ele>0</ele></trkpt>
      <trkpt lat="-37.8137" lon="144.9632"><ele>0</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="-37.8138" lon="144.9633"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = combineGpx([gpxWithSegments]);

    expect(result.pointCount).toBe(3);
  });

  it('should handle GPX with multiple tracks', () => {
    const gpxWithMultipleTracks = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Track 1</name>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
  <trk>
    <name>Track 2</name>
    <trkseg>
      <trkpt lat="-37.8137" lon="144.9632"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = combineGpx([gpxWithMultipleTracks]);

    expect(result.pointCount).toBe(2);
  });

  it('should use default options when none provided', () => {
    expect(GPX_COMBINER_DEFAULTS.trackName).toBe('Combined Track');
    expect(GPX_COMBINER_DEFAULTS.removeDuplicateWaypoints).toBe(true);
    expect(GPX_COMBINER_DEFAULTS.mergeAllSegments).toBe(true);
  });

  it('should handle empty tracks', () => {
    const emptyGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Empty Track</name>
  </trk>
</gpx>`;
    const validGpx = createSimpleGpx('Valid Track', 10);

    const result = combineGpx([emptyGpx, validGpx]);

    expect(result.pointCount).toBe(10);
  });

  it('should preserve elevation data', () => {
    const gpx1 = createSimpleGpx('Track 1', 3);
    const result = combineGpx([gpx1]);

    // Note: elevation 0 is not written to GPX (per generateGpx logic)
    expect(result.content).toContain('<ele>1</ele>');
    expect(result.content).toContain('<ele>2</ele>');
  });
});
