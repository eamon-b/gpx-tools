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
