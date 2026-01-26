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
  TrackClassificationConfig,
  ClassifiedTrack,
  TrackClassificationResult,
  CombineTracksResult,
  CombineTracksWarning,
} from './types';

// GPX Parser
export { parseGpx, generateGpx } from './gpx-parser';

// Distance Utilities
export {
  EARTH_RADIUS_METERS,
  haversineDistance,
  haversineDistance3D,
  waypointToPointDistance,
  isWaypointNearPoints,
  findCloseWaypoints,
} from './distance';

// GPX Splitter
export { splitGpx, GPX_SPLITTER_DEFAULTS } from './gpx-splitter';

// GPX Combiner
export { combineGpx, GPX_COMBINER_DEFAULTS } from './gpx-combiner';

// CSV Processor
export {
  processTravelPlan,
  CSV_PROCESSOR_DEFAULTS,
  DEFAULT_RESUPPLY_KEYWORDS,
} from './csv-processor';

// GPX Datasheet Processor
export {
  processGpxTravelPlan,
  findWaypointVisits,
  calculateSegmentStats,
  GPX_DATASHEET_DEFAULTS,
  GPX_DEFAULT_RESUPPLY_KEYWORDS,
} from './gpx-datasheet';

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
} from './gpx-optimizer';

// Track Classification
export {
  classifyTracks,
  combineTracksGeographically,
  TRACK_CLASSIFICATION_DEFAULTS,
} from './track-classification';

// Waypoint Classification
export type { ClassificationResult, WaypointPrefixRule } from './waypoint-classifier';
export {
  classifyWaypoint,
  FOLDER_TYPE_MAP,
  DEFAULT_PREFIX_RULES,
  KNOWN_TOWNS,
} from './waypoint-classifier';
