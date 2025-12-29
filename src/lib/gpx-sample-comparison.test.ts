import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { processGpxTravelPlan } from './gpx-datasheet';
import Papa from 'papaparse';

const SAMPLES_DIR = join(__dirname, '../../samples');

/**
 * Find GPX files in the samples directory.
 */
function findSampleGpxFiles(): Array<{ name: string; gpxPath: string }> {
  try {
    const files = readdirSync(SAMPLES_DIR);
    return files
      .filter(f => f.endsWith('.gpx'))
      .map(f => ({
        name: f.replace('.gpx', ''),
        gpxPath: join(SAMPLES_DIR, f),
      }));
  } catch {
    return [];
  }
}

describe('GPX Sample Processing', () => {
  const samples = findSampleGpxFiles();

  if (samples.length === 0) {
    it.skip('No GPX files found in samples directory', () => {});
    return;
  }

  for (const sample of samples) {
    describe(`${sample.name}`, () => {
      it('should successfully process the GPX file', { timeout: 30000 }, () => {
        const gpxContent = readFileSync(sample.gpxPath, 'utf-8');

        // Process GPX - this should not throw
        const result = processGpxTravelPlan(gpxContent, {
          waypointMaxDistance: 500,
          distanceUnit: 'mi',
          elevationUnit: 'ft',
          includeEndAsResupply: true,
          includeStartAsResupply: false,
        });

        // Verify we got valid output
        expect(result.processedPlan).toBeTruthy();
        expect(result.resupplyPoints).toBeTruthy();
        expect(result.stats.totalPoints).toBeGreaterThan(0);
      });

      it('should produce reasonable output values', { timeout: 30000 }, () => {
        const gpxContent = readFileSync(sample.gpxPath, 'utf-8');

        const result = processGpxTravelPlan(gpxContent, {
          waypointMaxDistance: 500,
          distanceUnit: 'mi',
          elevationUnit: 'ft',
        });

        // Parse the output CSV
        const gpxParsed = Papa.parse(result.processedPlan, { header: true });
        const gpxRows = gpxParsed.data as Array<Record<string, string>>;

        // Filter out empty rows
        const validRows = gpxRows.filter(r => r['Location']);

        // Should have multiple waypoints
        expect(validRows.length).toBeGreaterThan(1);

        // Total distance should be positive and reasonable (< 5000 miles)
        const lastRow = validRows[validRows.length - 1];
        const totalDistance = parseFloat(lastRow?.['Total Distance (mi)'] || '0');
        expect(totalDistance).toBeGreaterThan(0);
        expect(totalDistance).toBeLessThan(5000);

        // Distance should be cumulative within each track
        // Track headers reset the cumulative distance to 0
        let prevDistance = 0;
        for (const row of validRows) {
          const dist = parseFloat(row['Total Distance (mi)'] || '0');
          // If distance is 0 or empty, this might be a track header row - reset tracking
          if (dist === 0 && row['Elevation (ft)'] === '') {
            prevDistance = 0;
          } else {
            expect(dist).toBeGreaterThanOrEqual(prevDistance);
            prevDistance = dist;
          }
        }

        // Ascent and descent should be non-negative
        const totalAscent = parseFloat(lastRow?.['Total Ascent (ft)'] || '0');
        const totalDescent = parseFloat(lastRow?.['Total Descent (ft)'] || '0');
        expect(totalAscent).toBeGreaterThanOrEqual(0);
        expect(totalDescent).toBeGreaterThanOrEqual(0);
      });

      it('should generate valid CSV output', { timeout: 30000 }, () => {
        const gpxContent = readFileSync(sample.gpxPath, 'utf-8');

        const result = processGpxTravelPlan(gpxContent, {
          waypointMaxDistance: 500,
          distanceUnit: 'km',
          elevationUnit: 'm',
          csvDelimiter: ',',
        });

        // Parse both outputs - should not throw
        const processedParsed = Papa.parse(result.processedPlan, { header: true });
        const resupplyParsed = Papa.parse(result.resupplyPoints, { header: true });

        // Verify headers are present
        expect(processedParsed.meta.fields).toContain('Location');
        expect(processedParsed.meta.fields).toContain('Total Distance (km)');
        expect(processedParsed.meta.fields).toContain('Total Ascent (m)');

        expect(resupplyParsed.meta.fields).toContain('Location');
        expect(resupplyParsed.meta.fields).toContain('Total Distance (km)');
      });

      it('should respect unit options', { timeout: 60000 }, () => {
        const gpxContent = readFileSync(sample.gpxPath, 'utf-8');

        const resultKm = processGpxTravelPlan(gpxContent, {
          waypointMaxDistance: 500,
          distanceUnit: 'km',
          elevationUnit: 'm',
        });

        const resultMi = processGpxTravelPlan(gpxContent, {
          waypointMaxDistance: 500,
          distanceUnit: 'mi',
          elevationUnit: 'ft',
        });

        // Headers should reflect units
        expect(resultKm.processedPlan).toContain('Distance (km)');
        expect(resultKm.processedPlan).toContain('Elevation (m)');
        expect(resultMi.processedPlan).toContain('Distance (mi)');
        expect(resultMi.processedPlan).toContain('Elevation (ft)');

        // Stats should be the same (stored in km/m internally)
        expect(resultKm.stats.totalDistance).toBeCloseTo(resultMi.stats.totalDistance, 1);
        expect(resultKm.stats.totalAscent).toBeCloseTo(resultMi.stats.totalAscent, 0);
      });
    });
  }
});
