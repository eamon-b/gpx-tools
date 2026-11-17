/**
 * Daylight Calculator Module
 *
 * Provides utilities for calculating sunrise, sunset, and daylight hours
 * along a route for trip planning purposes.
 */

import SunCalc from 'suncalc';
import { haversineDistance as haversineDistanceMeters } from './distance.js';

/** Calculate haversine distance in km (wrapper for shared function that returns meters) */
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
}

export interface DaylightInfo {
  date: Date;
  sunrise: Date;
  sunset: Date;
  solarNoon: Date;
  daylightHours: number;
  civilTwilightStart: Date;
  civilTwilightEnd: Date;
  nauticalTwilightStart: Date;
  nauticalTwilightEnd: Date;
  /** True at high latitudes when the sun never sets (24h daylight) */
  polarDay: boolean;
  /** True at high latitudes when the sun never rises (0h daylight) */
  polarNight: boolean;
}

export interface LocationDaylight extends DaylightInfo {
  lat: number;
  lon: number;
  distanceFromStart?: number;
}

export interface DaylightPlanDay {
  date: Date;
  startLocation: { lat: number; lon: number };
  endLocation: { lat: number; lon: number };
  sunrise: Date;
  sunset: Date;
  daylightHours: number;
  /** Hours between the planned start and stop, less the buffer. Never negative. */
  hikingHoursAvailable: number;
  /** The day's distance does not fit in `hikingHoursAvailable`. */
  nightHikingRequired: boolean;
  /** The planned start is before sunrise (a negative `startTimeOffset`). */
  startBeforeSunrise: boolean;
  /** Walking the day's distance from the planned start runs past sunset. */
  endAfterSunset: boolean;
  /** Distance covered this day in km */
  distanceKm: number;
  /** Sun never sets on this day (high latitudes) */
  polarDay: boolean;
  /** Sun never rises on this day (high latitudes) */
  polarNight: boolean;
}

export interface DaylightPlanOptions {
  /**
   * Trip start date. A 'YYYY-MM-DD' string is interpreted as a calendar day
   * in the route's (longitude-estimated) local time zone — preferred, as a
   * Date carries the browser's time zone which may differ from the route's.
   */
  startDate: Date | string;
  dailyTargetKm: number;
  hikingSpeedKmh?: number;
  /**
   * Minutes of each day held in reserve - breaks, navigation, a slow climb -
   * and so taken out of the hiking time available. Default 0.
   */
  bufferMinutes?: number;
  /** Minutes after sunrise to start. Negative starts before sunrise. Default 30. */
  startTimeOffset?: number;
  /** Minutes before sunset to stop. Negative walks on past sunset. Default 30. */
  endTimeOffset?: number;
}

export interface DaylightPlan {
  days: DaylightPlanDay[];
  totalDays: number;
  totalDistance: number;
  nightHikingDays: number;
  shortestDay: { date: Date; hours: number };
  longestDay: { date: Date; hours: number };
  /**
   * Route-local UTC offset in whole hours, estimated from the route's mean
   * longitude (offset = round(lon / 15)). Approximate — real time zones
   * follow political boundaries and DST — but keeps displayed clock times
   * and calendar days correct regardless of the browser's time zone.
   */
  utcOffsetHours: number;
}

/**
 * Estimate a location's UTC offset (whole hours) from its longitude.
 * Approximation: 15 degrees of longitude per hour.
 */
export function estimateUtcOffset(lon: number): number {
  return Math.round(lon / 15);
}

/** Shift a Date so its UTC fields read as route-local time at the given offset */
export function shiftToUtcOffset(date: Date, utcOffsetHours: number): Date {
  return new Date(date.getTime() + utcOffsetHours * 3600000);
}

/** Format a UTC offset as e.g. "UTC+2", "UTC-7", "UTC+0" */
export function formatUtcOffset(utcOffsetHours: number): string {
  return `UTC${utcOffsetHours >= 0 ? '+' : ''}${utcOffsetHours}`;
}

/** Format a date as YYYY-MM-DD in the route-local (offset) calendar */
export function formatDateISO(date: Date, utcOffsetHours: number): string {
  return shiftToUtcOffset(date, utcOffsetHours).toISOString().split('T')[0];
}

/**
 * Get daylight information for a specific location and date
 */
export function getDaylightInfo(lat: number, lon: number, date: Date): DaylightInfo {
  const times = SunCalc.getTimes(date, lat, lon);

  // At high latitudes SunCalc returns Invalid Date when the sun never
  // rises/sets. Detect that case and classify it as polar day (sun above the
  // horizon at solar noon) or polar night, instead of propagating NaN.
  const sunriseInvalid = isNaN(times.sunrise.getTime());
  const sunsetInvalid = isNaN(times.sunset.getTime());

  let polarDay = false;
  let polarNight = false;
  let daylightHours: number;

  if (sunriseInvalid || sunsetInvalid) {
    const noon = isNaN(times.solarNoon.getTime()) ? date : times.solarNoon;
    const sunUp = SunCalc.getPosition(noon, lat, lon).altitude > 0;
    polarDay = sunUp;
    polarNight = !sunUp;
    daylightHours = sunUp ? 24 : 0;
  } else {
    const daylightMs = times.sunset.getTime() - times.sunrise.getTime();
    daylightHours = daylightMs / (1000 * 60 * 60);
  }

  return {
    date,
    sunrise: times.sunrise,
    sunset: times.sunset,
    solarNoon: times.solarNoon,
    daylightHours,
    civilTwilightStart: times.dawn,
    civilTwilightEnd: times.dusk,
    nauticalTwilightStart: times.nauticalDawn,
    nauticalTwilightEnd: times.nauticalDusk,
    polarDay,
    polarNight,
  };
}

const DAY_MS = 86400000;

/**
 * Get daylight information for multiple dates at a location.
 *
 * Days are exact 24 h steps from `startDate`. (Stepping with `setDate` moves
 * in the machine's own time zone, so across its daylight-saving change the
 * instants drift an hour from the caller's anchor - and differ between a
 * laptop and a server.) Anchor `startDate` at local noon of the place asked
 * about to stay clear of midnight.
 */
export function getDaylightRange(
  lat: number,
  lon: number,
  startDate: Date,
  numDays: number
): DaylightInfo[] {
  const results: DaylightInfo[] = [];

  for (let i = 0; i < numDays; i++) {
    results.push(getDaylightInfo(lat, lon, new Date(startDate.getTime() + i * DAY_MS)));
  }

  return results;
}

/**
 * Daylight at evenly spaced places along a route, for each day of a date
 * range: `result[day][sample]`.
 *
 * Samples are spaced by DISTANCE along the route (interpolating between
 * points), `samplesPerDay * numDays` of them, and always include both ends.
 * Spacing by point index would bunch the samples wherever the recording is
 * dense - switchbacks, a long lunch - and skip the fast open stretches.
 * `distanceFromStart` is in km. Days are exact 24 h steps from `startDate`,
 * as in `getDaylightRange`.
 */
export function getDaylightAlongRoute(
  routePoints: { lat: number; lon: number }[],
  startDate: Date,
  numDays: number,
  samplesPerDay: number = 10
): LocationDaylight[][] {
  if (routePoints.length === 0 || !(numDays > 0)) {
    return [];
  }

  const pointsWithDist = calculateCumulativeDistances(routePoints);
  const totalDist = pointsWithDist[pointsWithDist.length - 1].dist;
  // A route with no length is one place; otherwise at least the two ends.
  const sampleCount =
    totalDist > 0 ? Math.max(2, Math.floor(numDays) * Math.max(1, Math.floor(samplesPerDay))) : 1;
  const samples = Array.from({ length: sampleCount }, (_, k) => {
    const dist = sampleCount > 1 ? (totalDist * k) / (sampleCount - 1) : 0;
    return { ...findPointAtDistance(pointsWithDist, dist), dist };
  });

  const results: LocationDaylight[][] = [];
  for (let day = 0; day < numDays; day++) {
    const date = new Date(startDate.getTime() + day * DAY_MS);
    results.push(
      samples.map(sample => ({
        ...getDaylightInfo(sample.lat, sample.lon, date),
        lat: sample.lat,
        lon: sample.lon,
        distanceFromStart: sample.dist,
      }))
    );
  }

  return results;
}

/**
 * Calculate cumulative distance along route points
 */
function calculateCumulativeDistances(
  points: { lat: number; lon: number }[]
): { lat: number; lon: number; dist: number }[] {
  let totalDist = 0;

  return points.map((point, i, arr) => {
    if (i > 0) {
      const prev = arr[i - 1];
      totalDist += haversineDistanceKm(prev.lat, prev.lon, point.lat, point.lon);
    }
    return { ...point, dist: totalDist };
  });
}


/**
 * Find point along route at a given distance from start
 */
function findPointAtDistance(
  pointsWithDist: { lat: number; lon: number; dist: number }[],
  targetDist: number
): { lat: number; lon: number } {
  // Find the two points that bracket the target distance
  for (let i = 0; i < pointsWithDist.length - 1; i++) {
    const current = pointsWithDist[i];
    const next = pointsWithDist[i + 1];

    if (targetDist >= current.dist && targetDist <= next.dist) {
      // Linear interpolation between points
      const segmentDist = next.dist - current.dist;
      if (segmentDist === 0) return current;

      const t = (targetDist - current.dist) / segmentDist;
      return {
        lat: current.lat + t * (next.lat - current.lat),
        lon: current.lon + t * (next.lon - current.lon),
      };
    }
  }

  // If beyond end, return last point
  const last = pointsWithDist[pointsWithDist.length - 1];
  return { lat: last.lat, lon: last.lon };
}

/**
 * Create a daylight-aware hiking plan for a route
 */
export function createDaylightPlan(
  routePoints: { lat: number; lon: number }[],
  options: DaylightPlanOptions
): DaylightPlan {
  const {
    startDate,
    dailyTargetKm,
    hikingSpeedKmh = 4,
    startTimeOffset = 30,
    endTimeOffset = 30,
  } = options;
  const bufferMinutes = Math.max(0, options.bufferMinutes ?? 0);

  if (routePoints.length === 0) {
    throw new Error('Route has no points');
  }
  // A zero or negative target would never advance along the route.
  if (!(dailyTargetKm > 0) || !(hikingSpeedKmh > 0)) {
    throw new Error('Daily target distance and hiking speed must be greater than zero');
  }

  const pointsWithDist = calculateCumulativeDistances(routePoints);
  const totalDistance = pointsWithDist[pointsWithDist.length - 1].dist;
  const estimatedDays = Math.ceil(totalDistance / dailyTargetKm);

  // Estimate the route's UTC offset from its mean longitude so that
  // calendar days and clock times are computed in the route's local time,
  // not the browser's (which may be a different time zone entirely).
  // Use a circular mean so routes crossing the antimeridian (e.g. points at
  // lon +179.9 and -179.9) resolve to UTC±12 instead of averaging to ~UTC+0.
  let sumSin = 0;
  let sumCos = 0;
  for (const p of routePoints) {
    const rad = p.lon * Math.PI / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  const meanLon = Math.atan2(sumSin, sumCos) * 180 / Math.PI;
  const utcOffsetHours = estimateUtcOffset(meanLon);

  // Anchor each day at route-local noon. A 'YYYY-MM-DD' start date string is
  // interpreted as that calendar day in route-local time; a Date is used as-is.
  let startNoon: Date;
  if (typeof startDate === 'string') {
    const [y, m, d] = startDate.split('-').map(Number);
    startNoon = new Date(Date.UTC(y, m - 1, d, 12 - utcOffsetHours));
  } else {
    startNoon = startDate;
  }

  const days: DaylightPlanDay[] = [];
  let currentDist = 0;
  let shortestDay = { date: startNoon, hours: Infinity };
  let longestDay = { date: startNoon, hours: 0 };
  let nightHikingDays = 0;

  for (let dayNum = 0; dayNum < estimatedDays && currentDist < totalDistance; dayNum++) {
    // Walk days as exact 24h steps from the route-local-noon anchor
    const date = new Date(startNoon.getTime() + dayNum * DAY_MS);

    const startLocation = findPointAtDistance(pointsWithDist, currentDist);
    const endDist = Math.min(currentDist + dailyTargetKm, totalDistance);
    const endLocation = findPointAtDistance(pointsWithDist, endDist);

    // Get daylight for start location (approximate - could vary over day's hike)
    const daylight = getDaylightInfo(startLocation.lat, startLocation.lon, date);

    // Calculate actual hiking hours needed
    const distanceToday = endDist - currentDist;
    const hikingHoursNeeded = distanceToday / hikingSpeedKmh;

    // Calculate available hiking hours: from the planned start to the
    // planned stop, less the buffer. On polar days/nights sunrise/sunset are
    // Invalid Dates, so fall back to 24h / 0h.
    const bufferHours = bufferMinutes / 60;
    let hikingHoursAvailable: number;
    let startBeforeSunrise: boolean;
    let endAfterSunset: boolean;
    if (daylight.polarDay) {
      hikingHoursAvailable = Math.max(0, 24 - bufferHours);
      startBeforeSunrise = false;
      endAfterSunset = false;
    } else if (daylight.polarNight) {
      hikingHoursAvailable = 0;
      // No sunrise to wait for: any walking at all is in the dark.
      startBeforeSunrise = distanceToday > 0;
      endAfterSunset = distanceToday > 0;
    } else {
      const startMs = daylight.sunrise.getTime() + startTimeOffset * 60000;
      const stopMs = daylight.sunset.getTime() - endTimeOffset * 60000;
      // Offsets longer than the day itself leave nothing, not negative hours.
      hikingHoursAvailable = Math.max(0, (stopMs - startMs) / 3600000 - bufferHours);
      startBeforeSunrise = startTimeOffset < 0;
      const finishMs = startMs + (hikingHoursNeeded + bufferHours) * 3600000;
      endAfterSunset = finishMs > daylight.sunset.getTime();
    }

    const nightHikingRequired = hikingHoursNeeded > hikingHoursAvailable;

    if (nightHikingRequired) {
      nightHikingDays++;
    }

    // Track shortest/longest days
    if (daylight.daylightHours < shortestDay.hours) {
      shortestDay = { date, hours: daylight.daylightHours };
    }
    if (daylight.daylightHours > longestDay.hours) {
      longestDay = { date, hours: daylight.daylightHours };
    }

    days.push({
      date,
      startLocation,
      endLocation,
      sunrise: daylight.sunrise,
      sunset: daylight.sunset,
      daylightHours: daylight.daylightHours,
      hikingHoursAvailable,
      nightHikingRequired,
      startBeforeSunrise,
      endAfterSunset,
      distanceKm: distanceToday,
      polarDay: daylight.polarDay,
      polarNight: daylight.polarNight,
    });

    currentDist = endDist;
  }

  return {
    days,
    totalDays: days.length,
    totalDistance,
    nightHikingDays,
    shortestDay,
    longestDay,
    utcOffsetHours,
  };
}

/**
 * Format a date as HH:MM.
 *
 * When `utcOffsetHours` is provided the time is rendered in that fixed
 * offset (i.e. route-local time); otherwise it falls back to the browser's
 * local time zone. Invalid dates (e.g. polar day/night sunrise/sunset)
 * render as an em dash.
 */
export function formatTime(date: Date, utcOffsetHours?: number): string {
  if (isNaN(date.getTime())) return '—';

  if (utcOffsetHours !== undefined) {
    const shifted = shiftToUtcOffset(date, utcOffsetHours);
    const h = shifted.getUTCHours().toString().padStart(2, '0');
    const m = shifted.getUTCMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Format daylight hours as Xh Ym
 */
export function formatDaylightHours(hours: number): string {
  // Round to whole minutes first: rounding the minutes part on its own turns
  // 5.999 h into "5h 60m".
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/**
 * Get moon phase and illumination for a date
 */
export function getMoonInfo(date: Date): {
  phase: number;
  illumination: number;
  phaseName: string;
} {
  const moon = SunCalc.getMoonIllumination(date);

  // Determine phase name
  let phaseName: string;
  const phase = moon.phase;

  if (phase < 0.03 || phase >= 0.97) {
    phaseName = 'New Moon';
  } else if (phase < 0.22) {
    phaseName = 'Waxing Crescent';
  } else if (phase < 0.28) {
    phaseName = 'First Quarter';
  } else if (phase < 0.47) {
    phaseName = 'Waxing Gibbous';
  } else if (phase < 0.53) {
    phaseName = 'Full Moon';
  } else if (phase < 0.72) {
    phaseName = 'Waning Gibbous';
  } else if (phase < 0.78) {
    phaseName = 'Last Quarter';
  } else {
    phaseName = 'Waning Crescent';
  }

  return {
    phase: moon.phase,
    illumination: moon.fraction,
    phaseName,
  };
}

/**
 * Export daylight plan to CSV
 */
export function exportDaylightPlanToCSV(plan: DaylightPlan): string {
  const offset = plan.utcOffsetHours;
  const offsetLabel = formatUtcOffset(offset);

  const headers = [
    'Day',
    'Date',
    'Start Lat',
    'Start Lon',
    'End Lat',
    'End Lon',
    'Distance (km)',
    `Sunrise (${offsetLabel})`,
    `Sunset (${offsetLabel})`,
    'Daylight Hours',
    'Available Hiking Hours',
    'Night Hiking Required',
  ];

  const rows = plan.days.map((day, i) => [
    i + 1,
    // Route-local calendar date (a bare toISOString() would report the UTC
    // day, which can be off by one relative to the route's time zone)
    formatDateISO(day.date, offset),
    day.startLocation.lat.toFixed(6),
    day.startLocation.lon.toFixed(6),
    day.endLocation.lat.toFixed(6),
    day.endLocation.lon.toFixed(6),
    day.distanceKm.toFixed(1),
    day.polarDay ? 'sun up all day' : day.polarNight ? 'no sunrise' : formatTime(day.sunrise, offset),
    day.polarDay ? 'no sunset' : day.polarNight ? 'sun down all day' : formatTime(day.sunset, offset),
    formatDaylightHours(day.daylightHours),
    formatDaylightHours(day.hikingHoursAvailable),
    day.nightHikingRequired ? 'Yes' : 'No',
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}
