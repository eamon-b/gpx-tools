import Papa from 'papaparse';
import type { ProcessOptions, ProcessResult, ProcessedRow, ResupplyRow, DistanceUnit, ElevationUnit } from './types';

const DEFAULT_RESUPPLY_KEYWORDS = [
  'grocer', 'market', 'foodland', 'iga',
  'wool', 'coles', 'general', 'servo'
];

const DEFAULT_OPTIONS: ProcessOptions = {
  resupplyKeywords: DEFAULT_RESUPPLY_KEYWORDS,
  includeEndAsResupply: true,
  distanceUnit: 'km',
  elevationUnit: 'm',
  csvDelimiter: ',',
};

// Unit conversion constants
const KM_TO_MI = 0.621371;
const M_TO_FT = 3.28084;

/**
 * Convert distance value based on selected unit
 */
function formatDistance(km: number, unit: DistanceUnit): number {
  const value = unit === 'mi' ? km * KM_TO_MI : km;
  return Math.round(value * 1000) / 1000;
}

/**
 * Convert elevation value based on selected unit
 */
function formatElevation(meters: number, unit: ElevationUnit): number {
  const value = unit === 'ft' ? meters * M_TO_FT : meters;
  return Math.round(value * 10) / 10;
}

// Conversion constants for input parsing
const FT_TO_M = 0.3048;
const MI_TO_KM = 1.60934;

/**
 * Convert elevation string to meters
 * Handles: "123m", "-45m", "369'", "+2084'", "100ft"
 */
function convertElevation(elevStr: string | null | undefined): number {
  if (!elevStr) return 0;
  const str = String(elevStr).trim();

  // Try meters first (e.g., "123m", "-45m")
  const mMatch = str.match(/([-\d.]+)\s*m$/i);
  if (mMatch) {
    return parseFloat(mMatch[1]);
  }

  // Try feet with apostrophe (e.g., "369'", "+2084'", "-1739'")
  const ftMatch = str.match(/([-+]?\d[\d,]*)'?$/);
  if (ftMatch) {
    const value = parseFloat(ftMatch[1].replace(/,/g, ''));
    return value * FT_TO_M;
  }

  // Try feet with "ft" suffix
  const ftSuffixMatch = str.match(/([-\d.]+)\s*ft/i);
  if (ftSuffixMatch) {
    return parseFloat(ftSuffixMatch[1]) * FT_TO_M;
  }

  return 0;
}

/**
 * Convert distance string to kilometers
 * Handles: "5.2km", "500m", "50.7 mi"
 */
function convertDistance(distStr: string | null | undefined): number {
  if (!distStr) return 0;
  const str = String(distStr).trim();

  // Try kilometers (e.g., "5.2km", "5.2 km")
  const kmMatch = str.match(/([\d.]+)\s*km/i);
  if (kmMatch) {
    return parseFloat(kmMatch[1]);
  }

  // Try miles (e.g., "50.7 mi", "50.7mi")
  const miMatch = str.match(/([\d.]+)\s*mi/i);
  if (miMatch) {
    return parseFloat(miMatch[1]) * MI_TO_KM;
  }

  // Try meters (e.g., "500m", "500 m")
  const mMatch = str.match(/([\d.]+)\s*m$/i);
  if (mMatch) {
    return parseFloat(mMatch[1]) / 1000;
  }

  // Try feet (e.g., "1634 ft", "1634ft") - convert to km
  const ftMatch = str.match(/([\d.]+)\s*ft/i);
  if (ftMatch) {
    return (parseFloat(ftMatch[1]) * FT_TO_M) / 1000;
  }

  return 0;
}

/**
 * Check if notes contain any resupply keywords
 */
function hasResupplyKeyword(notes: string | null | undefined, keywords: string[]): boolean {
  if (!notes) return false;
  const lowerNotes = String(notes).toLowerCase();
  return keywords.some(keyword => lowerNotes.includes(keyword));
}

/**
 * Process a Caltopo travel plan CSV
 */
export function processTravelPlan(
  csvContent: string,
  options: Partial<ProcessOptions> = {}
): ProcessResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Parse CSV
  const parseResult = Papa.parse<string[]>(csvContent, {
    skipEmptyLines: true,
  });

  if (parseResult.errors.length > 0) {
    console.warn('CSV parse warnings:', parseResult.errors);
  }

  // Skip first 2 header rows (Caltopo format)
  const dataRows = parseResult.data.slice(2);

  // Expected columns from Caltopo:
  // Location, Point, Coordinates, Elevation, Ascent, Descent, Distance, Bearing, Time, Total Time, Notes
  const processedRows: ProcessedRow[] = [];
  let runningDistance = 0;
  let runningAscent = 0;
  let runningDescent = 0;

  for (const row of dataRows) {
    const [location, , , elevation, ascent, descent, distance, , , , notes] = row;

    // Skip the "total" row
    if (location?.toLowerCase() === 'total') continue;

    const elevationNum = convertElevation(elevation);
    const ascentNum = convertElevation(ascent?.replace('+', ''));
    const descentNum = convertElevation(descent?.replace('-', ''));
    const distanceNum = convertDistance(distance);

    runningDistance += distanceNum;
    runningAscent += ascentNum;
    runningDescent += descentNum;

    processedRows.push({
      location: location || '',
      elevation: elevationNum,
      ascent: ascentNum,
      descent: descentNum,
      distance: distanceNum,
      totalDistance: Math.round(runningDistance * 1000) / 1000,
      totalAscent: Math.round(runningAscent * 10) / 10,
      totalDescent: Math.round(runningDescent * 10) / 10,
      notes: notes || '',
    });
  }

  // Create resupply points
  const resupplyRows: ResupplyRow[] = [];
  let prevTotalDistance = 0;

  for (const row of processedRows) {
    const isResupply = hasResupplyKeyword(row.notes, opts.resupplyKeywords);
    const isEnd = opts.includeEndAsResupply && row.location.toLowerCase() === 'end';

    if (isResupply || isEnd) {
      const segmentDistance = row.totalDistance - prevTotalDistance;
      prevTotalDistance = row.totalDistance;

      resupplyRows.push({
        location: row.location,
        notes: row.notes,
        totalDistance: row.totalDistance,
        distance: Math.round(segmentDistance * 1000) / 1000,
        ascent: row.ascent,
        descent: row.descent,
        totalAscent: row.totalAscent,
        totalDescent: row.totalDescent,
      });
    }
  }

  // Generate output CSVs with unit labels
  const distLabel = opts.distanceUnit === 'mi' ? 'mi' : 'km';
  const eleLabel = opts.elevationUnit === 'ft' ? 'ft' : 'm';

  const processedPlanHeaders = [
    'Location', `Elevation (${eleLabel})`, `Ascent (${eleLabel})`, `Descent (${eleLabel})`, `Distance (${distLabel})`,
    `Total Distance (${distLabel})`, `Total Ascent (${eleLabel})`, `Total Descent (${eleLabel})`, 'Notes'
  ];

  const processedPlanData = processedRows.map(row => [
    row.location,
    formatElevation(row.elevation, opts.elevationUnit),
    formatElevation(row.ascent, opts.elevationUnit),
    formatElevation(row.descent, opts.elevationUnit),
    formatDistance(row.distance, opts.distanceUnit),
    formatDistance(row.totalDistance, opts.distanceUnit),
    formatElevation(row.totalAscent, opts.elevationUnit),
    formatElevation(row.totalDescent, opts.elevationUnit),
    row.notes,
  ]);

  const processedPlan = Papa.unparse({
    fields: processedPlanHeaders,
    data: processedPlanData,
  }, { quotes: true, delimiter: opts.csvDelimiter });

  const resupplyHeaders = [
    'Location', 'Notes', `Total Distance (${distLabel})`, `Distance (${distLabel})`,
    `Ascent (${eleLabel})`, `Descent (${eleLabel})`, `Total Ascent (${eleLabel})`, `Total Descent (${eleLabel})`
  ];

  const resupplyData = resupplyRows.map(row => [
    row.location,
    row.notes,
    formatDistance(row.totalDistance, opts.distanceUnit),
    formatDistance(row.distance, opts.distanceUnit),
    formatElevation(row.ascent, opts.elevationUnit),
    formatElevation(row.descent, opts.elevationUnit),
    formatElevation(row.totalAscent, opts.elevationUnit),
    formatElevation(row.totalDescent, opts.elevationUnit),
  ]);

  const resupplyPoints = Papa.unparse({
    fields: resupplyHeaders,
    data: resupplyData,
  }, { quotes: true, delimiter: opts.csvDelimiter });

  // Calculate stats
  const totalDistance = processedRows.reduce((sum, r) => sum + r.distance, 0);
  const totalAscent = processedRows.reduce((sum, r) => sum + r.ascent, 0);
  const totalDescent = processedRows.reduce((sum, r) => sum + r.descent, 0);

  return {
    processedPlan,
    resupplyPoints,
    stats: {
      totalPoints: processedRows.length,
      resupplyCount: resupplyRows.length,
      totalDistance: Math.round(totalDistance * 100) / 100,
      totalAscent: Math.round(totalAscent),
      totalDescent: Math.round(totalDescent),
    },
  };
}

export { DEFAULT_OPTIONS as CSV_PROCESSOR_DEFAULTS, DEFAULT_RESUPPLY_KEYWORDS };
