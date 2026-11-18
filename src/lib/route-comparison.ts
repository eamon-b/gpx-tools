/**
 * Route Comparison Module
 *
 * Provides utilities for comparing two or more GPX routes to identify
 * differences, overlaps, and alternative path options.
 */

import { EARTH_RADIUS_METERS, haversineDistance as haversineDistanceMeters } from './distance.js';

/** Calculate haversine distance in km (wrapper for shared function that returns meters) */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
}

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
  proximityThreshold?: number; // km - how close a point must be to the other route's line to be "shared"
  minSegmentLength?: number;   // km - minimum length to count as a segment
  sampleStep?: number;         // sample every N points for performance
}

const DEFAULT_OPTIONS: ComparisonOptions = {
  proximityThreshold: 0.1, // 100m
  minSegmentLength: 0.5,   // 500m
  sampleStep: 1,
};


/**
 * Add cumulative distance to route points
 */
function addCumulativeDistance(points: RoutePoint[]): RoutePoint[] {
  let totalDist = 0;

  return points.map((point, i, arr) => {
    if (i > 0) {
      const prev = arr[i - 1];
      totalDist += haversineDistanceKm(prev.lat, prev.lon, point.lat, point.lon);
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

    totalDistance += haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);

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

const METERS_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_METERS;

/** Beyond this latitude the segment grid is not trusted; see `createPolylineIndex`. */
const POLAR_LATITUDE = 85;

/** Normalise a longitude difference into [-180, 180] so antimeridian routes work. */
function wrapLonDelta(dLon: number): number {
  let d = dLon;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** Where on a polyline the nearest point to a query lies. */
interface PolylineHit {
  /** Distance from the query point to the polyline, km. */
  distance: number;
  /** Index i of the segment (i, i + 1) carrying the nearest point. */
  segmentIndex: number;
  /** Position along that segment, 0..1. */
  t: number;
  /** The nearer vertex of that segment. */
  vertexIndex: number;
}

interface PolylineIndex {
  /**
   * Nearest point of the polyline within `radiusMeters` of a location, or
   * null when the whole polyline is further away than that.
   */
  nearest(lat: number, lon: number, radiusMeters: number): PolylineHit | null;
}

/**
 * Spatial index over the SEGMENTS of a polyline, for "how far is this point
 * from that route?" queries.
 *
 * Two things matter here. Distance is measured to the line between vertices,
 * not to the vertices: a route planned with a point every kilometre passes
 * within metres of a recorded track without any of its vertices being near
 * one of the track's, and vertex-to-vertex matching then reports the two as
 * different routes. And the lookup is a grid, so a query only touches the
 * segments in the cells around it instead of scanning the route: comparing
 * two 50k-point files is 100k cheap lookups rather than billions of
 * haversines.
 *
 * Cells are `cellMeters` on a side in latitude and at least that wide in
 * longitude (sized at the route's highest latitude). Segments longer than a
 * cell are registered piece by piece along their length, so a long straight
 * leg costs cells in proportion to its length, not to the area of its
 * bounding box.
 */
function createPolylineIndex(points: RoutePoint[], cellMeters: number): PolylineIndex {
  const n = points.length;
  if (n === 0) {
    return { nearest: () => null };
  }

  // A single point is a zero-length segment.
  const segmentCount = Math.max(n - 1, 1);
  const endOf = (i: number) => Math.min(i + 1, n - 1);

  // Longitudes are unwrapped along the route - each point is the previous one
  // plus the short way round to it - so the indexed coordinate is continuous
  // across the antimeridian and for a route spanning more than half the globe.
  // Wrapping each point against the first one instead would tear such a
  // route at 180 degrees from its start.
  const lon0 = points[0].lon;
  let minLat = Infinity;
  let maxAbsLat = 0;
  let minRelLon = 0;
  let maxRelLon = 0;
  const relLon = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (i > 0) relLon[i] = relLon[i - 1] + wrapLonDelta(p.lon - points[i - 1].lon);
    if (p.lat < minLat) minLat = p.lat;
    if (relLon[i] < minRelLon) minRelLon = relLon[i];
    if (relLon[i] > maxRelLon) maxRelLon = relLon[i];
    if (Math.abs(p.lat) > maxAbsLat) maxAbsLat = Math.abs(p.lat);
  }

  const cosMin = Math.max(Math.cos((maxAbsLat * Math.PI) / 180), 0.01);
  const cellLat = cellMeters / METERS_PER_DEGREE;
  const cellLon = cellMeters / (METERS_PER_DEGREE * cosMin);
  // Room for 4 million columns: far more than the planet is wide at any cell size used.
  const ROW_STRIDE = 4194304;
  const rowOf = (lat: number) => Math.floor((lat - minLat) / cellLat);
  const colOf = (rel: number) => Math.floor((rel - minRelLon) / cellLon);

  const cells = new Map<number, number[]>();
  const register = (row: number, col: number, segment: number) => {
    const key = row * ROW_STRIDE + col;
    const cell = cells.get(key);
    if (!cell) {
      cells.set(key, [segment]);
    } else if (cell[cell.length - 1] !== segment) {
      cell.push(segment);
    }
  };

  for (let i = 0; i < segmentCount; i++) {
    const a = points[i];
    const b = points[endOf(i)];
    const dLon = relLon[endOf(i)] - relLon[i];
    const length = haversineDistanceMeters(a.lat, a.lon, b.lat, b.lon);
    const pieces = Math.max(1, Math.ceil(length / cellMeters));
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces;
      const t1 = (k + 1) / pieces;
      const lat0 = a.lat + (b.lat - a.lat) * t0;
      const lat1 = a.lat + (b.lat - a.lat) * t1;
      const rel0 = relLon[i] + dLon * t0;
      const rel1 = relLon[i] + dLon * t1;
      const rowFrom = rowOf(Math.min(lat0, lat1));
      const rowTo = rowOf(Math.max(lat0, lat1));
      const colFrom = colOf(Math.min(rel0, rel1));
      const colTo = colOf(Math.max(rel0, rel1));
      for (let row = rowFrom; row <= rowTo; row++) {
        for (let col = colFrom; col <= colTo; col++) {
          register(row, col, i);
        }
      }
    }
  }

  // Marks the segments already measured by the current query.
  const seenBy = new Int32Array(segmentCount);
  let queryId = 0;

  return {
    nearest(lat: number, lon: number, radiusMeters: number): PolylineHit | null {
      queryId++;
      const cosLat = Math.cos((lat * Math.PI) / 180);
      let best = Infinity;
      let bestSegment = -1;
      let bestT = 0;

      // Exact point-to-segment distance in a local equirectangular projection
      // centred on the query point; accurate to millimetres at these ranges.
      const measure = (segment: number) => {
        if (seenBy[segment] === queryId) return;
        seenBy[segment] = queryId;
        const a = points[segment];
        const b = points[endOf(segment)];
        const ax = wrapLonDelta(a.lon - lon) * cosLat * METERS_PER_DEGREE;
        const ay = (a.lat - lat) * METERS_PER_DEGREE;
        const dx = wrapLonDelta(b.lon - a.lon) * cosLat * METERS_PER_DEGREE;
        const dy = (b.lat - a.lat) * METERS_PER_DEGREE;
        const lengthSq = dx * dx + dy * dy;
        let t = 0;
        if (lengthSq > 0) {
          t = -(ax * dx + ay * dy) / lengthSq;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
        }
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) {
          best = d;
          bestSegment = segment;
          bestT = t;
        }
      };

      const latReach = radiusMeters / METERS_PER_DEGREE;
      const lonReach = radiusMeters / (METERS_PER_DEGREE * cosMin);
      const rowFrom = rowOf(lat - latReach);
      const rowTo = rowOf(lat + latReach);

      // The query's longitude in the route's unwrapped coordinate: every turn
      // of the globe that lands within reach of the route (one, unless the
      // route itself runs more than once around).
      const baseRel = wrapLonDelta(lon - lon0);
      const turnFrom = Math.ceil((minRelLon - lonReach - baseRel) / 360);
      const turnTo = Math.floor((maxRelLon + lonReach - baseRel) / 360);
      const colRanges: [number, number][] = [];
      let cellsInReach = 0;
      for (let turn = turnFrom; turn <= turnTo; turn++) {
        const rel = baseRel + turn * 360;
        const colFrom = colOf(rel - lonReach);
        const colTo = colOf(rel + lonReach);
        colRanges.push([colFrom, colTo]);
        cellsInReach += (rowTo - rowFrom + 1) * (colTo - colFrom + 1);
      }

      // Near a pole a degree of longitude shrinks towards nothing and the
      // grid's fixed column width stops bounding distance, so measure every
      // segment there instead of trusting the cells.
      const nearPole = maxAbsLat > POLAR_LATITUDE || Math.abs(lat) + latReach > POLAR_LATITUDE;

      if (nearPole || !(cellsInReach <= cells.size)) {
        // Also the cheaper way round when the search area holds more cells
        // than the index does, or the radius is unbounded.
        for (let segment = 0; segment < segmentCount; segment++) measure(segment);
      } else {
        for (const [colFrom, colTo] of colRanges) {
          for (let row = rowFrom; row <= rowTo; row++) {
            for (let col = colFrom; col <= colTo; col++) {
              const cell = cells.get(row * ROW_STRIDE + col);
              if (cell) {
                for (const segment of cell) measure(segment);
              }
            }
          }
        }
      }

      if (bestSegment < 0 || best > radiusMeters) {
        return null;
      }
      return {
        distance: best / 1000,
        segmentIndex: bestSegment,
        t: bestT,
        vertexIndex: bestT <= 0.5 ? bestSegment : endOf(bestSegment),
      };
    },
  };
}

/**
 * Mark which points of `route` lie within `thresholdMeters` of the other
 * route's line. With `sampleStep` > 1 only every Nth point is measured and a
 * gap between two shared samples is filled in as shared.
 */
function markShared(
  route: RoutePoint[],
  other: PolylineIndex,
  thresholdMeters: number,
  sampleStep: number
): boolean[] {
  const shared: boolean[] = new Array(route.length).fill(false);
  // Every Nth point, and always the last: stopping at the final multiple of
  // the step would leave the tail unmeasured and report it as not shared.
  const samples: number[] = [];
  for (let i = 0; i < route.length; i += sampleStep) samples.push(i);
  if (route.length > 0 && samples[samples.length - 1] !== route.length - 1) {
    samples.push(route.length - 1);
  }
  for (const i of samples) {
    shared[i] = other.nearest(route[i].lat, route[i].lon, thresholdMeters) !== null;
  }
  for (let k = 0; k + 1 < samples.length; k++) {
    if (shared[samples[k]] && shared[samples[k + 1]]) {
      for (let j = samples[k] + 1; j < samples[k + 1]; j++) {
        shared[j] = true;
      }
    }
  }
  return shared;
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

  // A point is shared when it lies within the threshold of the OTHER route's
  // line. Both directions are measured the same way, so the answer does not
  // depend on which file has the denser points or was uploaded first, and a
  // stretch the routes share is found wherever along the other route it is.
  const thresholdMeters = threshold * 1000;
  const sampleStep = Math.max(1, Math.floor(opts.sampleStep ?? 1));
  // Cells no smaller than the threshold keep a lookup to the 3 x 3 block
  // around the point; the 50 m floor stops a tiny threshold exploding the grid.
  const cellMeters = Math.max(thresholdMeters, 50);
  const r1Index = createPolylineIndex(r1, cellMeters);
  const r2Index = createPolylineIndex(r2, cellMeters);
  const r1Shared = markShared(r1, r2Index, thresholdMeters, sampleStep);
  const r2Shared = markShared(r2, r1Index, thresholdMeters, sampleStep);

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

  // Where route 2 is, as seen from a point of route 1. Around a transition
  // one neighbour is shared, so route 2 is no further away than the threshold
  // plus the step between the two points; search that far before falling
  // back to the whole route (which only a sampled comparison can need).
  const locateOnRoute2 = (i: number) => {
    const here = r1[i];
    const before = r1[i - 1];
    const reach =
      thresholdMeters +
      haversineDistanceMeters(before.lat, before.lon, here.lat, here.lon) +
      1;
    const hit =
      r2Index.nearest(here.lat, here.lon, reach) ??
      r2Index.nearest(here.lat, here.lon, Infinity);
    return {
      route1Index: i,
      route2Index: hit ? hit.vertexIndex : 0,
      distance: hit ? hit.distance : Infinity,
    };
  };

  for (let i = 1; i < r1.length; i++) {
    if (r1Shared[i - 1] && !r1Shared[i]) {
      divergencePoints.push(locateOnRoute2(i));
    } else if (!r1Shared[i - 1] && r1Shared[i]) {
      convergencePoints.push(locateOnRoute2(i));
    }
  }

  // Calculate shared distance
  const sharedDistance = sharedSegments.reduce((sum, seg) => sum + (seg.endDist - seg.startDist), 0);
  // A zero-length route 1 (a single point, or repeated identical points) has
  // no distance to share; 0 / 0 would put NaN in the UI and the CSV.
  const sharedPercentage =
    route1Stats.totalDistance > 0 ? (sharedDistance / route1Stats.totalDistance) * 100 : 0;

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

  const lines = [headers.join(','), ...rows.map(r => r.join(','))];

  // Per-segment table
  lines.push('');
  lines.push(['Segment Type', 'Segment #', 'Start (km)', 'End (km)', 'Length (km)', 'Points'].join(','));

  const addSegmentRows = (segments: RouteSegment[], label: string): void => {
    segments.forEach((seg, i) => {
      lines.push([
        label,
        (i + 1).toString(),
        seg.startDist.toFixed(2),
        seg.endDist.toFixed(2),
        (seg.endDist - seg.startDist).toFixed(2),
        seg.points.length.toString(),
      ].join(','));
    });
  };

  addSegmentRows(comparison.sharedSegments, 'Shared');
  addSegmentRows(comparison.route1OnlySegments, 'Route 1 Only');
  addSegmentRows(comparison.route2OnlySegments, 'Route 2 Only');

  return lines.join('\n');
}
