import { describe, it, expect } from 'vitest';
import {
  compareRoutes,
  exportComparisonToCSV,
  calculateRouteStats,
  type RoutePoint,
} from './route-comparison';

describe('compareRoutes', () => {
  // Helper to create a straight-line route along the equator.
  // Each 0.001 degree of longitude at lat 0 is ~111m.
  function createLine(
    startLat: number,
    startLon: number,
    numPoints: number,
    latStep = 0,
    lonStep = 0.001,
    ele = 100
  ): RoutePoint[] {
    return Array.from({ length: numPoints }, (_, i) => ({
      lat: startLat + i * latStep,
      lon: startLon + i * lonStep,
      ele,
    }));
  }

  it('should report ~100% shared for identical routes', () => {
    const route = createLine(0, 0, 100);
    const comparison = compareRoutes(route, [...route]);

    expect(comparison.sharedPercentage).toBeGreaterThan(99.9);
    expect(comparison.sharedDistance).toBeCloseTo(comparison.route1Stats.totalDistance, 6);
    expect(comparison.sharedSegments).toHaveLength(1);
    expect(comparison.route1OnlySegments).toHaveLength(0);
    expect(comparison.route2OnlySegments).toHaveLength(0);
    expect(comparison.distanceDiff).toBeCloseTo(0, 6);
  });

  it('should report 0% shared for fully disjoint routes', () => {
    const route1 = createLine(0, 0, 100);
    // Route 2 is ~111 km north - far beyond the proximity threshold
    const route2 = createLine(1, 0, 100);

    const comparison = compareRoutes(route1, route2);

    expect(comparison.sharedDistance).toBe(0);
    expect(comparison.sharedPercentage).toBe(0);
    expect(comparison.sharedSegments).toHaveLength(0);
    expect(comparison.route1OnlySegments).toHaveLength(1);
    expect(comparison.route1OnlySegments[0].startIndex).toBe(0);
    expect(comparison.route1OnlySegments[0].endIndex).toBe(99);
    expect(comparison.route2OnlySegments).toHaveLength(1);
  });

  it('should detect partial overlap with a sensible shared distance', () => {
    // Route 1: 100 points along the equator (~11 km)
    const route1 = createLine(0, 0, 100);
    // Route 2: identical first half, second half offset ~5.5 km north
    const route2 = [
      ...createLine(0, 0, 50),
      ...createLine(0.05, 0.05, 50),
    ];

    const comparison = compareRoutes(route1, route2);

    // Roughly half the route is shared
    expect(comparison.sharedPercentage).toBeGreaterThan(40);
    expect(comparison.sharedPercentage).toBeLessThan(60);
    expect(comparison.sharedSegments).toHaveLength(1);
    expect(comparison.sharedSegments[0].startIndex).toBe(0);
    expect(comparison.route1OnlySegments).toHaveLength(1);
    expect(comparison.divergencePoints).toHaveLength(1);
  });

  it('should detect reconvergence beyond the 200-point search window (regression)', () => {
    // Shared section A: 50 points along the equator
    const sharedA = createLine(0, 0, 50);
    // Shared section B: 50 points further along the equator
    const sharedB = createLine(0, 0.071, 50);

    // Route 1: A, a short 20-point detour ~5.5 km north, then B
    const route1 = [
      ...sharedA,
      ...createLine(0.05, 0.051, 20),
      ...sharedB,
    ];

    // Route 2: A, a LONG 300-point detour ~5.5 km south, then B.
    // B starts at route2 index 350 - more than 200 points past the last
    // match anchor (index 49), which the old fixed search window never saw.
    const route2 = [
      ...sharedA,
      ...createLine(-0.05, 0.05, 300, 0, 0.0002),
      ...sharedB,
    ];

    const comparison = compareRoutes(route1, route2);

    // Both A (~5.5 km) and B (~5.5 km) must be detected as shared
    expect(comparison.sharedSegments).toHaveLength(2);
    expect(comparison.sharedDistance).toBeGreaterThan(9);
    // The second shared segment is section B, well past the detour
    expect(comparison.sharedSegments[1].startDist).toBeGreaterThan(6);
    // The convergence point maps into route2 beyond its long detour
    expect(comparison.convergencePoints).toHaveLength(1);
    expect(comparison.convergencePoints[0].route2Index).toBeGreaterThanOrEqual(350);
    // Route 2's long detour is its only unique segment
    expect(comparison.route2OnlySegments).toHaveLength(1);
  });

  it('should calculate route stats including elevation', () => {
    const points: RoutePoint[] = [
      { lat: 0, lon: 0, ele: 100 },
      { lat: 0, lon: 0.01, ele: 150 },
      { lat: 0, lon: 0.02, ele: 120 },
    ];

    const stats = calculateRouteStats(points);

    expect(stats.pointCount).toBe(3);
    expect(stats.totalAscent).toBe(50);
    expect(stats.totalDescent).toBe(30);
    expect(stats.minElevation).toBe(100);
    expect(stats.maxElevation).toBe(150);
    expect(stats.totalDistance).toBeCloseTo(2.226, 1);
  });

  it('should handle empty routes in stats', () => {
    const stats = calculateRouteStats([]);

    expect(stats.pointCount).toBe(0);
    expect(stats.totalDistance).toBe(0);
  });
});

describe('exportComparisonToCSV', () => {
  it('should include the summary metrics and per-segment table', () => {
    const route1 = Array.from({ length: 100 }, (_, i) => ({ lat: 0, lon: i * 0.001, ele: 100 }));
    const route2 = [
      ...Array.from({ length: 50 }, (_, i) => ({ lat: 0, lon: i * 0.001, ele: 100 })),
      ...Array.from({ length: 50 }, (_, i) => ({ lat: 0.05, lon: 0.05 + i * 0.001, ele: 100 })),
    ];

    const comparison = compareRoutes(route1, route2);
    const csv = exportComparisonToCSV(comparison);
    const lines = csv.split('\n');

    // Summary table
    expect(lines[0]).toBe('Metric,Route 1,Route 2,Difference');
    expect(csv).toContain('Distance (km)');
    expect(csv).toContain('Ascent (m)');
    expect(csv).toContain('Shared Distance (km)');
    expect(csv).toContain('Shared Percentage');
    expect(csv).toContain('%');

    // Per-segment table
    expect(csv).toContain('Segment Type,Segment #,Start (km),End (km),Length (km),Points');
    expect(lines.some(l => l.startsWith('Shared,1,'))).toBe(true);
    expect(lines.some(l => l.startsWith('Route 1 Only,1,'))).toBe(true);
    expect(lines.some(l => l.startsWith('Route 2 Only,1,'))).toBe(true);
    expect(csv).not.toContain('NaN');
  });
});

describe('compareRoutes with a zero-length route', () => {
  it('reports 0% shared rather than NaN', () => {
    const comparison = compareRoutes([{ lat: 0, lon: 0 }], [{ lat: 0, lon: 0 }]);
    expect(comparison.sharedPercentage).toBe(0);
  });
});

describe('compareRoutes measures to the line, not the vertices', () => {
  // Same 11 km straight line: one with a point every ~1.1 km, one every ~11 m.
  const sparse = Array.from({ length: 11 }, (_, i) => ({ lat: 0, lon: i * 0.01 }));
  const dense = Array.from({ length: 1001 }, (_, i) => ({ lat: 0, lon: i * 0.0001 }));

  it('treats a sparse and a dense recording of one route as fully shared', () => {
    const comparison = compareRoutes(sparse, dense);
    expect(comparison.sharedPercentage).toBeGreaterThan(99.9);
    expect(comparison.route1OnlySegments).toHaveLength(0);
    expect(comparison.route2OnlySegments).toHaveLength(0);
  });

  it('gives the same answer whichever file is route 1', () => {
    const comparison = compareRoutes(dense, sparse);
    expect(comparison.sharedPercentage).toBeGreaterThan(99.9);
    expect(comparison.route1OnlySegments).toHaveLength(0);
    expect(comparison.route2OnlySegments).toHaveLength(0);
  });

  it('matches a sparse route offset beside the line only within the threshold', () => {
    const offset = (meters: number) => sparse.map(p => ({ lat: meters / 111195, lon: p.lon }));
    expect(compareRoutes(offset(60), dense).sharedPercentage).toBeGreaterThan(99.9);
    expect(compareRoutes(offset(140), dense).sharedPercentage).toBe(0);
  });

  it('handles single-point and empty routes', () => {
    expect(compareRoutes([{ lat: 0, lon: 0.05 }], dense).route2OnlySegments.length).toBeGreaterThan(0);
    expect(compareRoutes([], dense).sharedSegments).toHaveLength(0);
    expect(compareRoutes(dense, []).sharedPercentage).toBe(0);
  });

  it('works across the antimeridian', () => {
    const a = Array.from({ length: 200 }, (_, i) => ({ lat: -17, lon: 179.9 + i * 0.001 }))
      .map(p => ({ lat: p.lat, lon: p.lon > 180 ? p.lon - 360 : p.lon }));
    const b = a.map(p => ({ lat: p.lat + 0.0002, lon: p.lon }));
    expect(compareRoutes(a, b).sharedPercentage).toBeGreaterThan(99.9);
  });
});

describe('compareRoutes against a brute-force reference', () => {
  // Deterministic pseudo-random wiggly routes that cross and run alongside each other.
  function lcg(seed: number) {
    let s = seed;
    return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  }
  function wander(seed: number, n: number, lat0: number, lon0: number) {
    const rnd = lcg(seed);
    const pts = [{ lat: lat0, lon: lon0 }];
    for (let i = 1; i < n; i++) {
      const step = rnd() < 0.05 ? 0.004 : 0.0004; // the odd long leg
      pts.push({
        lat: pts[i - 1].lat + (rnd() - 0.5) * step,
        lon: pts[i - 1].lon + rnd() * step,
      });
    }
    return pts;
  }
  // Point-to-segment distance in metres, every segment, no index.
  function bruteDistance(p: { lat: number; lon: number }, line: { lat: number; lon: number }[]) {
    const M = (Math.PI / 180) * 6371000;
    const c = Math.cos((p.lat * Math.PI) / 180);
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
      const ax = (line[i].lon - p.lon) * c * M;
      const ay = (line[i].lat - p.lat) * M;
      const dx = (line[i + 1].lon - line[i].lon) * c * M;
      const dy = (line[i + 1].lat - line[i].lat) * M;
      const len = dx * dx + dy * dy;
      const t = len > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }

  it.each([[55, 0.1], [61, 0.03], [68, 0.5]])('lat %i, threshold %f km', (lat, threshold) => {
    const route1 = wander(1, 600, lat, 10);
    const route2 = wander(2, 900, lat + 0.0003, 10);
    // minSegmentLength 0 so every run of shared points is reported.
    const comparison = compareRoutes(route1, route2, {
      proximityThreshold: threshold,
      minSegmentLength: 0,
    });

    const sharedFromSegments = new Array(route1.length).fill(false);
    for (const seg of comparison.sharedSegments) {
      for (let i = seg.startIndex; i <= seg.endIndex; i++) sharedFromSegments[i] = true;
    }
    const expected = route1.map(p => bruteDistance(p, route2) <= threshold * 1000);
    expect(sharedFromSegments).toEqual(expected);
  });
});

describe('compareRoutes performance', () => {
  it('compares two 50k-point routes that never meet without scanning one per point', () => {
    const route1 = Array.from({ length: 50000 }, (_, i) => ({ lat: 40, lon: i * 0.0001 }));
    const route2 = Array.from({ length: 50000 }, (_, i) => ({ lat: 40.05, lon: i * 0.0001 }));

    const started = Date.now();
    const comparison = compareRoutes(route1, route2);
    const elapsed = Date.now() - started;

    expect(comparison.sharedPercentage).toBe(0);
    // The old windowed search fell back to a full scan every sixth point here
    // (hundreds of millions of haversines, tens of seconds).
    expect(elapsed).toBeLessThan(3000);
  });
});
