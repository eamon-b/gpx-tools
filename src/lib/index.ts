// Types
export type {
  GpxPoint,
  GpxWaypoint,
  GpxSegment,
  GpxTrack,
  GpxRoute,
  GpxData,
  SplitOptions,
  SplitResult,
  CombineOptions,
  CombineResult,
  RouteGap,
  ProcessOptions,
  ProcessResult,
  ProcessedRow,
  ResupplyRow,
  DistanceUnit,
  ElevationUnit,
  CsvDelimiter,
  GpxProcessOptions,
  WaypointVisit,
  OptimizationOptions,
  OptimizationResult,
  OptimizationStats,
  BatchOptimizationStats,
} from "./types";

// GPX Parser
export { parseGpx, generateGpx } from "./gpx-parser";

// Distance Utilities
export {
  EARTH_RADIUS_METERS,
  haversineDistance,
  haversineDistance3D,
  waypointToPointDistance,
  isWaypointNearPoints,
  findCloseWaypoints,
} from "./distance";

// GPX Splitter
export { splitGpx, GPX_SPLITTER_DEFAULTS } from "./gpx-splitter";

// GPX Combiner
export { combineGpx, GPX_COMBINER_DEFAULTS } from "./gpx-combiner";

// CSV Processor
export {
  processTravelPlan,
  CSV_PROCESSOR_DEFAULTS,
  DEFAULT_RESUPPLY_KEYWORDS,
} from "./csv-processor";

// GPX Datasheet Processor
export {
  processGpxTravelPlan,
  findWaypointVisits,
  calculateSegmentStats,
  GPX_DATASHEET_DEFAULTS,
  GPX_DEFAULT_RESUPPLY_KEYWORDS,
} from "./gpx-datasheet";

// GPX Optimizer
export {
  optimizeGpx,
  optimizeGpxBatch,
  douglasPeucker,
  removeElevationSpikes,
  smoothElevation,
  calculateTrackDistance,
  calculateElevationStats,
  truncateTrack,
  roundCoordinates,
  GPX_OPTIMIZER_DEFAULTS,
} from "./gpx-optimizer";

// OSM POI catalog, Overpass query building and route geometry
export {
  POI_TYPES,
  POI_TYPE_LABELS,
  POI_CATALOG,
  CORRIDOR_LIMITS,
  categorizePOI,
  getPOIName,
  getPOIDescription,
  buildOverpassQuery,
  roundCoord,
  poiKey,
  normalizeOverpassElements,
  buildCorridorChunks,
  validateOverpassArea,
  parseOverpassArea,
  buildRouteGeometry,
  computeCumulativeDistances,
  nearestPointOnRoute,
  escapeXml,
} from "./osm-poi";
export type {
  POIType,
  POITagRule,
  LatLon,
  BBox,
  OverpassArea,
  OverpassQueryOptions,
  OverpassElement,
  POI,
  RouteGeometry,
  RouteProximity,
} from "./osm-poi";

// Direct Overpass access (Node scripts)
export { createOverpassFetcher } from "./overpass-client";
export type { OverpassFetcherOptions, POIFetcher } from "./overpass-client";

// POI enrichment
export {
  enrichRoute,
  exportPOIsToCSV,
  exportPOIsToGPX,
} from "./poi-enrichment";
export type {
  EnrichmentOptions,
  EnrichmentStage,
  EnrichmentProgress,
  EnrichedPOI,
  EnrichmentResult,
  ChunkFailure,
} from "./poi-enrichment";

// API client (browser proxy access)
export {
  APIClient,
  APIError,
  apiClient,
  proxyPOIFetcher,
  toPOIRequest,
  getBoundsFromPoints,
  splitBounds,
} from "./api-client";
export type { POIRequest } from "./api-client";
