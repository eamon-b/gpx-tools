/**
 * POI Enrichment
 *
 * Ties the OSM catalog, the corridor query builder and the route geometry
 * together: given a route, fetch the OpenStreetMap POIs that sit within a
 * search radius of it and annotate each one with where along the route it is.
 */

import { proxyPOIFetcher } from "./api-client.js";
import {
  CORRIDOR_LIMITS,
  buildCorridorChunks,
  buildRouteGeometry,
  categorizePOI,
  computeCumulativeDistances,
  escapeXml,
  getPOIDescription,
  getPOIName,
  nearestPointOnRoute,
  packCorridorChunks,
  poiKey,
  POI_TYPES,
  type LatLon,
  type POI,
  type POIType,
} from "./osm-poi.js";
import type { POIFetcher } from "./overpass-client.js";

export { computeCumulativeDistances, getPOIName, getPOIDescription };
export type { POIType, POI, LatLon };

export interface EnrichmentOptions {
  types: POIType[];
  /** POIs within this distance of the route are returned. Default 2 km. */
  searchRadiusKm?: number;
  /** @deprecated alias for `searchRadiusKm` */
  maxDistanceFromRoute?: number;
  /** @deprecated ignored — corridor queries do not need a bbox buffer */
  bufferKm?: number;
  /** Where POIs come from. Defaults to the /api/overpass proxy. */
  fetchPOIs?: POIFetcher;
  /** Cancellation. `enrichRoute` rejects with an Error named 'AbortError'. */
  signal?: AbortSignal;
  /** Max corridor vertices per Overpass query. Default 300. */
  maxVerticesPerChunk?: number;
}

export type EnrichmentStage = "prepare" | "fetch" | "process" | "done";

export interface EnrichmentProgress {
  stage: EnrichmentStage;
  /** 1-based position within the stage, when the stage has discrete steps. */
  current?: number;
  total?: number;
  message: string;
}

export interface EnrichedPOI extends POI {
  category: POIType;
  /** Cross-track distance from the route, km. */
  distanceFromRoute: number;
  /** Distance along the route at the closest point, km. */
  distanceAlongRoute: number;
  /** Nearer endpoint of the closest segment, indexing the flattened route. */
  nearestPointIndex: number;
  /** Index of the closest segment (segmentIndex, segmentIndex + 1). */
  segmentIndex: number;
  /** Position along that segment, 0..1. Lets consumers interpolate their own scales. */
  t: number;
}

export interface ChunkFailure {
  chunkIndex: number;
  error: string;
}

export interface EnrichmentResult {
  pois: EnrichedPOI[];
  byType: Record<POIType, EnrichedPOI[]>;
  /** Queries that failed to fetch. Empty when everything succeeded. */
  failedChunks: ChunkFailure[];
  stats: {
    totalFound: number;
    byType: Record<POIType, number>;
    /** Number of Overpass queries issued (corridor groups, not polylines). */
    queryChunks: number;
    failedChunks: number;
    queryTimeMs: number;
  };
}

const DEFAULT_SEARCH_RADIUS_KM = 2;

/**
 * Corridor simplification (Douglas-Peucker at radius/4) can shift the queried
 * polyline away from the real track by up to a quarter of the radius, so the
 * Overpass `around:` radius is padded to keep recall exact. The precise
 * distance filter runs against the full-resolution route afterwards, so
 * over-fetching only costs a little bandwidth.
 */
const QUERY_RADIUS_MARGIN = 1.25;

/**
 * Largest search radius that can still be queried honestly: 8 km, not the
 * server's 10 km `around:` cap.
 *
 * The query radius is the search radius times QUERY_RADIUS_MARGIN, and above
 * 8 km that padding is what gets clamped away — the corridor would then be
 * queried at less than the requested distance and POIs the user asked for
 * would silently go missing. Clamping the search radius instead keeps the
 * margin intact, so what comes back really is everything within the radius.
 */
export const MAX_SEARCH_RADIUS_KM =
  CORRIDOR_LIMITS.maxRadiusMeters / QUERY_RADIUS_MARGIN / 1000;

/** Smallest usable search radius; below this a query returns nothing at all. */
const MIN_SEARCH_RADIUS_KM = 0.01;

function abortError(): Error {
  const error = new Error("Enrichment aborted");
  error.name = "AbortError";
  return error;
}

function emptyByType<T>(make: () => T): Record<POIType, T> {
  return {
    water: make(),
    camping: make(),
    resupply: make(),
    restaurant: make(),
    transport: make(),
    emergency: make(),
  };
}

/**
 * Enrich a route with POIs from OpenStreetMap.
 *
 * The route may be one polyline or several disjoint tracks. Its corridor is cut
 * into chunks and those chunks are packed into as few queries as possible;
 * the queries are issued sequentially on purpose, because Overpass grants only
 * a couple of slots per source IP and the proxy shares one egress IP across all
 * users, so parallel queries would mostly return 429s. A query that fails is
 * recorded in `failedChunks` and skipped; only an all-queries failure throws.
 */
export async function enrichRoute(
  route: LatLon[] | LatLon[][],
  options: EnrichmentOptions,
  onProgress?: (progress: EnrichmentProgress) => void
): Promise<EnrichmentResult> {
  const startTime = Date.now();
  const { signal } = options;
  const requestedRadiusKm =
    options.searchRadiusKm ?? options.maxDistanceFromRoute;
  const searchRadiusKm =
    typeof requestedRadiusKm === "number" &&
    Number.isFinite(requestedRadiusKm) &&
    requestedRadiusKm > 0
      ? Math.min(
          Math.max(requestedRadiusKm, MIN_SEARCH_RADIUS_KM),
          MAX_SEARCH_RADIUS_KM
        )
      : DEFAULT_SEARCH_RADIUS_KM;
  const fetchPOIs = options.fetchPOIs ?? proxyPOIFetcher;
  const maxVertices = options.maxVerticesPerChunk ?? 300;

  const corridorRadiusMeters = Math.min(
    searchRadiusKm * 1000,
    CORRIDOR_LIMITS.maxRadiusMeters
  );
  const queryRadiusMeters = Math.min(
    Math.round(corridorRadiusMeters * QUERY_RADIUS_MARGIN),
    CORRIDOR_LIMITS.maxRadiusMeters
  );

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw abortError();
    }
  };

  throwIfAborted();
  onProgress?.({ stage: "prepare", message: "Preparing route corridor..." });

  const geom = buildRouteGeometry(route);
  // Chunking splits long corridors; packing then merges the short ones back
  // into shared queries, so a route with a dozen side trips costs one request
  // rather than a dozen.
  const groups = packCorridorChunks(
    buildCorridorChunks(route, corridorRadiusMeters, maxVertices),
    maxVertices
  );

  const byType = emptyByType<EnrichedPOI[]>(() => []);
  const stats = {
    totalFound: 0,
    byType: emptyByType<number>(() => 0),
    queryChunks: groups.length,
    failedChunks: 0,
    queryTimeMs: 0,
  };

  if (groups.length === 0) {
    onProgress?.({ stage: "done", message: "Route has no usable points" });
    stats.queryTimeMs = Date.now() - startTime;
    return { pois: [], byType, failedChunks: [], stats };
  }

  const failedChunks: ChunkFailure[] = [];
  const unique = new Map<string, POI>();

  for (let i = 0; i < groups.length; i++) {
    throwIfAborted();
    onProgress?.({
      stage: "fetch",
      current: i + 1,
      total: groups.length,
      message: `Fetching POIs (area ${i + 1} of ${groups.length})...`,
    });

    const group = groups[i];
    try {
      const chunkPOIs = await fetchPOIs(
        {
          // Keep a single polyline flat: that is what most routes produce and
          // it is the shape the server's cache key is built from.
          corridor: group.length === 1 ? group[0] : group,
          radiusMeters: queryRadiusMeters,
        },
        options.types,
        signal
      );
      // Chunks overlap by a vertex and their radii overlap far more, so the
      // same feature routinely comes back from several queries.
      for (const poi of chunkPOIs) {
        const key = poiKey(poi);
        if (!unique.has(key)) {
          unique.set(key, poi);
        }
      }
    } catch (error) {
      // Only the caller's own signal means cancellation. An error merely
      // *named* AbortError (a per-request timeout, say) is a chunk failure:
      // treating it as a cancel would throw away the chunks that succeeded.
      if (signal?.aborted) {
        throw abortError();
      }
      failedChunks.push({
        chunkIndex: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedChunks.length === groups.length) {
    const reasons = [...new Set(failedChunks.map((f) => f.error))];
    throw new Error(
      `Failed to fetch POIs for all ${groups.length} area${groups.length === 1 ? "" : "s"}: ${reasons.join("; ")}`
    );
  }

  throwIfAborted();
  onProgress?.({
    stage: "process",
    current: 0,
    total: unique.size,
    message: `Processing ${unique.size} POIs...`,
  });

  const pois: EnrichedPOI[] = [];
  for (const poi of unique.values()) {
    const proximity = nearestPointOnRoute(poi, geom);
    if (!(proximity.distanceKm <= searchRadiusKm)) {
      continue;
    }

    // Prefer the requested types: whatever a requested selector matched is
    // classified as that type (a sheltered bus stop asked for as Transport is
    // transport, not camping).
    const category = categorizePOI(poi.tags, options.types);
    if (!category || !options.types.includes(category)) {
      continue;
    }

    const enriched: EnrichedPOI = {
      ...poi,
      category,
      distanceFromRoute: proximity.distanceKm,
      distanceAlongRoute: proximity.distanceAlongRouteKm,
      nearestPointIndex: proximity.nearestPointIndex,
      segmentIndex: proximity.segmentIndex,
      t: proximity.t,
    };
    pois.push(enriched);
    byType[category].push(enriched);
  }

  const byDistanceAlong = (a: EnrichedPOI, b: EnrichedPOI) =>
    a.distanceAlongRoute - b.distanceAlongRoute;
  pois.sort(byDistanceAlong);
  for (const type of POI_TYPES) {
    byType[type].sort(byDistanceAlong);
    stats.byType[type] = byType[type].length;
  }

  stats.totalFound = pois.length;
  stats.failedChunks = failedChunks.length;
  stats.queryTimeMs = Date.now() - startTime;

  onProgress?.({
    stage: "done",
    message: `Found ${pois.length} POIs along route`,
  });

  return { pois, byType, failedChunks, stats };
}

/**
 * Escape a single CSV field: wrap in double quotes when it contains a comma,
 * quote, or newline, and double any embedded quotes.
 */
function escapeCSVField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** Format POIs as CSV for export. */
export function exportPOIsToCSV(pois: EnrichedPOI[]): string {
  const headers = [
    "Name",
    "Category",
    "Latitude",
    "Longitude",
    "Distance Along Route (km)",
    "Distance from Route (km)",
    "Description",
  ];
  const rows = pois.map((poi) => [
    getPOIName(poi),
    poi.category,
    poi.lat.toFixed(6),
    poi.lon.toFixed(6),
    poi.distanceAlongRoute.toFixed(1),
    poi.distanceFromRoute.toFixed(2),
    getPOIDescription(poi),
  ]);

  return [
    headers.map(escapeCSVField).join(","),
    ...rows.map((r) => r.map(escapeCSVField).join(",")),
  ].join("\n");
}

/**
 * Format POIs as GPX waypoints.
 *
 * Names and descriptions are XML-escaped rather than stripped: OSM names
 * legitimately contain `&` and `'` ("Joe's Cafe & Bar"), and deleting those
 * characters silently corrupts the data the user asked to export.
 */
export function exportPOIsToGPX(
  pois: EnrichedPOI[],
  routeName?: string
): string {
  const waypoints = pois
    .map((poi) => {
      const name = escapeXml(getPOIName(poi));
      const desc = escapeXml(getPOIDescription(poi));
      const sym = escapeXml(getCategorySymbol(poi.category));

      return `  <wpt lat="${poi.lat}" lon="${poi.lon}">
    <name>${name}</name>
    <desc>${desc}</desc>
    <sym>${sym}</sym>
    <type>${escapeXml(poi.category)}</type>
  </wpt>`;
    })
    .join("\n");

  const title = routeName ? `${routeName} POIs` : "Route POIs";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tools POI Enrichment"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(title)}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
${waypoints}
</gpx>`;
}

/** GPX symbol for a POI category. */
function getCategorySymbol(category: POIType): string {
  const symbols: Record<POIType, string> = {
    water: "Drinking Water",
    camping: "Campground",
    resupply: "Shopping Center",
    restaurant: "Restaurant",
    transport: "Ground Transportation",
    emergency: "Medical Facility",
  };
  return symbols[category] || "Flag, Blue";
}
