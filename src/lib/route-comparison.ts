/**
 * Route Comparison Module
 *
 * Provides utilities for comparing two or more GPX routes to identify
 * differences, overlaps, and alternative path options.
 */

export interface RoutePoint {
  lat: number;
  lon: number;
  ele?: number;
  dist?: number;
}

export interface RouteStats {
  totalDistance: number;
  totalAscent: number;
  totalDescent: number;
  minElevation: number;
  maxElevation: number;
  pointCount: number;
}

export interface RouteSegment {
  startIndex: number;
  endIndex: number;
  startDist: number;
  endDist: number;
  points: RoutePoint[];
  type: 'shared' | 'route1-only' | 'route2-only';
}

export interface RouteComparison {
  route1Stats: RouteStats;
  route2Stats: RouteStats;
  sharedSegments: RouteSegment[];
  route1OnlySegments: RouteSegment[];
  route2OnlySegments: RouteSegment[];
  sharedDistance: number;
  sharedPercentage: number;
  divergencePoints: { route1Index: number; route2Index: number; distance: number }[];
  convergencePoints: { route1Index: number; route2Index: number; distance: number }[];
  elevationDiff: {
    ascent: number;
    descent: number;
  };
  distanceDiff: number;
}

export interface ComparisonOptions {
  proximityThreshold?: number; // km - how close points must be to be "shared"
  minSegmentLength?: number;   // km - minimum length to count as a segment
  sampleStep?: number;         // sample every N points for performance
}

const DEFAULT_OPTIONS: ComparisonOptions = {
  proximityThreshold: 0.1, // 100m
  minSegmentLength: 0.5,   // 500m
  sampleStep: 1,
};

/**
 * Calculate haversine distance between two points in km
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Add cumulative distance to route points
 */
function addCumulativeDistance(points: RoutePoint[]): RoutePoint[] {
  let totalDist = 0;

  return points.map((point, i, arr) => {
    if (i > 0) {
      const prev = arr[i - 1];
      totalDist += haversineDistance(prev.lat, prev.lon, point.lat, point.lon);
    }
    return { ...point, dist: totalDist };
  });
}

/**
 * Calculate statistics for a route
 */
export function calculateRouteStats(points: RoutePoint[]): RouteStats {
  if (points.length === 0) {
    return {
      totalDistance: 0,
      totalAscent: 0,
      totalDescent: 0,
      minElevation: 0,
      maxElevation: 0,
      pointCount: 0,
    };
  }

  let totalDistance = 0;
  let totalAscent = 0;
  let totalDescent = 0;
  let minElevation = points[0].ele ?? 0;
  let maxElevation = points[0].ele ?? 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    totalDistance += haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);

    if (curr.ele !== undefined && prev.ele !== undefined) {
      const eleDiff = curr.ele - prev.ele;
      if (eleDiff > 0) totalAscent += eleDiff;
      else totalDescent += Math.abs(eleDiff);

      minElevation = Math.min(minElevation, curr.ele);
      maxElevation = Math.max(maxElevation, curr.ele);
    }
  }

  return {
    totalDistance,
    totalAscent,
    totalDescent,
    minElevation,
    maxElevation,
    pointCount: points.length,
  };
}

/**
 * Find the closest point on route2 to a point on route1
 */
function findClosestPoint(
  point: RoutePoint,
  route: RoutePoint[],
  startSearchIndex: number = 0,
  searchWindow: number = 100
): { index: number; distance: number } {
  let minDist = Infinity;
  let closestIndex = startSearchIndex;

  const start = Math.max(0, startSearchIndex - searchWindow);
  const end = Math.min(route.length, startSearchIndex + searchWindow);

  for (let i = start; i < end; i++) {
    const dist = haversineDistance(point.lat, point.lon, route[i].lat, route[i].lon);
    if (dist < minDist) {
      minDist = dist;
      closestIndex = i;
    }
  }

  return { index: closestIndex, distance: minDist };
}

/**
 * Compare two routes and identify shared/divergent segments
 */
export function compareRoutes(
  route1: RoutePoint[],
  route2: RoutePoint[],
  options: ComparisonOptions = {}
): RouteComparison {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const threshold = opts.proximityThreshold!;

  // Add cumulative distances
  const r1 = addCumulativeDistance(route1);
  const r2 = addCumulativeDistance(route2);

  // Calculate stats
  const route1Stats = calculateRouteStats(r1);
  const route2Stats = calculateRouteStats(r2);

  // Track which points are shared
  const r1Shared = new Array(r1.length).fill(false);
  const r2Shared = new Array(r2.length).fill(false);

  // Find shared points
  let lastR2Index = 0;
  for (let i = 0; i < r1.length; i += opts.sampleStep!) {
    const closest = findClosestPoint(r1[i], r2, lastR2Index, 200);

    if (closest.distance <= threshold) {
      r1Shared[i] = true;
      r2Shared[closest.index] = true;
      lastR2Index = closest.index;
    }
  }

  // Interpolate between sampled points
  if (opts.sampleStep! > 1) {
    for (let i = 0; i < r1.length - opts.sampleStep!; i += opts.sampleStep!) {
      if (r1Shared[i] && r1Shared[i + opts.sampleStep!]) {
        for (let j = i + 1; j < i + opts.sampleStep!; j++) {
          r1Shared[j] = true;
        }
      }
    }
  }

  // Build segments
  const sharedSegments: RouteSegment[] = [];
  const route1OnlySegments: RouteSegment[] = [];

  let segmentStart = 0;
  let inSharedSegment = r1Shared[0];

  for (let i = 1; i <= r1.length; i++) {
    const isShared = i < r1.length ? r1Shared[i] : !inSharedSegment;

    if (isShared !== inSharedSegment || i === r1.length) {
      const segmentPoints = r1.slice(segmentStart, i);
      const segmentDist = (r1[i - 1].dist || 0) - (r1[segmentStart].dist || 0);

      if (segmentDist >= opts.minSegmentLength!) {
        const segment: RouteSegment = {
          startIndex: segmentStart,
          endIndex: i - 1,
          startDist: r1[segmentStart].dist || 0,
          endDist: r1[i - 1].dist || 0,
          points: segmentPoints,
          type: inSharedSegment ? 'shared' : 'route1-only',
        };

        if (inSharedSegment) {
          sharedSegments.push(segment);
        } else {
          route1OnlySegments.push(segment);
        }
      }

      segmentStart = i;
      inSharedSegment = isShared;
    }
  }

  // Build route2-only segments
  const route2OnlySegments: RouteSegment[] = [];
  segmentStart = 0;
  let inR2Shared = r2Shared[0];

  for (let i = 1; i <= r2.length; i++) {
    const isShared = i < r2.length ? r2Shared[i] : !inR2Shared;

    if (isShared !== inR2Shared || i === r2.length) {
      const segmentPoints = r2.slice(segmentStart, i);
      const segmentDist = (r2[i - 1].dist || 0) - (r2[segmentStart].dist || 0);

      if (!inR2Shared && segmentDist >= opts.minSegmentLength!) {
        route2OnlySegments.push({
          startIndex: segmentStart,
          endIndex: i - 1,
          startDist: r2[segmentStart].dist || 0,
          endDist: r2[i - 1].dist || 0,
          points: segmentPoints,
          type: 'route2-only',
        });
      }

      segmentStart = i;
      inR2Shared = isShared;
    }
  }

  // Find divergence and convergence points
  const divergencePoints: { route1Index: number; route2Index: number; distance: number }[] = [];
  const convergencePoints: { route1Index: number; route2Index: number; distance: number }[] = [];

  for (let i = 1; i < r1.length; i++) {
    if (r1Shared[i - 1] && !r1Shared[i]) {
      // Divergence point
      const closest = findClosestPoint(r1[i], r2, 0, r2.length);
      divergencePoints.push({
        route1Index: i,
        route2Index: closest.index,
        distance: closest.distance,
      });
    } else if (!r1Shared[i - 1] && r1Shared[i]) {
      // Convergence point
      const closest = findClosestPoint(r1[i], r2, 0, r2.length);
      convergencePoints.push({
        route1Index: i,
        route2Index: closest.index,
        distance: closest.distance,
      });
    }
  }

  // Calculate shared distance
  const sharedDistance = sharedSegments.reduce((sum, seg) => sum + (seg.endDist - seg.startDist), 0);
  const sharedPercentage = (sharedDistance / route1Stats.totalDistance) * 100;

  return {
    route1Stats,
    route2Stats,
    sharedSegments,
    route1OnlySegments,
    route2OnlySegments,
    sharedDistance,
    sharedPercentage,
    divergencePoints,
    convergencePoints,
    elevationDiff: {
      ascent: route2Stats.totalAscent - route1Stats.totalAscent,
      descent: route2Stats.totalDescent - route1Stats.totalDescent,
    },
    distanceDiff: route2Stats.totalDistance - route1Stats.totalDistance,
  };
}

/**
 * Format a route comparison as a summary string
 */
export function formatComparisonSummary(comparison: RouteComparison): string {
  const lines = [
    '=== Route Comparison Summary ===',
    '',
    'Route 1:',
    `  Distance: ${comparison.route1Stats.totalDistance.toFixed(1)} km`,
    `  Ascent: ${comparison.route1Stats.totalAscent.toFixed(0)} m`,
    `  Descent: ${comparison.route1Stats.totalDescent.toFixed(0)} m`,
    '',
    'Route 2:',
    `  Distance: ${comparison.route2Stats.totalDistance.toFixed(1)} km`,
    `  Ascent: ${comparison.route2Stats.totalAscent.toFixed(0)} m`,
    `  Descent: ${comparison.route2Stats.totalDescent.toFixed(0)} m`,
    '',
    'Comparison:',
    `  Shared path: ${comparison.sharedDistance.toFixed(1)} km (${comparison.sharedPercentage.toFixed(1)}%)`,
    `  Distance difference: ${comparison.distanceDiff >= 0 ? '+' : ''}${comparison.distanceDiff.toFixed(1)} km`,
    `  Ascent difference: ${comparison.elevationDiff.ascent >= 0 ? '+' : ''}${comparison.elevationDiff.ascent.toFixed(0)} m`,
    '',
    `  Divergence points: ${comparison.divergencePoints.length}`,
    `  Convergence points: ${comparison.convergencePoints.length}`,
    `  Route 1 unique segments: ${comparison.route1OnlySegments.length}`,
    `  Route 2 unique segments: ${comparison.route2OnlySegments.length}`,
  ];

  return lines.join('\n');
}

/**
 * Export comparison to CSV format
 */
export function exportComparisonToCSV(comparison: RouteComparison): string {
  const headers = ['Metric', 'Route 1', 'Route 2', 'Difference'];

  const rows = [
    ['Distance (km)', comparison.route1Stats.totalDistance.toFixed(2), comparison.route2Stats.totalDistance.toFixed(2), (comparison.route2Stats.totalDistance - comparison.route1Stats.totalDistance).toFixed(2)],
    ['Ascent (m)', comparison.route1Stats.totalAscent.toFixed(0), comparison.route2Stats.totalAscent.toFixed(0), comparison.elevationDiff.ascent.toFixed(0)],
    ['Descent (m)', comparison.route1Stats.totalDescent.toFixed(0), comparison.route2Stats.totalDescent.toFixed(0), comparison.elevationDiff.descent.toFixed(0)],
    ['Min Elevation (m)', comparison.route1Stats.minElevation.toFixed(0), comparison.route2Stats.minElevation.toFixed(0), ''],
    ['Max Elevation (m)', comparison.route1Stats.maxElevation.toFixed(0), comparison.route2Stats.maxElevation.toFixed(0), ''],
    ['Point Count', comparison.route1Stats.pointCount.toString(), comparison.route2Stats.pointCount.toString(), ''],
    ['Shared Distance (km)', '', '', comparison.sharedDistance.toFixed(2)],
    ['Shared Percentage', '', '', comparison.sharedPercentage.toFixed(1) + '%'],
  ];

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

/**
 * Merge two routes, preferring shared segments and including alternatives
 */
export function mergeRoutes(
  route1: RoutePoint[],
  _route2: RoutePoint[],
  comparison: RouteComparison
): {
  mainRoute: RoutePoint[];
  alternatives: RouteSegment[];
} {
  // Use route1 as the base, marking route2-only segments as alternatives
  const mainRoute = [...route1];

  // The route2-only segments are already identified as alternatives
  const alternatives = comparison.route2OnlySegments;

  return { mainRoute, alternatives };
}
