import { describe, it, expect } from 'vitest';
import {
  createDaylightPlan,
  exportDaylightPlanToCSV,
  getDaylightInfo,
  estimateUtcOffset,
  formatUtcOffset,
  formatDateISO,
  formatTime,
  formatDaylightHours,
} from './daylight';

// All assertions in this file use fixed-UTC-offset math (Date.UTC / getTime),
// so they are deterministic regardless of the host machine's time zone.

describe('createDaylightPlan', () => {
  // Route in New Zealand (~lon 174.5, UTC+12): 100 points heading north,
  // each step ~1.11 km, total ~110 km.
  function createNZRoute(): { lat: number; lon: number }[] {
    return Array.from({ length: 100 }, (_, i) => ({
      lat: -41.3 + i * 0.01,
      lon: 174.5,
    }));
  }

  // Short route on Svalbard (~78N)
  function createSvalbardRoute(): { lat: number; lon: number }[] {
    return Array.from({ length: 5 }, (_, i) => ({
      lat: 78.2 + i * 0.01,
      lon: 15.6,
    }));
  }

  it('should split a route into days by daily target distance', () => {
    const plan = createDaylightPlan(createNZRoute(), {
      startDate: '2026-01-15',
      dailyTargetKm: 30,
    });

    // ~110 km at 30 km/day -> 4 days
    expect(plan.totalDays).toBe(Math.ceil(plan.totalDistance / 30));
    expect(plan.totalDays).toBe(4);
    expect(plan.days).toHaveLength(4);

    // Full days cover exactly the daily target; the last day gets the rest
    expect(plan.days[0].distanceKm).toBeCloseTo(30, 6);
    expect(plan.days[1].distanceKm).toBeCloseTo(30, 6);
    expect(plan.days[2].distanceKm).toBeCloseTo(30, 6);
    expect(plan.days[3].distanceKm).toBeCloseTo(plan.totalDistance - 90, 6);

    // Per-day distances sum to the total
    const sum = plan.days.reduce((acc, d) => acc + d.distanceKm, 0);
    expect(sum).toBeCloseTo(plan.totalDistance, 6);

    // Consecutive days are exactly 24h apart
    expect(plan.days[1].date.getTime() - plan.days[0].date.getTime()).toBe(86400000);

    // Day locations progress along the route
    expect(plan.days[0].startLocation.lat).toBeCloseTo(-41.3, 6);
    expect(plan.days[1].startLocation.lat).toBeGreaterThan(plan.days[0].startLocation.lat);
    expect(plan.days[3].endLocation.lat).toBeCloseTo(-40.31, 3);
  });

  it('should compute plausible daylight for a mid-latitude summer route', () => {
    const plan = createDaylightPlan(createNZRoute(), {
      startDate: '2026-01-15',
      dailyTargetKm: 30,
    });

    for (const day of plan.days) {
      expect(day.polarDay).toBe(false);
      expect(day.polarNight).toBe(false);
      // NZ mid-January: roughly 14-15.5 hours of daylight
      expect(day.daylightHours).toBeGreaterThan(13);
      expect(day.daylightHours).toBeLessThan(16);
      expect(Number.isNaN(day.hikingHoursAvailable)).toBe(false);
    }

    // Sunrise rendered in route-local time is in the early morning,
    // proving the day anchor and offset math line up with the route's clock
    const sunriseLocal = formatTime(plan.days[0].sunrise, plan.utcOffsetHours);
    const sunriseHour = parseInt(sunriseLocal.split(':')[0], 10);
    expect(sunriseHour).toBeGreaterThanOrEqual(3);
    expect(sunriseHour).toBeLessThanOrEqual(9);
  });

  it('should estimate the UTC offset from route longitude (regression)', () => {
    // New Zealand route -> UTC+12
    const nzPlan = createDaylightPlan(createNZRoute(), {
      startDate: '2026-01-15',
      dailyTargetKm: 30,
    });
    expect(nzPlan.utcOffsetHours).toBe(12);

    // US west coast route (~lon -120.5) -> UTC-8
    const usRoute = Array.from({ length: 50 }, (_, i) => ({
      lat: 47 + i * 0.01,
      lon: -120.5,
    }));
    const usPlan = createDaylightPlan(usRoute, {
      startDate: '2026-08-18',
      dailyTargetKm: 30,
    });
    expect(usPlan.utcOffsetHours).toBe(-8);

    // Helper directly
    expect(estimateUtcOffset(174.5)).toBe(12);
    expect(estimateUtcOffset(-120)).toBe(-8);
    expect(estimateUtcOffset(0)).toBe(0);
  });

  it('should interpret a string startDate as a route-local calendar day (regression)', () => {
    // UTC+12 route: '2026-01-15' local is 2026-01-14 in UTC, so a naive
    // UTC/browser-TZ interpretation would shift days off by one.
    const nzPlan = createDaylightPlan(createNZRoute(), {
      startDate: '2026-01-15',
      dailyTargetKm: 30,
    });
    expect(formatDateISO(nzPlan.days[0].date, nzPlan.utcOffsetHours)).toBe('2026-01-15');
    expect(formatDateISO(nzPlan.days[1].date, nzPlan.utcOffsetHours)).toBe('2026-01-16');
    expect(formatDateISO(nzPlan.days[3].date, nzPlan.utcOffsetHours)).toBe('2026-01-18');
    // The day is anchored at route-local noon
    expect(nzPlan.days[0].date.getTime()).toBe(Date.UTC(2026, 0, 15, 0));

    // Same check for a negative offset (UTC-8)
    const usRoute = Array.from({ length: 50 }, (_, i) => ({ lat: 47 + i * 0.01, lon: -120.5 }));
    const usPlan = createDaylightPlan(usRoute, {
      startDate: '2026-08-18',
      dailyTargetKm: 30,
    });
    expect(formatDateISO(usPlan.days[0].date, usPlan.utcOffsetHours)).toBe('2026-08-18');
    expect(usPlan.days[0].date.getTime()).toBe(Date.UTC(2026, 7, 18, 20));
  });

  it('should handle polar night without NaN (regression)', () => {
    const plan = createDaylightPlan(createSvalbardRoute(), {
      startDate: '2026-12-15',
      dailyTargetKm: 5,
    });

    expect(plan.days).toHaveLength(1);
    const day = plan.days[0];

    expect(day.polarNight).toBe(true);
    expect(day.polarDay).toBe(false);
    expect(day.daylightHours).toBe(0);
    expect(day.hikingHoursAvailable).toBe(0);
    // Any distance requires hiking in the dark
    expect(day.nightHikingRequired).toBe(true);
    expect(plan.nightHikingDays).toBe(1);
    expect(plan.shortestDay.hours).toBe(0);

    // No NaN in any numeric field
    expect(Number.isNaN(day.daylightHours)).toBe(false);
    expect(Number.isNaN(day.hikingHoursAvailable)).toBe(false);
    expect(Number.isNaN(day.distanceKm)).toBe(false);
    expect(Number.isNaN(plan.totalDistance)).toBe(false);
  });

  it('should handle polar day as 24h of daylight (regression)', () => {
    const plan = createDaylightPlan(createSvalbardRoute(), {
      startDate: '2026-06-15',
      dailyTargetKm: 5,
    });

    const day = plan.days[0];
    expect(day.polarDay).toBe(true);
    expect(day.polarNight).toBe(false);
    expect(day.daylightHours).toBe(24);
    expect(day.hikingHoursAvailable).toBe(24);
    expect(day.nightHikingRequired).toBe(false);
    expect(plan.longestDay.hours).toBe(24);
  });
});

describe('getDaylightInfo', () => {
  it('should flag polar night at high latitude in December', () => {
    const info = getDaylightInfo(78.2, 15.6, new Date(Date.UTC(2026, 11, 15, 12)));

    expect(info.polarNight).toBe(true);
    expect(info.polarDay).toBe(false);
    expect(info.daylightHours).toBe(0);
  });

  it('should flag polar day at high latitude in June', () => {
    const info = getDaylightInfo(78.2, 15.6, new Date(Date.UTC(2026, 5, 15, 12)));

    expect(info.polarDay).toBe(true);
    expect(info.polarNight).toBe(false);
    expect(info.daylightHours).toBe(24);
  });

  it('should return normal sunrise/sunset at mid latitudes', () => {
    const info = getDaylightInfo(-41.3, 174.5, new Date(Date.UTC(2026, 0, 15, 0)));

    expect(info.polarDay).toBe(false);
    expect(info.polarNight).toBe(false);
    expect(Number.isNaN(info.sunrise.getTime())).toBe(false);
    expect(Number.isNaN(info.sunset.getTime())).toBe(false);
    expect(info.sunset.getTime()).toBeGreaterThan(info.sunrise.getTime());
    expect(info.daylightHours).toBeGreaterThan(13);
    expect(info.daylightHours).toBeLessThan(16);
  });
});

describe('exportDaylightPlanToCSV', () => {
  it('should include the Distance column and route-local times', () => {
    const route = Array.from({ length: 100 }, (_, i) => ({ lat: -41.3 + i * 0.01, lon: 174.5 }));
    const plan = createDaylightPlan(route, { startDate: '2026-01-15', dailyTargetKm: 30 });
    const csv = exportDaylightPlanToCSV(plan);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(plan.totalDays + 1);
    expect(lines[0]).toContain('Distance (km)');
    expect(lines[0]).toContain('Sunrise (UTC+12)');
    expect(lines[0]).toContain('Sunset (UTC+12)');
    expect(lines[1]).toContain('2026-01-15');
    expect(lines[1]).toContain('30.0');
    expect(csv).not.toContain('NaN');
  });

  it('should render polar night rows without NaN (regression)', () => {
    const route = Array.from({ length: 5 }, (_, i) => ({ lat: 78.2 + i * 0.01, lon: 15.6 }));
    const plan = createDaylightPlan(route, { startDate: '2026-12-15', dailyTargetKm: 5 });
    const csv = exportDaylightPlanToCSV(plan);

    expect(csv).not.toContain('NaN');
    expect(csv).toContain('no sunrise');
    expect(csv).toContain('0h 0m');
    expect(csv).toContain('2026-12-15');
  });
});

describe('formatTime', () => {
  it('should format deterministically with an explicit UTC offset', () => {
    const date = new Date(Date.UTC(2026, 0, 15, 20, 30));

    expect(formatTime(date, 12)).toBe('08:30'); // next day, 08:30 UTC+12
    expect(formatTime(date, -8)).toBe('12:30');
    expect(formatTime(date, 0)).toBe('20:30');
  });

  it('should render invalid dates as an em dash', () => {
    expect(formatTime(new Date(NaN), 12)).toBe('—');
    expect(formatTime(new Date(NaN))).toBe('—');
  });
});

describe('format helpers', () => {
  it('should format UTC offsets with a sign', () => {
    expect(formatUtcOffset(12)).toBe('UTC+12');
    expect(formatUtcOffset(-8)).toBe('UTC-8');
    expect(formatUtcOffset(0)).toBe('UTC+0');
  });

  it('should format daylight hours as Xh Ym', () => {
    expect(formatDaylightHours(14.5)).toBe('14h 30m');
    expect(formatDaylightHours(0)).toBe('0h 0m');
    expect(formatDaylightHours(24)).toBe('24h 0m');
  });

  it('should format route-local ISO dates', () => {
    // 2026-01-14 23:00 UTC is already 2026-01-15 in UTC+12
    expect(formatDateISO(new Date(Date.UTC(2026, 0, 14, 23)), 12)).toBe('2026-01-15');
    // ...but still 2026-01-14 in UTC-8
    expect(formatDateISO(new Date(Date.UTC(2026, 0, 14, 23)), -8)).toBe('2026-01-14');
  });
});
