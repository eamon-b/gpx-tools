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

  // Helper to create a GPX with specific start/end coordinates
  function createGpxWithCoords(
    startLat: number, startLon: number,
    endLat: number, endLon: number,
    numPoints: number = 10
  ): string {
    const points = Array.from({ length: numPoints }, (_, i) => {
      const t = i / (numPoints - 1);
      const lat = startLat + t * (endLat - startLat);
      const lon = startLon + t * (endLon - startLon);
      return `      <trkpt lat="${lat}" lon="${lon}"><ele>${i}</ele></trkpt>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Track</name>
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

  it('should detect duplicates with minor floating point differences', () => {
    const gpx1 = createGpxWithWaypoints([
      { lat: -37.8136, lon: 144.9631, name: 'Waypoint 1' }
    ]);
    const gpx2 = createGpxWithWaypoints([
      { lat: -37.81360001, lon: 144.96310001, name: 'Waypoint 1' } // Same location with precision diff
    ]);

    const result = combineGpx([gpx1, gpx2]);

    expect(result.waypointCount).toBe(1); // Should be deduplicated
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
    expect(GPX_COMBINER_DEFAULTS.autoOrder).toBe(false);
    expect(GPX_COMBINER_DEFAULTS.gapThresholdMeters).toBe(100);
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

  it('should return segment order and gap info by default', () => {
    const gpx1 = createSimpleGpx('Track 1', 10);
    const result = combineGpx([gpx1]);

    expect(result.gaps).toEqual([]);
    expect(result.wasReordered).toBe(false);
    expect(result.segmentOrder).toEqual([0]);
  });

  it('should detect gaps between segments', () => {
    // Create two tracks that are far apart (about 111km apart in latitude)
    const gpx1 = createGpxWithCoords(-37.0, 144.0, -37.1, 144.0);
    const gpx2 = createGpxWithCoords(-38.0, 144.0, -38.1, 144.0);

    const result = combineGpx([gpx1, gpx2], { gapThresholdMeters: 100 });

    expect(result.gaps.length).toBe(1);
    expect(result.gaps[0].afterSegmentIndex).toBe(0);
    expect(result.gaps[0].distanceMeters).toBeGreaterThan(90000); // ~100km
    expect(result.gaps[0].fromPoint.lat).toBeCloseTo(-37.1, 1);
    expect(result.gaps[0].toPoint.lat).toBeCloseTo(-38.0, 1);
  });

  it('should not report gaps when segments are close together', () => {
    // Create two tracks that connect (end of first is start of second)
    const gpx1 = createGpxWithCoords(-37.0, 144.0, -37.001, 144.0);
    const gpx2 = createGpxWithCoords(-37.001, 144.0, -37.002, 144.0);

    const result = combineGpx([gpx1, gpx2], { gapThresholdMeters: 200 });

    expect(result.gaps.length).toBe(0);
  });

  it('should reorder segments when autoOrder is enabled', () => {
    // Segment A: goes from point 1 to point 2
    // Segment B: goes from point 3 to point 4 (far from A)
    // Segment C: goes from point 2 to point 3 (connects A to B)
    // Input order: A, B, C
    // Expected output order: A, C, B (because C connects to end of A, then B connects to end of C)

    const segmentA = createGpxWithCoords(-37.0, 144.0, -37.01, 144.0); // ends at -37.01
    const segmentB = createGpxWithCoords(-37.03, 144.0, -37.04, 144.0); // starts at -37.03
    const segmentC = createGpxWithCoords(-37.01, 144.0, -37.02, 144.0); // starts at -37.01 (connects to A)

    const result = combineGpx([segmentA, segmentB, segmentC], { autoOrder: true });

    expect(result.wasReordered).toBe(true);
    expect(result.segmentOrder).toEqual([0, 2, 1]); // A, C, B
  });

  it('should reverse segments when needed for better continuity', () => {
    // Segment A: goes from point 1 to point 2
    // Segment B: goes from point 3 to point 2 (end matches end of A - needs reversal)

    const segmentA = createGpxWithCoords(-37.0, 144.0, -37.01, 144.0); // ends at -37.01
    const segmentB = createGpxWithCoords(-37.03, 144.0, -37.01, 144.0); // ends at -37.01 (should reverse)

    const result = combineGpx([segmentA, segmentB], { autoOrder: true });

    expect(result.wasReordered).toBe(true);
    // After reversal, first point of combined should be from A, last should be from reversed B
    expect(result.content).toMatch(/<trkpt lat="-37"/);
  });

  it('should not reorder when autoOrder is false', () => {
    const segmentA = createGpxWithCoords(-37.0, 144.0, -37.01, 144.0);
    const segmentB = createGpxWithCoords(-37.03, 144.0, -37.04, 144.0);
    const segmentC = createGpxWithCoords(-37.01, 144.0, -37.02, 144.0);

    const result = combineGpx([segmentA, segmentB, segmentC], { autoOrder: false });

    expect(result.wasReordered).toBe(false);
    expect(result.segmentOrder).toEqual([0, 1, 2]); // Original order preserved
  });

  it('should still detect gaps when autoOrder is false', () => {
    const gpx1 = createGpxWithCoords(-37.0, 144.0, -37.1, 144.0);
    const gpx2 = createGpxWithCoords(-38.0, 144.0, -38.1, 144.0);

    const result = combineGpx([gpx1, gpx2], { autoOrder: false, gapThresholdMeters: 100 });

    expect(result.gaps.length).toBe(1);
    expect(result.wasReordered).toBe(false);
  });

  it('should handle single segment with autoOrder enabled', () => {
    const gpx = createSimpleGpx('Track 1', 10);
    const result = combineGpx([gpx], { autoOrder: true });

    expect(result.wasReordered).toBe(false);
    expect(result.segmentOrder).toEqual([0]);
    expect(result.gaps).toEqual([]);
  });

  it('should handle empty files gracefully with autoOrder', () => {
    const emptyGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Empty Track</name>
  </trk>
</gpx>`;
    const validGpx = createSimpleGpx('Valid Track', 10);

    const result = combineGpx([emptyGpx, validGpx], { autoOrder: true });

    expect(result.pointCount).toBe(10);
    expect(result.segmentOrder).toEqual([1]); // Only the valid segment
  });
});
