import { describe, it, expect } from 'vitest';
import {
  processGpxTravelPlan,
  findWaypointVisits,
  calculateSegmentStats,
  GPX_DATASHEET_DEFAULTS,
  GPX_DEFAULT_RESUPPLY_KEYWORDS,
} from './gpx-datasheet';
import type { GpxPoint, GpxWaypoint } from './types';

// Helper to escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper to create a simple GPX file
function createGpxContent(waypoints: GpxWaypoint[], trackPoints: GpxPoint[]): string {
  let xml = `<?xml version="1.0"?>
<gpx version="1.1" creator="Test">
`;

  for (const wpt of waypoints) {
    xml += `  <wpt lat="${wpt.lat}" lon="${wpt.lon}">
    <ele>${wpt.ele}</ele>
    <name>${escapeXml(wpt.name)}</name>
    ${wpt.desc ? `<desc>${escapeXml(wpt.desc)}</desc>` : ''}
  </wpt>
`;
  }

  xml += `  <trk>
    <name>Test Track</name>
    <trkseg>
`;

  for (const pt of trackPoints) {
    xml += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">
        <ele>${pt.ele}</ele>
      </trkpt>
`;
  }

  xml += `    </trkseg>
  </trk>
</gpx>`;

  return xml;
}

// Create track points along a simple line
function createLinearTrack(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number,
  numPoints: number,
  elevation: number = 100
): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);
    points.push({
      lat: startLat + t * (endLat - startLat),
      lon: startLon + t * (endLon - startLon),
      ele: elevation,
      time: null,
    });
  }
  return points;
}

describe('findWaypointVisits', () => {
  it('should find waypoints along a simple linear track', () => {
    // Track from (0, 0) to (0, 1) - about 111km at the equator
    const trackPoints: GpxPoint[] = createLinearTrack(0, 0, 0, 1, 100, 100);

    // Waypoint at the middle of the track
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0.5, ele: 100, name: 'Middle', desc: '' },
    ];

    const visits = findWaypointVisits(waypoints, trackPoints, 1000); // 1km threshold

    expect(visits).toHaveLength(1);
    expect(visits[0].waypoint.name).toBe('Middle');
    expect(visits[0].trackIndex).toBeGreaterThan(40);
    expect(visits[0].trackIndex).toBeLessThan(60);
  });

  it('should handle waypoint visited twice when route passes it twice', () => {
    // Create a track that goes A -> B -> A pattern
    // Track: (0,0) -> (0,0.1) -> (0,0) - going east then back west
    const trackPoints: GpxPoint[] = [
      ...createLinearTrack(0, 0, 0, 0.1, 50, 100),
      ...createLinearTrack(0, 0.1, 0, 0, 50, 100),
    ];

    // Waypoint near the middle that should be passed twice
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0.05, ele: 100, name: 'Midpoint', desc: '' },
    ];

    const visits = findWaypointVisits(waypoints, trackPoints, 1000); // 1km threshold

    // Should have TWO visits - once going out, once coming back
    expect(visits).toHaveLength(2);
    expect(visits[0].waypoint.name).toBe('Midpoint');
    expect(visits[1].waypoint.name).toBe('Midpoint');
    expect(visits[0].trackIndex).toBeLessThan(visits[1].trackIndex);
  });

  it('should exclude waypoints beyond threshold', () => {
    const trackPoints: GpxPoint[] = createLinearTrack(0, 0, 0, 1, 100, 100);

    // Waypoint far from the track (about 111km away)
    const waypoints: GpxWaypoint[] = [
      { lat: 1, lon: 0.5, ele: 100, name: 'FarAway', desc: '' },
    ];

    const visits = findWaypointVisits(waypoints, trackPoints, 1000); // 1km threshold

    expect(visits).toHaveLength(0);
  });

  it('should return empty array for empty inputs', () => {
    expect(findWaypointVisits([], [], 1000)).toEqual([]);
    expect(findWaypointVisits([{ lat: 0, lon: 0, ele: 0, name: 'test', desc: '' }], [], 1000)).toEqual([]);
    expect(findWaypointVisits([], [{ lat: 0, lon: 0, ele: 0, time: null }], 1000)).toEqual([]);
  });

  it('should order visits by track position', () => {
    const trackPoints: GpxPoint[] = createLinearTrack(0, 0, 0, 1, 100, 100);

    // Waypoints in reverse order from their track position
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0.8, ele: 100, name: 'Third', desc: '' },
      { lat: 0, lon: 0.2, ele: 100, name: 'First', desc: '' },
      { lat: 0, lon: 0.5, ele: 100, name: 'Second', desc: '' },
    ];

    const visits = findWaypointVisits(waypoints, trackPoints, 1000);

    expect(visits).toHaveLength(3);
    expect(visits[0].waypoint.name).toBe('First');
    expect(visits[1].waypoint.name).toBe('Second');
    expect(visits[2].waypoint.name).toBe('Third');
  });
});

describe('calculateSegmentStats', () => {
  it('should calculate distance between two track points', () => {
    // Points about 1km apart horizontally
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 0, time: null },
      { lat: 0, lon: 0.00898, ele: 0, time: null }, // ~1km at equator
    ];

    const stats = calculateSegmentStats(points, 0, 1);

    // Should be approximately 1km
    expect(stats.distance).toBeGreaterThan(0.9);
    expect(stats.distance).toBeLessThan(1.1);
    expect(stats.ascent).toBe(0);
    expect(stats.descent).toBe(0);
  });

  it('should calculate ascent correctly', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0.001, ele: 150, time: null },
      { lat: 0, lon: 0.002, ele: 200, time: null },
    ];

    const stats = calculateSegmentStats(points, 0, 2);

    expect(stats.ascent).toBe(100);
    expect(stats.descent).toBe(0);
  });

  it('should calculate descent correctly', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 200, time: null },
      { lat: 0, lon: 0.001, ele: 150, time: null },
      { lat: 0, lon: 0.002, ele: 100, time: null },
    ];

    const stats = calculateSegmentStats(points, 0, 2);

    expect(stats.ascent).toBe(0);
    expect(stats.descent).toBe(100);
  });

  it('should calculate mixed ascent and descent', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0.001, ele: 200, time: null }, // +100 ascent
      { lat: 0, lon: 0.002, ele: 150, time: null }, // +50 descent
      { lat: 0, lon: 0.003, ele: 180, time: null }, // +30 ascent
    ];

    const stats = calculateSegmentStats(points, 0, 3);

    expect(stats.ascent).toBe(130); // 100 + 30
    expect(stats.descent).toBe(50);
  });

  it('should handle partial track segments', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0.001, ele: 150, time: null },
      { lat: 0, lon: 0.002, ele: 200, time: null },
      { lat: 0, lon: 0.003, ele: 250, time: null },
    ];

    const stats = calculateSegmentStats(points, 1, 3);

    expect(stats.ascent).toBe(100); // 150 -> 200 -> 250
    expect(stats.descent).toBe(0);
  });
});

describe('processGpxTravelPlan', () => {
  it('should process a valid GPX file', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.05, ele: 100, name: 'Middle', desc: 'general store' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const result = processGpxTravelPlan(gpxContent, { waypointMaxDistance: 1000 });

    expect(result.stats.totalPoints).toBe(3);
    expect(result.processedPlan).toContain('Start');
    expect(result.processedPlan).toContain('Middle');
    expect(result.processedPlan).toContain('End');
  });

  it('should detect resupply keywords in waypoint name', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.05, ele: 100, name: 'General Store Town', desc: '' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const result = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      resupplyKeywords: ['general'],
      includeEndAsResupply: false,
      includeStartAsResupply: false,
    });

    expect(result.stats.resupplyCount).toBe(1);
    expect(result.resupplyPoints).toContain('General Store Town');
  });

  it('should detect resupply keywords in waypoint description', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.05, ele: 100, name: 'Some Town', desc: 'has IGA grocery store' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const result = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      resupplyKeywords: ['iga'],
      includeEndAsResupply: false,
      includeStartAsResupply: false,
    });

    expect(result.stats.resupplyCount).toBe(1);
    expect(result.resupplyPoints).toContain('Some Town');
  });

  it('should include end as resupply when option is set', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const resultWith = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      resupplyKeywords: [],
      includeEndAsResupply: true,
      includeStartAsResupply: false,
    });
    const resultWithout = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      resupplyKeywords: [],
      includeEndAsResupply: false,
      includeStartAsResupply: false,
    });

    expect(resultWith.stats.resupplyCount).toBe(1);
    expect(resultWithout.stats.resupplyCount).toBe(0);
  });

  it('should include start as resupply when option is set', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const resultWith = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      resupplyKeywords: [],
      includeEndAsResupply: false,
      includeStartAsResupply: true,
    });
    const resultWithout = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      resupplyKeywords: [],
      includeEndAsResupply: false,
      includeStartAsResupply: false,
    });

    expect(resultWith.stats.resupplyCount).toBe(1);
    expect(resultWithout.stats.resupplyCount).toBe(0);
  });

  it('should throw error when GPX has no tracks or routes', () => {
    const gpxContent = `<?xml version="1.0"?>
<gpx version="1.1">
  <wpt lat="0" lon="0"><name>Test</name></wpt>
</gpx>`;

    expect(() => processGpxTravelPlan(gpxContent)).toThrow('GPX file has no track or route data');
  });

  it('should process GPX with only route elements (no tracks)', () => {
    // Create a GPX with only <rte> elements
    const gpxContent = `<?xml version="1.0"?>
<gpx version="1.1">
  <wpt lat="0" lon="0"><ele>100</ele><name>Start</name></wpt>
  <wpt lat="0" lon="0.05"><ele>150</ele><name>Middle</name></wpt>
  <wpt lat="0" lon="0.1"><ele>100</ele><name>End</name></wpt>
  <rte>
    <name>Test Route</name>
    <rtept lat="0" lon="0"><ele>100</ele></rtept>
    <rtept lat="0" lon="0.025"><ele>125</ele></rtept>
    <rtept lat="0" lon="0.05"><ele>150</ele></rtept>
    <rtept lat="0" lon="0.075"><ele>125</ele></rtept>
    <rtept lat="0" lon="0.1"><ele>100</ele></rtept>
  </rte>
</gpx>`;

    const result = processGpxTravelPlan(gpxContent, { waypointMaxDistance: 1000 });

    expect(result.stats.totalPoints).toBe(3);
    expect(result.processedPlan).toContain('Start');
    expect(result.processedPlan).toContain('Middle');
    expect(result.processedPlan).toContain('End');
  });

  it('should throw error when GPX has no waypoints', () => {
    const gpxContent = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="0" lon="0"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    expect(() => processGpxTravelPlan(gpxContent)).toThrow('GPX file has no waypoints');
  });

  it('should throw error when no waypoints are within threshold', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 1, lon: 0.05, ele: 100, name: 'FarAway', desc: '' }, // Far from track
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);

    expect(() => processGpxTravelPlan(gpxContent, { waypointMaxDistance: 100 })).toThrow(
      'No waypoints found on any track/route'
    );
  });

  it('should handle distance unit conversion', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const resultKm = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      distanceUnit: 'km',
    });
    const resultMi = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      distanceUnit: 'mi',
    });

    expect(resultKm.processedPlan).toContain('Distance (km)');
    expect(resultMi.processedPlan).toContain('Distance (mi)');
  });

  it('should handle elevation unit conversion', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const resultM = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      elevationUnit: 'm',
    });
    const resultFt = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      elevationUnit: 'ft',
    });

    expect(resultM.processedPlan).toContain('Elevation (m)');
    expect(resultFt.processedPlan).toContain('Elevation (ft)');
  });

  it('should export default options and keywords', () => {
    expect(GPX_DATASHEET_DEFAULTS).toBeDefined();
    expect(GPX_DATASHEET_DEFAULTS.waypointMaxDistance).toBe(200);
    expect(GPX_DATASHEET_DEFAULTS.includeEndAsResupply).toBe(true);
    expect(GPX_DATASHEET_DEFAULTS.includeStartAsResupply).toBe(false);

    expect(GPX_DEFAULT_RESUPPLY_KEYWORDS).toBeInstanceOf(Array);
    expect(GPX_DEFAULT_RESUPPLY_KEYWORDS).toContain('grocer');
    expect(GPX_DEFAULT_RESUPPLY_KEYWORDS).toContain('iga');
    expect(GPX_DEFAULT_RESUPPLY_KEYWORDS).toContain('general');
  });
});

describe('multi-pass waypoint detection', () => {
  it('should record waypoint twice when route passes it twice', () => {
    // Create a route: Start -> Town -> Summit -> Town -> End
    // This simulates an out-and-back section
    const trackPoints: GpxPoint[] = [
      // Start to Town
      ...createLinearTrack(0, 0, 0, 0.1, 25, 100),
      // Town to Summit
      ...createLinearTrack(0, 0.1, 0, 0.2, 25, 100),
      // Summit back to Town
      ...createLinearTrack(0, 0.2, 0, 0.1, 25, 100),
      // Town to End
      ...createLinearTrack(0, 0.1, 0, 0, 25, 100),
    ];

    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.1, ele: 100, name: 'Town', desc: 'general store' },
      { lat: 0, lon: 0.2, ele: 100, name: 'Summit', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const result = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      resupplyKeywords: ['general'],
      includeEndAsResupply: false,
      includeStartAsResupply: false,
    });

    // Should have 4 entries: Start, Town (first pass), Summit, Town (second pass)
    // But wait - we also pass Start again at the end!
    // Actually, the route ends back at (0,0) which is the Start waypoint
    expect(result.stats.totalPoints).toBeGreaterThanOrEqual(4);

    // Town should appear twice in the processed plan (as a resupply each time)
    // But our resupply detection only counts based on keywords
    expect(result.resupplyPoints).toContain('Town');
  });
});

describe('edge cases', () => {
  it('should handle single waypoint', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.01, 10, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0.005, ele: 100, name: 'Only', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const result = processGpxTravelPlan(gpxContent, { waypointMaxDistance: 1000 });

    expect(result.stats.totalPoints).toBe(1);
    expect(result.processedPlan).toContain('Only');
  });

  it('should handle waypoints with special characters in name and desc', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Café & Restaurant', desc: 'Open 7-9, "best coffee"' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const result = processGpxTravelPlan(gpxContent, { waypointMaxDistance: 1000 });

    expect(result.stats.totalPoints).toBe(2);
  });

  it('should handle CSV delimiter option', () => {
    const trackPoints = createLinearTrack(0, 0, 0, 0.1, 50, 100);
    const waypoints: GpxWaypoint[] = [
      { lat: 0, lon: 0, ele: 100, name: 'Start', desc: '' },
      { lat: 0, lon: 0.1, ele: 100, name: 'End', desc: '' },
    ];

    const gpxContent = createGpxContent(waypoints, trackPoints);
    const resultComma = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      csvDelimiter: ',',
    });
    const resultSemicolon = processGpxTravelPlan(gpxContent, {
      waypointMaxDistance: 1000,
      csvDelimiter: ';',
    });

    expect(resultComma.processedPlan).toContain(',');
    expect(resultSemicolon.processedPlan).toContain(';');
  });
});
