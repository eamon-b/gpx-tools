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
  ProcessOptions,
  ProcessResult,
  ProcessedRow,
  ResupplyRow,
  DistanceUnit,
  ElevationUnit,
  CsvDelimiter,
  GpxProcessOptions,
  WaypointVisit,
} from './types';

// GPX Parser
export { parseGpx, generateGpx } from './gpx-parser';

// Distance Utilities
export {
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
