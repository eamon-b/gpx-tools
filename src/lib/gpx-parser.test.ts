import { describe, it, expect } from 'vitest';
import { parseGpx, generateGpx } from './gpx-parser';
import type { GpxPoint, GpxWaypoint } from './types';

describe('parseGpx', () => {
  it('should parse a valid GPX with a single track', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Test Track</name>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631">
        <ele>50</ele>
        <time>2024-01-01T10:00:00Z</time>
      </trkpt>
      <trkpt lat="-37.8200" lon="144.9700">
        <ele>60</ele>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].name).toBe('Test Track');
    expect(result.tracks[0].segments).toHaveLength(1);
    expect(result.tracks[0].segments[0].points).toHaveLength(2);

    const point1 = result.tracks[0].segments[0].points[0];
    expect(point1.lat).toBe(-37.8136);
    expect(point1.lon).toBe(144.9631);
    expect(point1.ele).toBe(50);
    expect(point1.time).toBe('2024-01-01T10:00:00Z');

    const point2 = result.tracks[0].segments[0].points[1];
    expect(point2.time).toBeNull();
  });

  it('should parse waypoints', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <wpt lat="-37.8136" lon="144.9631">
    <ele>50</ele>
    <name>Melbourne CBD</name>
    <desc>City center</desc>
  </wpt>
  <wpt lat="-33.8688" lon="151.2093">
    <name>Sydney</name>
  </wpt>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.waypoints).toHaveLength(2);
    expect(result.waypoints[0].name).toBe('Melbourne CBD');
    expect(result.waypoints[0].desc).toBe('City center');
    expect(result.waypoints[0].ele).toBe(50);
    expect(result.waypoints[1].name).toBe('Sydney');
    expect(result.waypoints[1].desc).toBe('');
    expect(result.waypoints[1].ele).toBe(0);
  });

  it('should parse multiple tracks', () => {
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

    const result = parseGpx(gpx);

    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0].name).toBe('Track 1');
    expect(result.tracks[1].name).toBe('Track 2');
  });

  it('should parse multiple segments in a track', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Multi-segment Track</name>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"><ele>0</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="-37.8200" lon="144.9700"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.tracks[0].segments).toHaveLength(2);
  });

  it('should handle empty track with no segments', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Empty Track</name>
  </trk>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].segments).toHaveLength(0);
  });

  it('should handle track with empty segment', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Track with Empty Segment</name>
    <trkseg></trkseg>
  </trk>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.tracks[0].segments).toHaveLength(1);
    expect(result.tracks[0].segments[0].points).toHaveLength(0);
  });

  it('should handle missing optional elements', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.tracks[0].name).toBe('');
    const point = result.tracks[0].segments[0].points[0];
    expect(point.ele).toBe(0);
    expect(point.time).toBeNull();
  });

  it('should throw error for invalid XML', () => {
    const invalidGpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk>
    <name>Unclosed tag
  </trk>
</gpx>`;

    expect(() => parseGpx(invalidGpx)).toThrow('Invalid GPX XML');
  });

  it('should return empty arrays for GPX with no tracks or waypoints', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.tracks).toHaveLength(0);
    expect(result.routes).toHaveLength(0);
    expect(result.waypoints).toHaveLength(0);
  });

  it('should parse a route element', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <rte>
    <name>Test Route</name>
    <rtept lat="-37.8136" lon="144.9631">
      <ele>50</ele>
    </rtept>
    <rtept lat="-37.8200" lon="144.9700">
      <ele>60</ele>
    </rtept>
  </rte>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].name).toBe('Test Route');
    expect(result.routes[0].points).toHaveLength(2);

    const point1 = result.routes[0].points[0];
    expect(point1.lat).toBe(-37.8136);
    expect(point1.lon).toBe(144.9631);
    expect(point1.ele).toBe(50);

    const point2 = result.routes[0].points[1];
    expect(point2.lat).toBe(-37.82);
    expect(point2.ele).toBe(60);
  });

  it('should parse multiple routes', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <rte>
    <name>Route 1</name>
    <rtept lat="-37.8136" lon="144.9631"><ele>0</ele></rtept>
  </rte>
  <rte>
    <name>Route 2</name>
    <rtept lat="-33.8688" lon="151.2093"><ele>0</ele></rtept>
  </rte>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.routes).toHaveLength(2);
    expect(result.routes[0].name).toBe('Route 1');
    expect(result.routes[1].name).toBe('Route 2');
  });

  it('should parse GPX with both tracks and routes', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Track 1</name>
    <trkseg>
      <trkpt lat="-37.8136" lon="144.9631"><ele>50</ele></trkpt>
    </trkseg>
  </trk>
  <rte>
    <name>Route 1</name>
    <rtept lat="-33.8688" lon="151.2093"><ele>10</ele></rtept>
  </rte>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.tracks).toHaveLength(1);
    expect(result.routes).toHaveLength(1);
    expect(result.tracks[0].name).toBe('Track 1');
    expect(result.routes[0].name).toBe('Route 1');
  });

  it('should handle route with no name', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <rte>
    <rtept lat="-37.8136" lon="144.9631"><ele>0</ele></rtept>
  </rte>
</gpx>`;

    const result = parseGpx(gpx);

    expect(result.routes[0].name).toBe('');
  });
});

describe('generateGpx', () => {
  it('should generate valid GPX with track and waypoints', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: '2024-01-01T10:00:00Z' },
      { lat: -37.8200, lon: 144.9700, ele: 60, time: null },
    ];

    const waypoints: GpxWaypoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, name: 'Start', desc: 'Starting point' },
    ];

    const result = generateGpx('Test Track', points, waypoints);

    expect(result).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result).toContain('<gpx version="1.1"');
    expect(result).toContain('<trk>');
    expect(result).toContain('<name>Test Track</name>');
    expect(result).toContain('<trkseg>');
    expect(result).toContain('lat="-37.8136"');
    expect(result).toContain('lon="144.9631"');
    expect(result).toContain('<ele>50</ele>');
    expect(result).toContain('<time>2024-01-01T10:00:00Z</time>');
    expect(result).toContain('<wpt lat="-37.8136" lon="144.9631">');
    expect(result).toContain('<name>Start</name>');
    expect(result).toContain('<desc>Starting point</desc>');
  });

  it('should not include elevation when it is 0', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
    ];

    const result = generateGpx('Track', points, []);

    expect(result).not.toContain('<ele>0</ele>');
  });

  it('should not include time when it is null', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
    ];

    const result = generateGpx('Track', points, []);

    expect(result).not.toContain('<time>');
  });

  it('should escape XML special characters in track name', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
    ];

    const result = generateGpx('Track <with> & "special" \'chars\'', points, []);

    expect(result).toContain('Track &lt;with&gt; &amp; &quot;special&quot; &apos;chars&apos;');
  });

  it('should escape XML special characters in waypoint name and description', () => {
    const waypoints: GpxWaypoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, name: 'Point <A>', desc: 'Has & ampersand' },
    ];

    const result = generateGpx('Track', [], waypoints);

    expect(result).toContain('<name>Point &lt;A&gt;</name>');
    expect(result).toContain('<desc>Has &amp; ampersand</desc>');
  });

  it('should generate valid GPX with empty points array', () => {
    const result = generateGpx('Empty Track', [], []);

    expect(result).toContain('<trk>');
    expect(result).toContain('<name>Empty Track</name>');
    expect(result).toContain('<trkseg>');
    expect(result).toContain('</trkseg>');
  });

  it('should be parseable by parseGpx', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: '2024-01-01T10:00:00Z' },
    ];

    const waypoints: GpxWaypoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, name: 'Test', desc: 'Description' },
    ];

    const gpxString = generateGpx('Round Trip', points, waypoints);
    const parsed = parseGpx(gpxString);

    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0].name).toBe('Round Trip');
    expect(parsed.tracks[0].segments[0].points).toHaveLength(1);
    expect(parsed.waypoints).toHaveLength(1);
    expect(parsed.waypoints[0].name).toBe('Test');
  });
});
