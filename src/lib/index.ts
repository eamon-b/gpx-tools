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
} from "./types";

// GPX Parser
export { parseGpx, generateGpx, writeGpx, waypointChildElements } from "./gpx-parser";
export type { GpxMetadata } from "./gpx-parser";

// KML / KMZ Parser
export {
  parseKml,
  parseKmz,
  parseKmlCoordinates,
  parseDescriptionFields,
  kmlToGpxData,
} from "./kml-parser";
export type {
  KmlCoord,
  KmlGeometry,
  KmlPlacemark,
  KmlDocument,
  KmlFeature,
  KmlToGpxDataOptions,
} from "./kml-parser";

// Distance Utilities
export {
  EARTH_RADIUS_METERS,
  haversineDistance,
  haversineDistance2D,
  haversineDistance3D,
  pointToPointDistance,
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

// CSV output safety
export { csvSafeCell, csvSafeRows } from "./csv-safe";

// GPX Datasheet Processor
export {
  processGpxTravelPlan,
  findWaypointVisits,
  calculateSegmentStats,
  GPX_DATASHEET_DEFAULTS,
  GPX_DEFAULT_RESUPPLY_KEYWORDS,
} from "./gpx-datasheet";
export type { GpxProcessResult } from "./gpx-datasheet";

// GPX Optimizer
export {
  optimizeGpx,
  douglasPeucker,
  removeElevationSpikes,
  smoothElevation,
  calculateTrackDistance,
  calculateElevationStats,
  truncateTracks,
  roundCoordinates,
  generateOptimizedGpx,
  buildNearestPointIndex,
  GPX_OPTIMIZER_DEFAULTS,
} from "./gpx-optimizer";

// Route comparison
export {
  compareRoutes,
  calculateRouteStats,
  exportComparisonToCSV,
} from "./route-comparison";
export type {
  RoutePoint,
  RouteStats,
  RouteSegment,
  RouteComparison,
  ComparisonOptions,
} from "./route-comparison";

// Daylight
export {
  createDaylightPlan,
  getDaylightInfo,
  getDaylightRange,
  getDaylightAlongRoute,
  getMoonInfo,
  exportDaylightPlanToCSV,
  estimateUtcOffset,
  shiftToUtcOffset,
  formatUtcOffset,
  formatDateISO,
  formatTime,
  formatDaylightHours,
} from "./daylight";
export type {
  DaylightInfo,
  LocationDaylight,
  DaylightPlanDay,
  DaylightPlanOptions,
  DaylightPlan,
} from "./daylight";

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
  packCorridorChunks,
  corridorVertexCount,
  overpassPayloadError,
  isTransientOverpassError,
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
  MAX_SEARCH_RADIUS_KM,
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
} from "./api-client";
export type { POIRequest } from "./api-client";
