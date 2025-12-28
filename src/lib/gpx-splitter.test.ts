import { describe, it, expect } from 'vitest';
import { splitGpx, GPX_SPLITTER_DEFAULTS } from './gpx-splitter';

describe('splitGpx', () => {
  // Helper to create a GPX with specified number of points
  function createGpxWithPoints(numPoints: number, trackName = 'Test Track'): string {
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

  it('should not split when points are under max', () => {
    const gpx = createGpxWithPoints(1000);
    const results = splitGpx(gpx, { maxPoints: 5000 });

    expect(results).toHaveLength(1);
    expect(results[0].pointCount).toBe(1000);
    expect(results[0].filename).toBe('Test Track.gpx');
  });

  it('should split when points exceed max', () => {
    const gpx = createGpxWithPoints(12000);
    const results = splitGpx(gpx, { maxPoints: 5000 });

    expect(results).toHaveLength(3);
    expect(results[0].pointCount).toBe(5000);
    expect(results[1].pointCount).toBe(5000);
    expect(results[2].pointCount).toBe(2000);
  });

  it('should generate numbered filenames when splitting', () => {
    const gpx = createGpxWithPoints(10000);
    const results = splitGpx(gpx, { maxPoints: 5000 });

    expect(results[0].filename).toBe('Test Track_1.gpx');
    expect(results[1].filename).toBe('Test Track_2.gpx');
  });

  it('should include waypoints near track points', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <wpt lat="-37.8136" lon="144.9631">
    <name>Close Waypoint</name>
  </wpt>
  <wpt lat="0" lon="0">
    <name>Far Waypoint</name>
  </wpt>
  <trk>
    <name>Track</name>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"><ele>0</ele></trkpt>
      <trkpt lat="-37.8137" lon="144.9632"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const results = splitGpx(gpx, { waypointMaxDistance: 5 });

    expect(results[0].waypointCount).toBe(1);
    expect(results[0].content).toContain('Close Waypoint');
    expect(results[0].content).not.toContain('Far Waypoint');
  });

  it('should respect waypointMaxDistance option', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <wpt lat="-37.8136" lon="144.9631">
    <name>Waypoint</name>
  </wpt>
  <trk>
    <name>Track</name>
    <trkseg>
      <trkpt lat="-37.82" lon="144.97"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const resultsSmallRadius = splitGpx(gpx, { waypointMaxDistance: 0.1 });
    const resultsLargeRadius = splitGpx(gpx, { waypointMaxDistance: 10 });

    expect(resultsSmallRadius[0].waypointCount).toBe(0);
    expect(resultsLargeRadius[0].waypointCount).toBe(1);
  });

  it('should sanitize track names for filenames', () => {
    // Use XML-safe characters that are invalid in filenames
    const gpx = createGpxWithPoints(100, 'Track: with? special* /chars|');
    const results = splitGpx(gpx);

    expect(results[0].filename).not.toContain(':');
    expect(results[0].filename).not.toContain('?');
    expect(results[0].filename).not.toContain('*');
    expect(results[0].filename).not.toContain('/');
    expect(results[0].filename).not.toContain('|');
  });

  it('should truncate long track names', () => {
    const longName = 'A'.repeat(100);
    const gpx = createGpxWithPoints(100, longName);
    const results = splitGpx(gpx);

    expect(results[0].filename.length).toBeLessThanOrEqual(54); // 50 chars + ".gpx"
  });

  it('should handle track with no name', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const results = splitGpx(gpx);

    expect(results[0].filename).toBe('Track_0.gpx');
  });

  it('should handle multiple tracks', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
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
      <trkpt lat="-33.8688" lon="151.2093"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const results = splitGpx(gpx);

    expect(results).toHaveLength(2);
    expect(results[0].filename).toBe('Track 1.gpx');
    expect(results[1].filename).toBe('Track 2.gpx');
  });

  it('should merge segments from the same track before splitting', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
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

    const results = splitGpx(gpx);

    expect(results[0].pointCount).toBe(3);
  });

  it('should generate valid GPX content', () => {
    const gpx = createGpxWithPoints(100);
    const results = splitGpx(gpx);

    expect(results[0].content).toContain('<?xml version="1.0"');
    expect(results[0].content).toContain('<gpx version="1.1"');
    expect(results[0].content).toContain('<trk>');
    expect(results[0].content).toContain('</gpx>');
  });

  it('should use default options when none provided', () => {
    expect(GPX_SPLITTER_DEFAULTS.maxPoints).toBe(5000);
    expect(GPX_SPLITTER_DEFAULTS.waypointMaxDistance).toBe(5);
  });

  it('should handle empty GPX', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
</gpx>`;

    const results = splitGpx(gpx);

    expect(results).toHaveLength(0);
  });

  it('should handle GPX with empty track', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Empty Track</name>
  </trk>
</gpx>`;

    const results = splitGpx(gpx);

    // Empty track should produce no results (or one result with 0 points)
    expect(results.length).toBe(0);
  });
});
