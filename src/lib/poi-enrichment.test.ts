import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  enrichRoute,
  exportPOIsToCSV,
  computeCumulativeDistances,
  getPOIName,
  type EnrichedPOI,
} from './poi-enrichment';
import { apiClient, type POI } from './api-client';
import { haversineDistance } from './distance';

describe('enrichRoute', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Route along the equator: each 0.001 degree of longitude is ~111m.
  // Small enough (with the 5km bounds buffer) to stay in a single query chunk.
  function createRoute(numPoints: number, lonStep = 0.001): { lat: number; lon: number }[] {
    return Array.from({ length: numPoints }, (_, i) => ({ lat: 0, lon: i * lonStep }));
  }

  function makePOI(id: number, lat: number, lon: number, tags: Record<string, string>): POI {
    return { id, type: 'node', lat, lon, tags };
  }

  it('should return POIs near the route, filtered by type and sorted along the route', async () => {
    const route = createRoute(200);

    const pois: POI[] = [
      // Water POI near route point ~150 (~111m off-route)
      makePOI(1, 0.001, 0.15, { amenity: 'drinking_water', name: 'Spring A' }),
      // Water POI on route point 10
      makePOI(2, 0, 0.01, { natural: 'spring' }),
      // Camping POI on route point 50
      makePOI(3, 0, 0.05, { tourism: 'camp_site', name: 'Camp X' }),
      // Water POI ~55 km from the route - beyond maxDistanceFromRoute
      makePOI(4, 0.5, 0.1, { amenity: 'drinking_water', name: 'Too Far' }),
      // POI with no recognizable category
      makePOI(5, 0, 0.02, { foo: 'bar' }),
      // Duplicate of POI 2 (e.g. returned by an overlapping chunk)
      makePOI(2, 0, 0.01, { natural: 'spring' }),
    ];

    const spy = vi.spyOn(apiClient, 'fetchPOIs').mockResolvedValue(pois);

    const result = await enrichRoute(route, {
      types: ['water', 'camping'],
      maxDistanceFromRoute: 2,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.failedChunks).toHaveLength(0);

    // POIs 4 (too far) and 5 (uncategorized) excluded; POI 2 deduplicated
    expect(result.pois).toHaveLength(3);
    expect(result.pois.map(p => p.id)).toEqual([2, 3, 1]);

    // Sorted by position along the route
    const indices = result.pois.map(p => p.nearestPointIndex);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);

    // Type buckets
    expect(result.byType.water.map(p => p.id)).toEqual([2, 1]);
    expect(result.byType.camping.map(p => p.id)).toEqual([3]);
    expect(result.stats.totalFound).toBe(3);
    expect(result.stats.byType.water).toBe(2);
    expect(result.stats.byType.camping).toBe(1);

    // distanceAlongRoute is populated from the cumulative route distance
    const cumulative = computeCumulativeDistances(route);
    const poi2 = result.pois.find(p => p.id === 2)!;
    expect(poi2.nearestPointIndex).toBe(10);
    expect(poi2.distanceAlongRoute).toBeCloseTo(cumulative[10], 6);
    expect(poi2.distanceFromRoute).toBeCloseTo(0, 6);

    const poi1 = result.pois.find(p => p.id === 1)!;
    expect(poi1.nearestPointIndex).toBe(150);
    expect(poi1.distanceFromRoute).toBeGreaterThan(0.1);
    expect(poi1.distanceFromRoute).toBeLessThan(0.15);
  });

  it('should exclude types not requested', async () => {
    const route = createRoute(100);
    vi.spyOn(apiClient, 'fetchPOIs').mockResolvedValue([
      makePOI(1, 0, 0.01, { amenity: 'drinking_water' }),
      makePOI(2, 0, 0.05, { tourism: 'camp_site' }),
    ]);

    const result = await enrichRoute(route, { types: ['water'] });

    expect(result.pois).toHaveLength(1);
    expect(result.pois[0].category).toBe('water');
  });

  it('should return partial results when one chunk fails (regression)', async () => {
    // Route spanning ~3.4 degrees of latitude splits into 3 query chunks
    const route = Array.from({ length: 69 }, (_, i) => ({ lat: i * 0.05, lon: 0 }));

    const spy = vi.spyOn(apiClient, 'fetchPOIs')
      .mockResolvedValueOnce([makePOI(1, 0.05, 0, { amenity: 'drinking_water' })])
      .mockRejectedValueOnce(new Error('Overpass timeout'))
      .mockResolvedValueOnce([makePOI(2, 3.0, 0, { tourism: 'camp_site' })]);

    const result = await enrichRoute(route, {
      types: ['water', 'camping'],
      maxDistanceFromRoute: 2,
    });

    expect(spy).toHaveBeenCalledTimes(3);
    // No throw: results from the successful chunks are kept
    expect(result.pois.map(p => p.id).sort()).toEqual([1, 2]);
    expect(result.failedChunks).toHaveLength(1);
    expect(result.failedChunks[0].chunkIndex).toBe(1);
    expect(result.failedChunks[0].error).toBe('Overpass timeout');
    expect(result.stats.queryChunks).toBe(3);
    expect(result.stats.failedChunks).toBe(1);
  });

  it('should throw when all chunks fail', async () => {
    const route = createRoute(10);
    vi.spyOn(apiClient, 'fetchPOIs').mockRejectedValue(new Error('boom'));

    await expect(enrichRoute(route, { types: ['water'] })).rejects.toThrow(
      /Failed to fetch POIs for all .*boom/
    );
  });

  it('should find the true nearest route point on a dense route (downsampling accuracy)', async () => {
    // Dense route: 400 points ~33m apart, so the ~150m coarse downsampling
    // pass actually skips points and the local refinement must recover the
    // full-resolution nearest point.
    const route = createRoute(400, 0.0003);
    const poi = makePOI(1, 0.0005, route[123].lon + 0.0001, { amenity: 'drinking_water' });

    vi.spyOn(apiClient, 'fetchPOIs').mockResolvedValue([poi]);

    const result = await enrichRoute(route, { types: ['water'] });
    expect(result.pois).toHaveLength(1);
    const enriched = result.pois[0];

    // Brute-force nearest point over the full-resolution route
    let bruteMin = Infinity;
    let bruteIndex = -1;
    for (let i = 0; i < route.length; i++) {
      const d = haversineDistance(poi.lat, poi.lon, route[i].lat, route[i].lon) / 1000;
      if (d < bruteMin) {
        bruteMin = d;
        bruteIndex = i;
      }
    }

    expect(enriched.nearestPointIndex).toBe(bruteIndex);
    expect(enriched.distanceFromRoute).toBeCloseTo(bruteMin, 9);
  });
});

describe('computeCumulativeDistances', () => {
  it('should start at 0 and increase monotonically', () => {
    const route = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
      { lat: 0, lon: 0.02 },
    ];
    const cumulative = computeCumulativeDistances(route);

    expect(cumulative).toHaveLength(3);
    expect(cumulative[0]).toBe(0);
    expect(cumulative[1]).toBeCloseTo(1.113, 2);
    expect(cumulative[2]).toBeCloseTo(2 * cumulative[1], 6);
  });

  it('should handle an empty route', () => {
    expect(computeCumulativeDistances([])).toEqual([]);
  });
});

describe('exportPOIsToCSV', () => {
  function makeEnriched(name: string): EnrichedPOI {
    return {
      id: 1,
      type: 'node',
      lat: -37.8136,
      lon: 144.9631,
      tags: { amenity: 'drinking_water', name },
      distanceFromRoute: 0.12,
      nearestPointIndex: 5,
      distanceAlongRoute: 3.4,
      category: 'water',
    };
  }

  it('should quote fields containing commas and quotes (regression)', () => {
    const poi = makeEnriched('Camp "Rest", Area');
    const csv = exportPOIsToCSV([poi]);
    const lines = csv.split('\n');

    // Header + one data row; the comma inside the name must not add a row/column
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'Name,Category,Latitude,Longitude,Distance Along Route (km),Distance from Route (km),Description'
    );
    // Embedded quotes doubled, whole field wrapped in quotes
    expect(lines[1]).toContain('"Camp ""Rest"", Area"');
    expect(lines[1]).toContain('water');
    expect(lines[1]).toContain('3.4');
  });

  it('should leave simple fields unquoted', () => {
    const poi = makeEnriched('Plain Spring');
    const csv = exportPOIsToCSV([poi]);

    expect(csv).toContain('Plain Spring,water');
    expect(csv).not.toContain('"Plain Spring"');
  });
});

describe('getPOIName', () => {
  it('should use the name tag when present and derive a name otherwise', () => {
    expect(getPOIName({ id: 1, type: 'node', lat: 0, lon: 0, tags: { name: 'My Hut' } })).toBe('My Hut');
    expect(getPOIName({ id: 2, type: 'node', lat: 0, lon: 0, tags: { amenity: 'drinking_water' } })).toBe('Drinking Water');
    expect(getPOIName({ id: 3, type: 'node', lat: 0, lon: 0, tags: {} })).toBe('Unknown POI');
  });
});
