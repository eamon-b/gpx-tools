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
