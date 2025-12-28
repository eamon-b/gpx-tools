// Types
export type {
  GpxPoint,
  GpxWaypoint,
  GpxSegment,
  GpxTrack,
  GpxData,
  SplitOptions,
  SplitResult,
  ProcessOptions,
  ProcessResult,
  ProcessedRow,
  ResupplyRow,
  DistanceUnit,
  ElevationUnit,
  CsvDelimiter,
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

// CSV Processor
export {
  processTravelPlan,
  CSV_PROCESSOR_DEFAULTS,
  DEFAULT_RESUPPLY_KEYWORDS,
} from './csv-processor';
