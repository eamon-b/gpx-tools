/**
 * OSM POI catalog, Overpass query building and route geometry.
 *
 * This module is the single source of truth for "what counts as a POI" and for
 * the Overpass QL we send. It is pure: no fetch, no DOM, no Node-only APIs, so
 * it can be imported by the browser tools, the Vercel function and Node build
 * scripts alike.
 */

import { haversineDistance, EARTH_RADIUS_METERS } from "./distance.js";
import { douglasPeucker } from "./gpx-optimizer.js";
import { escapeXml } from "./gpx-parser.js";
import type { GpxPoint } from "./types.js";

export { escapeXml };

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type POIType =
  "water" | "camping" | "resupply" | "transport" | "emergency";

export const POI_TYPES: readonly POIType[] = [
  "water",
  "camping",
  "resupply",
  "transport",
  "emergency",
] as const;

export const POI_TYPE_LABELS: Record<POIType, string> = {
  water: "Water Sources",
  camping: "Camping & Shelters",
  resupply: "Resupply (Shops & Food)",
  transport: "Transport",
  emergency: "Emergency Services",
};

/** One OSM tag rule. Generates BOTH the Overpass selector and the client-side predicate. */
export interface POITagRule {
  /** Primary tag key, e.g. 'amenity' */
  key: string;
  /** Primary tag value, e.g. 'drinking_water' */
  value: string;
  /** Extra tag conditions that must hold (key present, and if `value` given, equal). */
  require?: { key: string; value?: string }[];
  /** Tag conditions that must NOT hold. Overpass `["k"!="v"]` semantics: an absent key passes. */
  exclude?: { key: string; value: string }[];
  /**
   * Evaluated only after every non-fallback rule of every category has failed.
   * Lets a broad tag (e.g. `drinking_water=yes`) catch leftovers without stealing
   * features that a more specific category already claims.
   */
  fallback?: boolean;
}

/**
 * The catalog. Order matters: `categorizePOI` returns the first matching rule in
 * catalog order (non-fallback rules first, across all categories).
 */
export const POI_CATALOG: Record<POIType, POITagRule[]> = {
  water: [
    { key: "amenity", value: "drinking_water" },
    { key: "natural", value: "spring" },
    { key: "man_made", value: "water_tap" },
    { key: "amenity", value: "water_point" },
    // Fallback: catches toilets/fountains/campsites that happen to have a tap.
    // It must be a fallback so a cafe tagged drinking_water=yes stays "resupply".
    // (natural=water named lakes are deliberately absent: a lake is not a
    // drinking source.)
    { key: "drinking_water", value: "yes", fallback: true },
  ],
  camping: [
    { key: "tourism", value: "camp_site" },
    { key: "tourism", value: "caravan_site" },
    { key: "tourism", value: "alpine_hut" },
    { key: "tourism", value: "wilderness_hut" },
    // Bus shelters are tagged amenity=shelter too; they are transport, not camping.
    {
      key: "amenity",
      value: "shelter",
      exclude: [{ key: "shelter_type", value: "public_transport" }],
    },
  ],
  resupply: [
    { key: "shop", value: "supermarket" },
    { key: "shop", value: "convenience" },
    { key: "shop", value: "general" },
    { key: "shop", value: "kiosk" },
    { key: "shop", value: "bakery" },
    { key: "shop", value: "greengrocer" },
    { key: "shop", value: "outdoor" },
    { key: "amenity", value: "cafe" },
    { key: "amenity", value: "restaurant" },
    { key: "amenity", value: "pub" },
    { key: "amenity", value: "fast_food" },
    { key: "amenity", value: "fuel" },
    { key: "amenity", value: "post_office" },
  ],
  transport: [
    { key: "highway", value: "bus_stop" },
    { key: "railway", value: "station" },
    { key: "railway", value: "halt" },
    { key: "railway", value: "tram_stop" },
    { key: "amenity", value: "ferry_terminal" },
  ],
  emergency: [
    { key: "amenity", value: "hospital" },
    { key: "amenity", value: "clinic" },
    { key: "amenity", value: "doctors" },
    { key: "amenity", value: "pharmacy" },
    { key: "amenity", value: "police" },
    { key: "amenity", value: "fire_station" },
    { key: "amenity", value: "ranger_station" },
    { key: "emergency", value: "phone" },
  ],
};

/** Does a tag set satisfy a single rule (primary tag + require + exclude)? */
function ruleMatches(tags: Record<string, string>, rule: POITagRule): boolean {
  if (tags[rule.key] !== rule.value) {
    return false;
  }
  for (const req of rule.require ?? []) {
    const actual = tags[req.key];
    if (actual === undefined) {
      return false;
    }
    if (req.value !== undefined && actual !== req.value) {
      return false;
    }
  }
  for (const exc of rule.exclude ?? []) {
    // Overpass `["k"!="v"]` semantics: an absent key passes the filter.
    if (tags[exc.key] === exc.value) {
      return false;
    }
  }
  return true;
}

/**
 * Classify a feature from its OSM tags.
 *
 * Two passes: every non-fallback rule of every category first (catalog order),
 * then the fallback rules. That is what keeps `amenity=cafe` + `drinking_water=yes`
 * classified as resupply while `amenity=toilets` + `drinking_water=yes` becomes water.
 */
export function categorizePOI(tags: Record<string, string>): POIType | null {
  if (!tags) {
    return null;
  }
  for (const type of POI_TYPES) {
    for (const rule of POI_CATALOG[type]) {
      if (!rule.fallback && ruleMatches(tags, rule)) {
        return type;
      }
    }
  }
  for (const type of POI_TYPES) {
    for (const rule of POI_CATALOG[type]) {
      if (rule.fallback && ruleMatches(tags, rule)) {
        return type;
      }
    }
  }
  return null;
}

/** Human-readable name for a POI, derived from tags when `name` is absent. */
export function getPOIName(poi: { tags: Record<string, string> }): string {
  const tags = poi.tags ?? {};

  if (tags.name) {
    return tags.name;
  }

  const type =
    tags.amenity ||
    tags.tourism ||
    tags.shop ||
    tags.natural ||
    tags.man_made ||
    tags.highway ||
    tags.railway;
  if (type) {
    return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return "Unknown POI";
}

/** Human-readable description assembled from the informative tags a hiker cares about. */
export function getPOIDescription(poi: {
  tags: Record<string, string>;
}): string {
  const tags = poi.tags ?? {};
  const parts: string[] = [];

  if (tags.description) {
    parts.push(tags.description);
  }
  if (tags.opening_hours) {
    parts.push(`Hours: ${tags.opening_hours}`);
  }
  if (tags.phone) {
    parts.push(`Phone: ${tags.phone}`);
  }
  if (tags.website) {
    parts.push(`Web: ${tags.website}`);
  }
  if (tags.capacity) {
    parts.push(`Capacity: ${tags.capacity}`);
  }
  if (tags.fee) {
    parts.push(tags.fee === "yes" ? "Fee required" : "Free");
  }

  return parts.join(" | ") || "No additional information";
}

// ---------------------------------------------------------------------------
// Areas and query building
// ---------------------------------------------------------------------------

export interface LatLon {
  lat: number;
  lon: number;
}
export interface BBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

/** Either a bbox or a polyline corridor. Corridor is the preferred mode. */
export type OverpassArea =
  { bounds: BBox } | { corridor: LatLon[]; radiusMeters: number };

export interface OverpassQueryOptions {
  /** Overpass `[timeout:]` value in seconds. Default 22. */
  timeoutSeconds?: number;
}

/** Round to 4 decimal places (~11 m) so query text and cache keys agree. */
export function roundCoord(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Format a rounded coordinate without exponent notation or trailing noise. */
function fmtCoord(x: number): string {
  return String(roundCoord(x));
}

/** Escape a tag value for use inside an Overpass regex alternation. */
function escapeRegexValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape a tag key/value for use inside an Overpass `["k"="v"]` literal. */
function escapeLiteral(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

/** The `(around:...)` or `(s,w,n,e)` suffix every statement in the query carries. */
function areaFilter(area: OverpassArea): string {
  if ("corridor" in area) {
    const coords = area.corridor
      .map((p) => `${fmtCoord(p.lat)},${fmtCoord(p.lon)}`)
      .join(",");
    return `(around:${area.radiusMeters},${coords})`;
  }
  const b = area.bounds;
  return `(${fmtCoord(b.south)},${fmtCoord(b.west)},${fmtCoord(b.north)},${fmtCoord(b.east)})`;
}

/** Render the tag selector part (`["k"="v"]...`) for one rule. */
function ruleSelector(rule: POITagRule): string {
  let out = `["${escapeLiteral(rule.key)}"="${escapeLiteral(rule.value)}"]`;
  for (const req of rule.require ?? []) {
    out +=
      req.value === undefined
        ? `["${escapeLiteral(req.key)}"]`
        : `["${escapeLiteral(req.key)}"="${escapeLiteral(req.value)}"]`;
  }
  for (const exc of rule.exclude ?? []) {
    out += `["${escapeLiteral(exc.key)}"!="${escapeLiteral(exc.value)}"]`;
  }
  return out;
}

/**
 * Build the Overpass QL for an area and a set of POI types.
 *
 * Uses `nwr` (node/way/relation) + `out center;` so mapped-as-area features
 * (a supermarket building, a campsite polygon) come back with a usable point.
 *
 * Plain rules sharing a tag key are unioned into one regex statement — Overpass
 * evaluates far fewer statements that way, e.g.
 *   `nwr["amenity"~"^(drinking_water|water_point)$"](around:2000,...);`
 * Rules with require/exclude conditions get their own statement, e.g.
 *   `nwr["amenity"="shelter"]["shelter_type"!="public_transport"](around:...);`
 */
export function buildOverpassQuery(
  area: OverpassArea,
  types: POIType[],
  opts: OverpassQueryOptions = {}
): string {
  const timeout = opts.timeoutSeconds ?? 22;
  const filter = areaFilter(area);
  const statements: string[] = [];
  const seen = new Set<string>();

  const push = (selector: string) => {
    const stmt = `  nwr${selector}${filter};`;
    if (!seen.has(stmt)) {
      seen.add(stmt);
      statements.push(stmt);
    }
  };

  for (const type of types) {
    const rules = POI_CATALOG[type];
    if (!rules) {
      continue;
    }
    // Group the plain rules of this type by tag key, preserving catalog order.
    const groups = new Map<string, string[]>();
    for (const rule of rules) {
      if (rule.require?.length || rule.exclude?.length) {
        continue;
      }
      const values = groups.get(rule.key);
      if (values) {
        if (!values.includes(rule.value)) {
          values.push(rule.value);
        }
      } else {
        groups.set(rule.key, [rule.value]);
      }
    }
    for (const [key, values] of groups) {
      if (values.length === 1) {
        push(`["${escapeLiteral(key)}"="${escapeLiteral(values[0])}"]`);
      } else {
        push(
          `["${escapeLiteral(key)}"~"^(${values.map(escapeRegexValue).join("|")})$"]`
        );
      }
    }
    // Conditional rules cannot be folded into a regex union.
    for (const rule of rules) {
      if (rule.require?.length || rule.exclude?.length) {
        push(ruleSelector(rule));
      }
    }
  }

  return `[out:json][timeout:${timeout}];\n(\n${statements.join("\n")}\n);\nout center;`;
}

// ---------------------------------------------------------------------------
// Overpass element normalisation
// ---------------------------------------------------------------------------

export interface OverpassElement {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: LatLon;
  tags?: Record<string, string>;
}

export interface POI {
  id: number;
  type: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

/**
 * Stable identity for a POI. Node, way and relation ids live in separate id
 * spaces and DO collide, so the element type has to be part of the key.
 */
export function poiKey(poi: { type: string; id: number }): string {
  return `${poi.type}/${poi.id}`;
}

/**
 * Flatten raw Overpass elements into POIs. Ways/relations carry their point in
 * `center` (from `out center;`). Elements without usable coordinates are
 * dropped. Does NOT dedupe — callers merging several chunks do that by poiKey.
 */
export function normalizeOverpassElements(
  elements: OverpassElement[] | undefined
): POI[] {
  if (!Array.isArray(elements)) {
    return [];
  }
  const out: POI[] = [];
  for (const el of elements) {
    if (!el) {
      continue;
    }
    // `??` not `||`: lat/lon of 0 is a real coordinate on the equator/meridian.
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      continue;
    }
    out.push({
      id: el.id,
      type: el.type,
      lat,
      lon,
      tags: el.tags ?? {},
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corridor preparation
// ---------------------------------------------------------------------------

/** Validation limits shared by client and server. */
export const CORRIDOR_LIMITS = {
  maxVertices: 400,
  maxRadiusMeters: 10000,
  maxBBoxDegrees: 1.5,
} as const satisfies {
  maxVertices: number;
  maxRadiusMeters: number;
  maxBBoxDegrees: number;
};

/** Accept both `LatLon[]` and `LatLon[][]`, always returning the nested form. */
function toPolylines(route: LatLon[] | LatLon[][]): LatLon[][] {
  if (route.length === 0) {
    return [];
  }
  return Array.isArray(route[0]) ? (route as LatLon[][]) : [route as LatLon[]];
}

function isFinitePoint(p: LatLon | undefined): p is LatLon {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180
  );
}

/**
 * Prepare `around:` polylines for querying.
 *
 * Each polyline is simplified with Douglas-Peucker at `radiusMeters / 4` — a
 * quarter of the search radius keeps the corridor's shape well inside the
 * radius while cutting a dense GPS track down by one to two orders of
 * magnitude, which is what keeps the Overpass query small enough to run.
 *
 * Consecutive polylines whose join gap is at most `joinGapMeters` (default
 * 2 x radius) are concatenated into one corridor. A recorded GPX is routinely
 * split into many `<trkseg>`s at rest stops, and querying each as its own
 * Overpass request would multiply the request count for no gain: the phantom
 * connector only over-fetches a stretch no longer than the gap, and the exact
 * distance filter runs on the real geometry afterwards. Polylines that start
 * far from where the previous one ended (a side trip branching mid-trail) stay
 * separate, because a long connector would over-fetch a long corridor.
 *
 * The result is then split into chunks of at most `maxVertices` vertices that
 * overlap by one vertex, so no piece of the corridor falls between chunks.
 * A single-vertex chunk is still a valid `around:` (a circle around a point).
 */
export function buildCorridorChunks(
  route: LatLon[] | LatLon[][],
  radiusMeters: number,
  maxVertices = 300,
  joinGapMeters = radiusMeters * 2
): LatLon[][] {
  const limit = Math.max(1, Math.floor(maxVertices));
  const tolerance = Math.max(1, radiusMeters / 4);

  // Simplify each polyline, then join near-contiguous neighbours.
  const joined: LatLon[][] = [];
  for (const polyline of toPolylines(route)) {
    const clean = polyline.filter(isFinitePoint);
    if (clean.length === 0) {
      continue;
    }

    // douglasPeucker works on GpxPoint; ele/time are irrelevant to the 2D simplification.
    const asGpx: GpxPoint[] = clean.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      ele: 0,
      time: null,
    }));
    const simplified = douglasPeucker(asGpx, tolerance).map((p) => ({
      lat: p.lat,
      lon: p.lon,
    }));

    const previous = joined[joined.length - 1];
    if (previous) {
      const tail = previous[previous.length - 1];
      const gap = haversineDistance(tail.lat, tail.lon, simplified[0].lat, simplified[0].lon);
      if (gap <= joinGapMeters) {
        previous.push(...simplified);
        continue;
      }
    }
    joined.push(simplified);
  }

  const chunks: LatLon[][] = [];
  for (const simplified of joined) {
    if (simplified.length <= limit) {
      chunks.push(simplified);
      continue;
    }

    // Overlap by one vertex so the segment straddling a chunk boundary is
    // still covered by the `around:` corridor of both chunks.
    for (let start = 0; start < simplified.length - 1; start += limit - 1) {
      chunks.push(simplified.slice(start, start + limit));
    }
  }

  return chunks;
}

/**
 * Validate an area from untrusted JSON. Returns an error message, or null when
 * the value is a usable `OverpassArea`.
 *
 * Corridor vertices are accepted as `{lat, lon}` objects or as `[lat, lon]`
 * pairs, because the compact pair form is what travels over the wire.
 */
export function validateOverpassArea(area: unknown): string | null {
  if (!area || typeof area !== "object") {
    return "Area must be an object";
  }
  const a = area as Record<string, unknown>;

  if ("corridor" in a) {
    const corridor = a.corridor;
    if (!Array.isArray(corridor) || corridor.length === 0) {
      return "corridor must be a non-empty array";
    }
    if (corridor.length > CORRIDOR_LIMITS.maxVertices) {
      return `corridor has too many vertices (${corridor.length} > ${CORRIDOR_LIMITS.maxVertices})`;
    }
    const radius = a.radiusMeters;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) {
      return "radiusMeters must be a positive number";
    }
    if (radius > CORRIDOR_LIMITS.maxRadiusMeters) {
      return `radiusMeters too large (max ${CORRIDOR_LIMITS.maxRadiusMeters})`;
    }
    for (const vertex of corridor) {
      const point = coerceLatLon(vertex);
      if (!point) {
        return "corridor vertices must be {lat, lon} or [lat, lon] with finite values";
      }
      if (point.lat < -90 || point.lat > 90) {
        return "corridor latitude out of range";
      }
      if (point.lon < -180 || point.lon > 180) {
        return "corridor longitude out of range";
      }
    }
    return null;
  }

  if ("bounds" in a) {
    const bounds = a.bounds as Record<string, unknown> | null;
    if (!bounds || typeof bounds !== "object") {
      return "bounds must be an object";
    }
    for (const edge of ["south", "north", "west", "east"] as const) {
      const v = bounds[edge];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return `bounds.${edge} must be a finite number`;
      }
    }
    const { south, north, west, east } = bounds as unknown as BBox;
    if (south < -90 || north > 90 || south >= north) {
      return "bounds latitudes out of range";
    }
    if (west < -180 || east > 180 || west >= east) {
      return "bounds longitudes out of range";
    }
    if (
      north - south > CORRIDOR_LIMITS.maxBBoxDegrees ||
      east - west > CORRIDOR_LIMITS.maxBBoxDegrees
    ) {
      return `Bounding box too large. Maximum ${CORRIDOR_LIMITS.maxBBoxDegrees} degrees per side.`;
    }
    return null;
  }

  return 'Area must have either "corridor" or "bounds"';
}

/** Coerce a wire vertex (`{lat,lon}` or `[lat,lon]`) into a LatLon, or null. */
function coerceLatLon(value: unknown): LatLon | null {
  if (Array.isArray(value)) {
    const [lat, lon] = value;
    if (
      typeof lat === "number" &&
      typeof lon === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      return { lat, lon };
    }
    return null;
  }
  if (value && typeof value === "object") {
    const { lat, lon } = value as Record<string, unknown>;
    if (
      typeof lat === "number" &&
      typeof lon === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      return { lat, lon };
    }
  }
  return null;
}

/**
 * Normalise a request body (or an already-shaped area) into a canonical
 * `OverpassArea` with `{lat, lon}` corridor vertices, or null if unusable.
 *
 * Additive convenience for the API layer: the wire sends corridors as
 * `[[lat, lon], ...]`, but `buildOverpassQuery` wants LatLon objects. Validate
 * with `validateOverpassArea` first; this only reshapes.
 */
export function parseOverpassArea(input: unknown): OverpassArea | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const a = input as Record<string, unknown>;

  if ("corridor" in a) {
    if (!Array.isArray(a.corridor) || typeof a.radiusMeters !== "number") {
      return null;
    }
    const corridor: LatLon[] = [];
    for (const vertex of a.corridor) {
      const point = coerceLatLon(vertex);
      if (!point) {
        return null;
      }
      corridor.push(point);
    }
    return { corridor, radiusMeters: a.radiusMeters };
  }

  if ("bounds" in a) {
    const bounds = a.bounds as Record<string, unknown> | null;
    if (!bounds || typeof bounds !== "object") {
      return null;
    }
    const { south, north, west, east } = bounds as unknown as BBox;
    if (
      ![south, north, west, east].every(
        (v) => typeof v === "number" && Number.isFinite(v)
      )
    ) {
      return null;
    }
    return { bounds: { south, north, west, east } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route geometry
// ---------------------------------------------------------------------------

export interface RouteGeometry {
  /** All route points, flattened across tracks. */
  points: LatLon[];
  /** cumulativeKm[i] = km along the route at points[i]; a track gap adds nothing. */
  cumulativeKm: number[];
  /** Indices i where (i, i+1) is NOT a real segment (a track boundary). */
  segmentBreaks: Set<number>;
  /** ~150 m spaced sample indices, always including the first/last point of every track. */
  coarseIndices: number[];
}

/** Coarse sample spacing in km. 150 m keeps the coarse pass cheap on dense tracks. */
const COARSE_SPACING_KM = 0.15;

/**
 * Compute the cumulative distance (km) along a polyline at each point.
 * cumulative[0] is 0.
 */
export function computeCumulativeDistances(
  points: { lat: number; lon: number }[]
): number[] {
  if (points.length === 0) {
    return [];
  }
  const cumulative = new Array<number>(points.length);
  cumulative[0] = 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total +=
      haversineDistance(
        points[i - 1].lat,
        points[i - 1].lon,
        points[i].lat,
        points[i].lon
      ) / 1000;
    cumulative[i] = total;
  }
  return cumulative;
}

/**
 * Flatten one or more tracks into the geometry `nearestPointOnRoute` needs.
 *
 * Track boundaries are recorded in `segmentBreaks` (so no distance is ever
 * measured to a phantom segment joining two disjoint tracks) and are always
 * forced into `coarseIndices`. That second part is load-bearing: the coarse
 * pruning bound is derived from `cumulativeKm`, which deliberately does not add
 * the gap across a boundary, so a coarse interval spanning a boundary would
 * carry an under-stated length and could prune away the true nearest point.
 */
export function buildRouteGeometry(
  route: LatLon[] | LatLon[][]
): RouteGeometry {
  const polylines = toPolylines(route);
  const points: LatLon[] = [];
  const segmentBreaks = new Set<number>();

  for (const polyline of polylines) {
    const clean = polyline.filter(isFinitePoint);
    if (clean.length === 0) {
      continue;
    }
    if (points.length > 0) {
      segmentBreaks.add(points.length - 1);
    }
    for (const p of clean) {
      points.push({ lat: p.lat, lon: p.lon });
    }
  }

  const n = points.length;
  const cumulativeKm = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      cumulativeKm[0] = 0;
    } else if (segmentBreaks.has(i - 1)) {
      // Track boundary: the jump between tracks is not distance travelled.
      cumulativeKm[i] = cumulativeKm[i - 1];
    } else {
      cumulativeKm[i] =
        cumulativeKm[i - 1] +
        haversineDistance(
          points[i - 1].lat,
          points[i - 1].lon,
          points[i].lat,
          points[i].lon
        ) /
          1000;
    }
  }

  const coarseIndices: number[] = [];
  let lastKept = -Infinity;
  for (let i = 0; i < n; i++) {
    const isTrackEdge =
      i === 0 ||
      i === n - 1 ||
      segmentBreaks.has(i) ||
      segmentBreaks.has(i - 1);
    if (isTrackEdge || cumulativeKm[i] - lastKept >= COARSE_SPACING_KM) {
      coarseIndices.push(i);
      lastKept = cumulativeKm[i];
    }
  }

  return { points, cumulativeKm, segmentBreaks, coarseIndices };
}

export interface RouteProximity {
  /** Cross-track distance (km) to the nearest point of the polyline. */
  distanceKm: number;
  /** Index i of the segment (i, i+1) carrying the nearest point (or the vertex index). */
  segmentIndex: number;
  /** Position along that segment, 0..1. */
  t: number;
  /** Nearer endpoint of that segment (compat with the old API). */
  nearestPointIndex: number;
  /** cumulativeKm interpolated with t. */
  distanceAlongRouteKm: number;
}

/** Metres per degree of latitude, used by the local equirectangular projection. */
const METERS_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_METERS;

/**
 * Slack (km) applied to the coarse pruning bound. The bound mixes haversine
 * arc lengths (cumulativeKm) with equirectangular point distances; over the
 * distances involved they differ by millimetres, and 1 m of extra exploration
 * is far cheaper than a wrong answer.
 */
const PRUNE_EPSILON_KM = 1e-3;

/** Normalise a longitude difference into [-180, 180] so antimeridian routes work. */
function wrapLonDelta(dLon: number): number {
  let d = dLon;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Exact nearest point on the polyline, in metres, using a local
 * equirectangular projection centred on the POI (x = dlon*cos(lat), y = dlat).
 * At the distances that matter here (<= 10 km) the projection error is well
 * under a millimetre, and it makes the point-to-segment math trivial.
 */
function projectMeters(
  poi: LatLon,
  cosLat0: number,
  p: LatLon
): { x: number; y: number } {
  return {
    x: wrapLonDelta(p.lon - poi.lon) * cosLat0 * METERS_PER_DEGREE,
    y: (p.lat - poi.lat) * METERS_PER_DEGREE,
  };
}

/**
 * Nearest point on a route to a POI: exact point-to-SEGMENT distance, with a
 * coarse/fine two-pass search.
 *
 * Pass 1 measures every ~150 m coarse sample, giving a genuine upper bound
 * (a vertex is on the polyline). Pass 2 walks the coarse intervals and only
 * opens up an interval that could beat the current best: for any point p
 * between coarse samples a and b, the triangle inequality gives
 *   dist(p) >= (d_a + d_b - alongRoute(a, b)) / 2
 * because the straight-line distance shrinks by at most the along-route
 * distance walked from either endpoint. That keeps the result exact for any
 * sample spacing while skipping most of a dense track.
 *
 * Segments listed in `geom.segmentBreaks` are never formed, so a POI is never
 * matched against the phantom line joining two disjoint tracks.
 */
export function nearestPointOnRoute(
  poi: LatLon,
  geom: RouteGeometry
): RouteProximity {
  const { points, cumulativeKm, segmentBreaks, coarseIndices } = geom;
  const n = points.length;

  if (n === 0 || coarseIndices.length === 0) {
    return {
      distanceKm: Infinity,
      segmentIndex: 0,
      t: 0,
      nearestPointIndex: 0,
      distanceAlongRouteKm: 0,
    };
  }

  const cosLat0 = Math.cos((poi.lat * Math.PI) / 180);

  // Pass 1: coarse vertex distances. Also covers isolated single-point tracks,
  // which have no segment at all but are always forced into coarseIndices.
  const coarseDistances = new Array<number>(coarseIndices.length);
  let bestVertexKm = Infinity;
  let bestVertexIndex = coarseIndices[0];
  for (let k = 0; k < coarseIndices.length; k++) {
    const p = projectMeters(poi, cosLat0, points[coarseIndices[k]]);
    const d = Math.hypot(p.x, p.y) / 1000;
    coarseDistances[k] = d;
    if (d < bestVertexKm) {
      bestVertexKm = d;
      bestVertexIndex = coarseIndices[k];
    }
  }

  // Pass 2: exact segment search inside the coarse intervals that survive pruning.
  let best = bestVertexKm;
  let bestSegKm = Infinity;
  let bestSegIndex = -1;
  let bestT = 0;

  for (let k = 0; k + 1 < coarseIndices.length; k++) {
    const a = coarseIndices[k];
    const b = coarseIndices[k + 1];
    const along = cumulativeKm[b] - cumulativeKm[a];
    const lowerBound =
      (coarseDistances[k] + coarseDistances[k + 1] - along) / 2;
    if (lowerBound - PRUNE_EPSILON_KM >= best) {
      continue;
    }

    for (let i = a; i < b; i++) {
      if (segmentBreaks.has(i)) {
        continue;
      }
      const A = projectMeters(poi, cosLat0, points[i]);
      const B = projectMeters(poi, cosLat0, points[i + 1]);
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) {
        t = -(A.x * dx + A.y * dy) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const px = A.x + t * dx;
      const py = A.y + t * dy;
      const d = Math.hypot(px, py) / 1000;
      if (d < bestSegKm) {
        bestSegKm = d;
        bestSegIndex = i;
        bestT = t;
        if (d < best) {
          best = d;
        }
      }
    }
  }

  // A vertex only wins when it belongs to no segment (single-point track) or
  // when its interval was pruned at an exact tie — the distance is the same
  // either way, so report the vertex form.
  if (bestSegIndex < 0 || bestVertexKm < bestSegKm) {
    return {
      distanceKm: bestVertexKm,
      segmentIndex: bestVertexIndex,
      t: 0,
      nearestPointIndex: bestVertexIndex,
      distanceAlongRouteKm: cumulativeKm[bestVertexIndex],
    };
  }

  const startKm = cumulativeKm[bestSegIndex];
  const endKm = cumulativeKm[bestSegIndex + 1];
  return {
    distanceKm: bestSegKm,
    segmentIndex: bestSegIndex,
    t: bestT,
    nearestPointIndex: bestT <= 0.5 ? bestSegIndex : bestSegIndex + 1,
    distanceAlongRouteKm: startKm + bestT * (endKm - startKm),
  };
}
