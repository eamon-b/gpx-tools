import { describe, it, expect } from 'vitest';
import { processTravelPlan, CSV_PROCESSOR_DEFAULTS, DEFAULT_RESUPPLY_KEYWORDS } from './csv-processor';

describe('processTravelPlan', () => {
  // Sample CSV in Caltopo format (2 header rows + data)
  const sampleCsv = `Melbourne to Canberra,,,,,,,,,,
,,,,,,,,,,
Start,,"-37.83633, 144.91464",23m,,,,,,,
Yarra Junction,1,"-37.78099, 145.61273",112m,+636m,-530m,81.6km,84° TN,15 hr,15 hr,"woolies 7-10, cafes"
Warburton,2,"-37.75448, 145.68887",158m,+48m,-23m,3.3km,89° TN,40 min,17 hr,"IGA 7-9, cafes"
Woods Point,3,"-37.56927, 146.25340",684m,+1818m,-1404m,79.8km,71° TN,20 hr,42 hr,"general store"
End,4,"-35.22538, 149.16549",610m,+299m,-179m,29.7km,61° TN,5 hr,47 hr,
total,,,,+2801m,-2136m,194.4km,,,47 hr,`;

  it('should process a valid Caltopo CSV', () => {
    const result = processTravelPlan(sampleCsv);

    // Should skip the "total" row
    expect(result.stats.totalPoints).toBe(5);
  });

  it('should calculate cumulative distances correctly', () => {
    const result = processTravelPlan(sampleCsv);

    // Check the output CSV contains cumulative values
    expect(result.processedPlan).toContain('Total Distance');
    expect(result.processedPlan).toContain('Total Ascent');
    expect(result.processedPlan).toContain('Total Descent');
  });

  it('should detect resupply keywords', () => {
    const result = processTravelPlan(sampleCsv);

    // "woolies", "IGA", and "general" should be detected
    // Plus "End" if includeEndAsResupply is true (default)
    expect(result.stats.resupplyCount).toBeGreaterThanOrEqual(3);
  });

  it('should include End as resupply when option is true', () => {
    const resultWithEnd = processTravelPlan(sampleCsv, { includeEndAsResupply: true });
    const resultWithoutEnd = processTravelPlan(sampleCsv, { includeEndAsResupply: false });

    expect(resultWithEnd.stats.resupplyCount).toBe(resultWithoutEnd.stats.resupplyCount + 1);
  });

  it('should use custom resupply keywords', () => {
    const result = processTravelPlan(sampleCsv, {
      resupplyKeywords: ['cafes'],
      includeEndAsResupply: false,
    });

    // Only "cafes" should match (Yarra Junction and Warburton)
    expect(result.stats.resupplyCount).toBe(2);
  });

  it('should generate two output CSVs', () => {
    const result = processTravelPlan(sampleCsv);

    expect(result.processedPlan).toBeTruthy();
    expect(result.resupplyPoints).toBeTruthy();
    expect(result.processedPlan).toContain('Location');
    expect(result.resupplyPoints).toContain('Location');
  });

  it('should handle empty keywords array', () => {
    const result = processTravelPlan(sampleCsv, {
      resupplyKeywords: [],
      includeEndAsResupply: false,
    });

    expect(result.stats.resupplyCount).toBe(0);
  });

  it('should export default options and keywords', () => {
    expect(CSV_PROCESSOR_DEFAULTS).toBeDefined();
    expect(CSV_PROCESSOR_DEFAULTS.resupplyKeywords).toBeDefined();
    expect(CSV_PROCESSOR_DEFAULTS.includeEndAsResupply).toBe(true);

    expect(DEFAULT_RESUPPLY_KEYWORDS).toBeInstanceOf(Array);
    expect(DEFAULT_RESUPPLY_KEYWORDS).toContain('grocer');
    expect(DEFAULT_RESUPPLY_KEYWORDS).toContain('iga');
  });
});

describe('elevation parsing', () => {
  it('should parse positive elevation values', () => {
    const csv = `Header,,,,,,,,,,
,,,,,,,,,,
Start,,coords,123m,,,,,,,
total,,,,,,,,,,`;

    const result = processTravelPlan(csv);
    expect(result.processedPlan).toContain('123');
  });

  it('should parse negative elevation values', () => {
    const csv = `Header,,,,,,,,,,
,,,,,,,,,,
Start,,coords,-45m,,,,,,,
total,,,,,,,,,,`;

    const result = processTravelPlan(csv);
    expect(result.processedPlan).toContain('-45');
  });

  it('should handle missing elevation', () => {
    const csv = `Header,,,,,,,,,,
,,,,,,,,,,
Start,,coords,,,,,,,,
total,,,,,,,,,,`;

    const result = processTravelPlan(csv);
    expect(result.stats.totalPoints).toBe(1);
  });
});

describe('distance parsing', () => {
  it('should parse kilometer distances', () => {
    const csv = `Header,,,,,,,,,,
,,,,,,,,,,
Point1,,coords,0m,+0m,-0m,5.2km,,,,"notes"
Point2,,coords,0m,+0m,-0m,10.5km,,,,"notes"
total,,,,,,,,,,`;

    const result = processTravelPlan(csv);
    // Total distance should be 15.7 km
    expect(result.stats.totalDistance).toBeCloseTo(15.7, 1);
  });

  it('should parse meter distances and convert to km', () => {
    const csv = `Header,,,,,,,,,,
,,,,,,,,,,
Point1,,coords,0m,+0m,-0m,500m,,,,"notes"
total,,,,,,,,,,`;

    const result = processTravelPlan(csv);
    // 500m = 0.5km
    expect(result.stats.totalDistance).toBeCloseTo(0.5, 2);
  });

  it('should handle missing distance values', () => {
    const csv = `Header,,,,,,,,,,
,,,,,,,,,,
Start,,coords,0m,,,,,,,
total,,,,,,,,,,`;

    const result = processTravelPlan(csv);
    expect(result.stats.totalDistance).toBe(0);
  });
});

describe('resupply keyword detection', () => {
  const makeCsv = (notes: string) => `Header,,,,,,,,,,
,,,,,,,,,,
Point,,coords,0m,+0m,-0m,1km,,,,"${notes}"
total,,,,,,,,,,`;

  it('should be case-insensitive', () => {
    const result1 = processTravelPlan(makeCsv('WOOLIES'), {
      resupplyKeywords: ['woolies'],
      includeEndAsResupply: false,
    });
    const result2 = processTravelPlan(makeCsv('Woolies'), {
      resupplyKeywords: ['woolies'],
      includeEndAsResupply: false,
    });

    expect(result1.stats.resupplyCount).toBe(1);
    expect(result2.stats.resupplyCount).toBe(1);
  });

  it('should match partial words', () => {
    const result = processTravelPlan(makeCsv('supermarket grocery'), {
      resupplyKeywords: ['grocer'],
      includeEndAsResupply: false,
    });

    expect(result.stats.resupplyCount).toBe(1);
  });

  it('should handle notes with special characters', () => {
    const result = processTravelPlan(makeCsv('IGA 7-9, café & pub'), {
      resupplyKeywords: ['iga'],
      includeEndAsResupply: false,
    });

    expect(result.stats.resupplyCount).toBe(1);
  });
});

describe('cumulative calculations', () => {
  const csv = `Header,,,,,,,,,,
,,,,,,,,,,
Point1,,coords,100m,+50m,-20m,10km,,,,"notes"
Point2,,coords,130m,+30m,-0m,5km,,,,"notes"
Point3,,coords,100m,+0m,-30m,8km,,,,"notes"
total,,,,,,,,,,`;

  it('should calculate correct total distance', () => {
    const result = processTravelPlan(csv);
    expect(result.stats.totalDistance).toBeCloseTo(23, 0);
  });

  it('should calculate correct total ascent', () => {
    const result = processTravelPlan(csv);
    // 50 + 30 + 0 = 80
    expect(result.stats.totalAscent).toBe(80);
  });

  it('should calculate correct total descent', () => {
    const result = processTravelPlan(csv);
    // 20 + 0 + 30 = 50
    expect(result.stats.totalDescent).toBe(50);
  });
});
