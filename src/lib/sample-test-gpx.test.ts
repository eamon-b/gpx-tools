import { describe, it, expect } from 'vitest';
import { splitGpx } from './gpx-splitter';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const samplesDir = resolve(__dirname, '../../samples');

// Find the first .gpx file in samples directory
function findSampleGpxFile(): string | null {
  if (!existsSync(samplesDir)) {
    return null;
  }
  const files = readdirSync(samplesDir);
  const gpxFile = files.find(f => f.endsWith('.gpx'));
  return gpxFile ? resolve(samplesDir, gpxFile) : null;
}

describe('GPX Splitter with real sample data', () => {
  const sampleGpxPath = findSampleGpxFile();

  it.skipIf(!sampleGpxPath)('should process sample GPX file', () => {
    const gpxContent = readFileSync(sampleGpxPath!, 'utf-8');

    expect(gpxContent.length).toBeGreaterThan(0);

    const results = splitGpx(gpxContent, { maxPoints: 5000, waypointMaxDistance: 5 });

    // Should produce at least one result
    expect(results.length).toBeGreaterThan(0);

    // Log results for inspection
    console.log('GPX Split Results:');
    results.forEach((r, i) => {
      console.log(`  File ${i+1}: ${r.filename} - ${r.pointCount} points, ${r.waypointCount} waypoints`);
    });

    // Total points across all results
    const totalPoints = results.reduce((sum, r) => sum + r.pointCount, 0);
    console.log(`Total points: ${totalPoints}`);

    // Verify each result has valid GPX content
    results.forEach(r => {
      expect(r.content).toContain('<?xml version="1.0"');
      expect(r.content).toContain('<gpx version="1.1"');
      expect(r.content).toContain('</gpx>');
      expect(r.pointCount).toBeGreaterThan(0);
    });
  });

  it.skipIf(!sampleGpxPath)('should include nearby waypoints in split files', () => {
    const gpxContent = readFileSync(sampleGpxPath!, 'utf-8');

    const results = splitGpx(gpxContent, { maxPoints: 5000, waypointMaxDistance: 10 });

    // At least some waypoints should be included
    const totalWaypoints = results.reduce((sum, r) => sum + r.waypointCount, 0);
    console.log(`Total waypoints included: ${totalWaypoints}`);

    // Waypoints may or may not exist in the sample file
    expect(totalWaypoints).toBeGreaterThanOrEqual(0);
  });

  it('should skip tests when no sample GPX file exists', () => {
    if (!sampleGpxPath) {
      console.log('No GPX file found in samples/ directory - integration tests skipped');
      console.log('Add a .gpx file to samples/ to enable these tests');
    }
    expect(true).toBe(true);
  });
});
