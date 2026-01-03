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
  hikingHoursAvailable: number;
  nightHikingRequired: boolean;
  startBeforeSunrise: boolean;
  endAfterSunset: boolean;
}

export interface DaylightPlanOptions {
  startDate: Date;
  dailyTargetKm: number;
  hikingSpeedKmh?: number;
  bufferMinutes?: number;
  startTimeOffset?: number; // minutes after sunrise to start
  endTimeOffset?: number;   // minutes before sunset to end
}

export interface DaylightPlan {
  days: DaylightPlanDay[];
  totalDays: number;
  totalDistance: number;
  nightHikingDays: number;
  shortestDay: { date: Date; hours: number };
  longestDay: { date: Date; hours: number };
}

/**
 * Get daylight information for a specific location and date
 */
export function getDaylightInfo(lat: number, lon: number, date: Date): DaylightInfo {
  const times = SunCalc.getTimes(date, lat, lon);

  const daylightMs = times.sunset.getTime() - times.sunrise.getTime();
  const daylightHours = daylightMs / (1000 * 60 * 60);

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
  };
}

/**
 * Get daylight information for multiple dates at a location
 */
export function getDaylightRange(
  lat: number,
  lon: number,
  startDate: Date,
  numDays: number
): DaylightInfo[] {
  const results: DaylightInfo[] = [];

  for (let i = 0; i < numDays; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    results.push(getDaylightInfo(lat, lon, date));
  }

  return results;
}

/**
 * Calculate daylight along a route for a given date range
 */
export function getDaylightAlongRoute(
  routePoints: { lat: number; lon: number; dist?: number }[],
  startDate: Date,
  numDays: number,
  samplesPerDay: number = 10
): LocationDaylight[][] {
  const results: LocationDaylight[][] = [];
  const totalPoints = routePoints.length;
  const sampleStep = Math.max(1, Math.floor(totalPoints / (numDays * samplesPerDay)));

  for (let day = 0; day < numDays; day++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + day);

    const dayResults: LocationDaylight[] = [];

    // Sample points along the route
    for (let i = 0; i < totalPoints; i += sampleStep) {
      const point = routePoints[i];
      const info = getDaylightInfo(point.lat, point.lon, date);

      dayResults.push({
        ...info,
        lat: point.lat,
        lon: point.lon,
        distanceFromStart: point.dist,
      });
    }

    results.push(dayResults);
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

  const pointsWithDist = calculateCumulativeDistances(routePoints);
  const totalDistance = pointsWithDist[pointsWithDist.length - 1].dist;
  const estimatedDays = Math.ceil(totalDistance / dailyTargetKm);

  const days: DaylightPlanDay[] = [];
  let currentDist = 0;
  let shortestDay = { date: startDate, hours: Infinity };
  let longestDay = { date: startDate, hours: 0 };
  let nightHikingDays = 0;

  for (let dayNum = 0; dayNum < estimatedDays && currentDist < totalDistance; dayNum++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + dayNum);

    const startLocation = findPointAtDistance(pointsWithDist, currentDist);
    const endDist = Math.min(currentDist + dailyTargetKm, totalDistance);
    const endLocation = findPointAtDistance(pointsWithDist, endDist);

    // Get daylight for start location (approximate - could vary over day's hike)
    const daylight = getDaylightInfo(startLocation.lat, startLocation.lon, date);

    // Calculate actual hiking hours needed
    const distanceToday = endDist - currentDist;
    const hikingHoursNeeded = distanceToday / hikingSpeedKmh;

    // Calculate available daylight hours (with offsets)
    const availableMs = (
      daylight.sunset.getTime() - endTimeOffset * 60000 -
      (daylight.sunrise.getTime() + startTimeOffset * 60000)
    );
    const hikingHoursAvailable = availableMs / (1000 * 60 * 60);

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
      startBeforeSunrise: false, // Could be calculated based on schedule
      endAfterSunset: nightHikingRequired,
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
  };
}

/**
 * Format a date as HH:MM in local time
 */
export function formatTime(date: Date): string {
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
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
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
  const headers = [
    'Day',
    'Date',
    'Start Lat',
    'Start Lon',
    'End Lat',
    'End Lon',
    'Sunrise',
    'Sunset',
    'Daylight Hours',
    'Available Hiking Hours',
    'Night Hiking Required',
  ];

  const rows = plan.days.map((day, i) => [
    i + 1,
    day.date.toISOString().split('T')[0],
    day.startLocation.lat.toFixed(6),
    day.startLocation.lon.toFixed(6),
    day.endLocation.lat.toFixed(6),
    day.endLocation.lon.toFixed(6),
    formatTime(day.sunrise),
    formatTime(day.sunset),
    formatDaylightHours(day.daylightHours),
    formatDaylightHours(day.hikingHoursAvailable),
    day.nightHikingRequired ? 'Yes' : 'No',
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}
