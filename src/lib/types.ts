// GPX Types
export interface GpxPoint {
  lat: number;
  lon: number;
  ele: number;
  time: string | null;
}

export interface GpxWaypoint {
  lat: number;
  lon: number;
  ele: number;
  name: string;
  desc: string;
}

export interface GpxSegment {
  points: GpxPoint[];
}

export interface GpxTrack {
  name: string;
  segments: GpxSegment[];
}

export interface GpxRoute {
  name: string;
  points: GpxPoint[];
}

export interface GpxData {
  tracks: GpxTrack[];
  routes: GpxRoute[];
  waypoints: GpxWaypoint[];
}

// GPX Splitter Types
export interface SplitOptions {
  maxPoints: number;
  waypointMaxDistance: number; // in km
}

export interface SplitResult {
  filename: string;
  content: string;
  pointCount: number;
  waypointCount: number;
}

// CSV Processor Types
export type DistanceUnit = 'km' | 'mi';
export type ElevationUnit = 'm' | 'ft';
export type CsvDelimiter = ',' | ';' | '\t';

export interface ProcessOptions {
  resupplyKeywords: string[];
  includeEndAsResupply: boolean;
  distanceUnit: DistanceUnit;
  elevationUnit: ElevationUnit;
  csvDelimiter: CsvDelimiter;
}

export interface ProcessedRow {
  location: string;
  elevation: number;
  ascent: number;
  descent: number;
  distance: number;
  totalDistance: number;
  totalAscent: number;
  totalDescent: number;
  notes: string;
}

export interface ResupplyRow {
  location: string;
  notes: string;
  totalDistance: number;
  distance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
}

export interface ProcessResult {
  processedPlan: string;
  resupplyPoints: string;
  stats: {
    totalPoints: number;
    resupplyCount: number;
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
}

// GPX Datasheet Types
export interface GpxProcessOptions {
  resupplyKeywords: string[];
  includeEndAsResupply: boolean;
  includeStartAsResupply: boolean;
  distanceUnit: DistanceUnit;
  elevationUnit: ElevationUnit;
  csvDelimiter: CsvDelimiter;
  waypointMaxDistance: number; // meters - max distance from track to include waypoint
}

export interface WaypointVisit {
  waypoint: GpxWaypoint;
  trackIndex: number;           // position along track where visit occurs
  distanceFromTrack: number;    // actual distance from track point to waypoint
}

// GPX Optimizer Types
export interface OptimizationOptions {
  // Simplification
  simplificationTolerance: number;  // meters - Douglas-Peucker epsilon

  // Elevation smoothing
  elevationSmoothing: boolean;
  elevationSmoothingWindow: number; // number of points for moving average
  spikeThreshold: number;           // meters - max elevation change to consider valid

  // Privacy
  truncateStart: number;            // meters to remove from start (0 = disabled)
  truncateEnd: number;              // meters to remove from end (0 = disabled)
  stripExtensions: boolean;         // remove proprietary extensions

  // Data retention
  preserveTimestamps: boolean;      // keep <time> elements (default: true)
  coordinatePrecision: number;      // decimal places (default: 6)

  // Validation thresholds
  maxDistanceChangeRatio: number;   // fraction (0-1) - warn if distance changes by more than this
  maxElevationChangeRatio: number;  // fraction (0-1) - warn if elevation gain changes by more than this
  maxFileSizeBytes: number;         // bytes - warn if optimized file exceeds this size
  maxPointCount: number;            // maximum number of points to process (0 = unlimited)
  maxFileSize: number;              // maximum input file size in bytes (0 = unlimited)
}

export interface OptimizationStats {
  pointCount: number;
  fileSize: number;               // bytes
  distance: number;               // meters
  elevationGain: number;          // meters
  elevationLoss: number;          // meters
}

export interface OptimizationResult {
  filename: string;
  content: string;                  // optimized GPX XML

  // Statistics
  original: OptimizationStats;
  optimized: OptimizationStats;

  // Validation
  warnings: string[];               // issues detected during processing
  passed: boolean;                  // true if within acceptable tolerances
}

export interface BatchOptimizationStats {
  filesProcessed: number;
  totalOriginalSize: number;
  totalOptimizedSize: number;
  averageReduction: number;         // percentage
  warnings: string[];
}
