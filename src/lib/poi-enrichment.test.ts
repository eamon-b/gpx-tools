import { describe, it, expect, vi, afterEach } from "vitest";
import {
  enrichRoute,
  exportPOIsToCSV,
  exportPOIsToGPX,
  computeCumulativeDistances,
  getPOIName,
  type EnrichedPOI,
  type EnrichmentProgress,
} from "./poi-enrichment";
import { apiClient } from "./api-client";
import type { LatLon, OverpassArea, POI, POIType } from "./osm-poi";
import type { POIFetcher } from "./overpass-client";

function makePOI(
  id: number,
  lat: number,
  lon: number,
  tags: Record<string, string>,
  type = "node"
): POI {
  return { id, type, lat, lon, tags };
}

/** Route along the equator: 0.001 degree of longitude is ~111 m. */
function createRoute(numPoints: number, lonStep = 0.001): LatLon[] {
  return Array.from({ length: numPoints }, (_, i) => ({
    lat: 0,
    lon: i * lonStep,
  }));
}

/** A fetcher that returns the same POIs for every chunk. */
function fetcherReturning(pois: POI[]): POIFetcher {
  return vi.fn(async () => pois);
}

describe("enrichRoute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns POIs near the route, filtered by type and sorted along the route", async () => {
    const route = createRoute(200);

    const pois: POI[] = [
      // Water POI near route point ~150 (~111 m off-route)
      makePOI(1, 0.001, 0.15, { amenity: "drinking_water", name: "Spring A" }),
      // Water POI on route point 10
      makePOI(2, 0, 0.01, { natural: "spring" }),
      // Camping POI on route point 50
      makePOI(3, 0, 0.05, { tourism: "camp_site", name: "Camp X" }),
      // Water POI ~55 km from the route - beyond searchRadiusKm
      makePOI(4, 0.5, 0.1, { amenity: "drinking_water", name: "Too Far" }),
      // POI with no recognizable category
      makePOI(5, 0, 0.02, { foo: "bar" }),
      // Duplicate of POI 2 (e.g. returned by an overlapping chunk)
      makePOI(2, 0, 0.01, { natural: "spring" }),
    ];

    const fetchPOIs = fetcherReturning(pois);
    const result = await enrichRoute(route, {
      types: ["water", "camping"],
      searchRadiusKm: 2,
      fetchPOIs,
    });

    expect(fetchPOIs).toHaveBeenCalledTimes(1);
    expect(result.failedChunks).toHaveLength(0);

    // POIs 4 (too far) and 5 (uncategorized) excluded; POI 2 deduplicated
    expect(result.pois).toHaveLength(3);
    expect(result.pois.map((p) => p.id)).toEqual([2, 3, 1]);

    // Sorted by position along the route
    const along = result.pois.map((p) => p.distanceAlongRoute);
    expect([...along].sort((a, b) => a - b)).toEqual(along);

    expect(result.byType.water.map((p) => p.id)).toEqual([2, 1]);
    expect(result.byType.camping.map((p) => p.id)).toEqual([3]);
    expect(result.stats.totalFound).toBe(3);
    expect(result.stats.byType.water).toBe(2);
    expect(result.stats.byType.camping).toBe(1);
    expect(result.stats.queryChunks).toBe(1);

    const cumulative = computeCumulativeDistances(route);
    const poi2 = result.pois.find((p) => p.id === 2)!;
    expect(poi2.nearestPointIndex).toBe(10);
    expect(poi2.distanceAlongRoute).toBeCloseTo(cumulative[10], 6);
    expect(poi2.distanceFromRoute).toBeCloseTo(0, 6);

    const poi1 = result.pois.find((p) => p.id === 1)!;
    expect(poi1.nearestPointIndex).toBe(150);
    expect(poi1.distanceFromRoute).toBeGreaterThan(0.1);
    expect(poi1.distanceFromRoute).toBeLessThan(0.15);
    // New fields: the exact position on the segment. Floating-point lon means
    // route[150] is a hair past 0.15, so the hit lands at the end of segment
    // 149 rather than the start of 150 - both describe the same point.
    expect([149, 150]).toContain(poi1.segmentIndex);
    expect(poi1.t).toBeGreaterThanOrEqual(0);
    expect(poi1.t).toBeLessThanOrEqual(1);
    const cum = computeCumulativeDistances(route);
    expect(poi1.distanceAlongRoute).toBeCloseTo(cum[150], 6);
  });

  it("queries a corridor around the route, not a bounding box", async () => {
    const fetchPOIs = vi.fn(async () => [] as POI[]);
    await enrichRoute(createRoute(50), {
      types: ["water"],
      searchRadiusKm: 2,
      fetchPOIs,
    });

    const [area, types] = fetchPOIs.mock.calls[0] as unknown as [
      OverpassArea,
      POIType[],
    ];
    expect("corridor" in area).toBe(true);
    if ("corridor" in area) {
      expect(area.corridor.length).toBeGreaterThan(0);
      // Padded past the 2 km search radius to cover corridor simplification
      expect(area.radiusMeters).toBeGreaterThan(2000);
    }
    expect(types).toEqual(["water"]);
  });

  it("excludes types that were not requested", async () => {
    const result = await enrichRoute(createRoute(100), {
      types: ["water"],
      fetchPOIs: fetcherReturning([
        makePOI(1, 0, 0.01, { amenity: "drinking_water" }),
        makePOI(2, 0, 0.05, { tourism: "camp_site" }),
      ]),
    });

    expect(result.pois).toHaveLength(1);
    expect(result.pois[0].category).toBe("water");
  });

  it("deduplicates by type/id, not id alone (node 5 and way 5 are different features)", async () => {
    const result = await enrichRoute(createRoute(100), {
      types: ["water"],
      fetchPOIs: fetcherReturning([
        makePOI(5, 0, 0.01, { amenity: "drinking_water" }, "node"),
        makePOI(5, 0, 0.02, { amenity: "drinking_water" }, "way"),
        makePOI(5, 0, 0.01, { amenity: "drinking_water" }, "node"), // true duplicate
      ]),
    });

    expect(result.pois).toHaveLength(2);
    expect(result.pois.map((p) => p.type).sort()).toEqual(["node", "way"]);
  });

  it("uses the deprecated maxDistanceFromRoute as an alias for searchRadiusKm", async () => {
    const pois = [makePOI(1, 0.005, 0.05, { amenity: "drinking_water" })]; // ~556 m off-route

    const tight = await enrichRoute(createRoute(100), {
      types: ["water"],
      maxDistanceFromRoute: 0.3,
      fetchPOIs: fetcherReturning(pois),
    });
    expect(tight.pois).toHaveLength(0);

    const loose = await enrichRoute(createRoute(100), {
      types: ["water"],
      maxDistanceFromRoute: 1,
      fetchPOIs: fetcherReturning(pois),
    });
    expect(loose.pois).toHaveLength(1);
  });

  it("falls back to the /api/overpass proxy when no fetcher is injected", async () => {
    const spy = vi
      .spyOn(apiClient, "fetchPOIs")
      .mockResolvedValue([makePOI(1, 0, 0.01, { amenity: "drinking_water" })]);

    const result = await enrichRoute(createRoute(50), { types: ["water"] });

    expect(spy).toHaveBeenCalledTimes(1);
    const [area, types] = spy.mock.calls[0];
    expect("corridor" in area).toBe(true);
    expect(types).toEqual(["water"]);
    expect(result.pois).toHaveLength(1);
  });

  it("returns partial results when one chunk fails (regression)", async () => {
    // Three disjoint tracks produce three corridor chunks
    const tracks = [0, 1, 2].map((lat) =>
      Array.from({ length: 20 }, (_, i) => ({ lat, lon: i * 0.001 }))
    );

    const fetchPOIs = vi
      .fn<POIFetcher>()
      .mockResolvedValueOnce([
        makePOI(1, 0, 0.005, { amenity: "drinking_water" }),
      ])
      .mockRejectedValueOnce(new Error("Overpass timeout"))
      .mockResolvedValueOnce([makePOI(2, 2, 0.005, { tourism: "camp_site" })]);

    const result = await enrichRoute(tracks, {
      types: ["water", "camping"],
      searchRadiusKm: 2,
      fetchPOIs,
    });

    expect(fetchPOIs).toHaveBeenCalledTimes(3);
    // No throw: results from the successful chunks are kept
    expect(result.pois.map((p) => p.id).sort()).toEqual([1, 2]);
    expect(result.failedChunks).toHaveLength(1);
    expect(result.failedChunks[0].chunkIndex).toBe(1);
    expect(result.failedChunks[0].error).toBe("Overpass timeout");
    expect(result.stats.queryChunks).toBe(3);
    expect(result.stats.failedChunks).toBe(1);
  });

  it("throws when every chunk fails", async () => {
    const fetchPOIs = vi.fn<POIFetcher>().mockRejectedValue(new Error("boom"));
    await expect(
      enrichRoute(createRoute(10), { types: ["water"], fetchPOIs })
    ).rejects.toThrow(/Failed to fetch POIs for all .*boom/);
  });

  it("returns an empty result for a route with no usable points", async () => {
    const fetchPOIs = vi.fn<POIFetcher>();
    const result = await enrichRoute([], { types: ["water"], fetchPOIs });

    expect(fetchPOIs).not.toHaveBeenCalled();
    expect(result.pois).toEqual([]);
    expect(result.stats.queryChunks).toBe(0);
  });

  it("reports structured progress through every stage", async () => {
    const events: EnrichmentProgress[] = [];
    await enrichRoute(
      createRoute(50),
      { types: ["water"], fetchPOIs: fetcherReturning([]) },
      (p) => events.push(p)
    );

    const stages = events.map((e) => e.stage);
    expect(stages[0]).toBe("prepare");
    expect(stages).toContain("fetch");
    expect(stages).toContain("process");
    expect(stages[stages.length - 1]).toBe("done");

    const fetchEvent = events.find((e) => e.stage === "fetch")!;
    expect(fetchEvent.current).toBe(1);
    expect(fetchEvent.total).toBe(1);
    expect(fetchEvent.message).toBeTruthy();
  });

  it("rejects with an AbortError when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchPOIs = vi.fn<POIFetcher>();
    await expect(
      enrichRoute(createRoute(50), {
        types: ["water"],
        fetchPOIs,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchPOIs).not.toHaveBeenCalled();
  });

  it("surfaces a fetcher abort as an AbortError rather than a failed chunk", async () => {
    const controller = new AbortController();
    const fetchPOIs = vi.fn<POIFetcher>().mockImplementation(async () => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    await expect(
      enrichRoute(createRoute(50), {
        types: ["water"],
        fetchPOIs,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("handles multi-track routes without measuring across the gap", async () => {
    const tracks = [
      Array.from({ length: 20 }, (_, i) => ({ lat: 0, lon: i * 0.001 })),
      Array.from({ length: 20 }, (_, i) => ({ lat: 0, lon: 1 + i * 0.001 })),
    ];
    // Sits midway between the two tracks: ~50 km from either, but on the
    // phantom joining line it would be right on the route.
    const result = await enrichRoute(tracks, {
      types: ["water"],
      searchRadiusKm: 2,
      fetchPOIs: fetcherReturning([
        makePOI(1, 0, 0.5, { amenity: "drinking_water" }),
      ]),
    });

    expect(result.pois).toHaveLength(0);
  });
});

describe("exportPOIsToCSV", () => {
  function makeEnriched(name: string): EnrichedPOI {
    return {
      id: 1,
      type: "node",
      lat: -37.8136,
      lon: 144.9631,
      tags: { amenity: "drinking_water", name },
      distanceFromRoute: 0.12,
      nearestPointIndex: 5,
      distanceAlongRoute: 3.4,
      segmentIndex: 5,
      t: 0.25,
      category: "water",
    };
  }

  it("quotes fields containing commas and quotes (regression)", () => {
    const csv = exportPOIsToCSV([makeEnriched('Camp "Rest", Area')]);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "Name,Category,Latitude,Longitude,Distance Along Route (km),Distance from Route (km),Description"
    );
    expect(lines[1]).toContain('"Camp ""Rest"", Area"');
    expect(lines[1]).toContain("water");
    expect(lines[1]).toContain("3.4");
  });

  it("leaves simple fields unquoted", () => {
    const csv = exportPOIsToCSV([makeEnriched("Plain Spring")]);
    expect(csv).toContain("Plain Spring,water");
    expect(csv).not.toContain('"Plain Spring"');
  });
});

describe("exportPOIsToGPX", () => {
  function makeEnriched(tags: Record<string, string>): EnrichedPOI {
    return {
      id: 1,
      type: "node",
      lat: -37.8136,
      lon: 144.9631,
      tags,
      distanceFromRoute: 0.12,
      nearestPointIndex: 5,
      distanceAlongRoute: 3.4,
      segmentIndex: 5,
      t: 0.25,
      category: "resupply",
    };
  }

  it("XML-escapes names, descriptions and the route name (regression)", () => {
    const gpx = exportPOIsToGPX(
      [
        makeEnriched({
          amenity: "cafe",
          name: `Joe's Café`,
          description: "Tea & <scones>",
        }),
      ],
      "a&b"
    );

    // Escaped, not stripped: the apostrophe and ampersand survive as entities
    expect(gpx).toContain("<name>Joe&apos;s Café</name>");
    expect(gpx).toContain("Tea &amp; &lt;scones&gt;");
    expect(gpx).toContain("<name>a&amp;b POIs</name>");
    // No raw markup-breaking characters leaked into element content
    expect(gpx).not.toContain("<scones>");
    expect(gpx).not.toContain("Joe's Café");
  });

  it("emits a waypoint per POI with a category symbol", () => {
    const gpx = exportPOIsToGPX([
      makeEnriched({ amenity: "cafe", name: "Plain" }),
    ]);
    expect(gpx).toContain('<wpt lat="-37.8136" lon="144.9631">');
    expect(gpx).toContain("<sym>Shopping Center</sym>");
    expect(gpx).toContain("<type>resupply</type>");
    expect(gpx).toContain("<name>Route POIs</name>");
  });
});

describe("getPOIName (compat re-export)", () => {
  it("uses the name tag when present and derives a name otherwise", () => {
    expect(getPOIName({ tags: { name: "My Hut" } })).toBe("My Hut");
    expect(getPOIName({ tags: { amenity: "drinking_water" } })).toBe(
      "Drinking Water"
    );
    expect(getPOIName({ tags: {} })).toBe("Unknown POI");
  });
});
