import { describe, it, expect } from "vitest";
import {
  POI_CATALOG,
  POI_TYPES,
  POI_TYPE_LABELS,
  CORRIDOR_LIMITS,
  categorizePOI,
  getPOIName,
  getPOIDescription,
  buildOverpassQuery,
  roundCoord,
  poiKey,
  normalizeOverpassElements,
  buildCorridorChunks,
  validateOverpassArea,
  parseOverpassArea,
  buildRouteGeometry,
  computeCumulativeDistances,
  nearestPointOnRoute,
  escapeXml,
  type LatLon,
  type POITagRule,
} from "./osm-poi";

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("POI catalog", () => {
  it("labels and catalog cover every type", () => {
    for (const type of POI_TYPES) {
      expect(POI_TYPE_LABELS[type]).toBeTruthy();
      expect(POI_CATALOG[type].length).toBeGreaterThan(0);
    }
    expect(Object.keys(POI_CATALOG).sort()).toEqual([...POI_TYPES].sort());
  });

  it("every rule matches its own synthetic tags via categorizePOI", () => {
    for (const type of POI_TYPES) {
      for (const rule of POI_CATALOG[type]) {
        const tags: Record<string, string> = { [rule.key]: rule.value };
        for (const req of rule.require ?? []) {
          tags[req.key] = req.value ?? "yes";
        }
        expect(categorizePOI(tags), `${type}: ${rule.key}=${rule.value}`).toBe(
          type
        );
      }
    }
  });

  it("every rule appears in the query built for its own type", () => {
    for (const type of POI_TYPES) {
      const query = buildOverpassQuery(
        { bounds: { south: 0, north: 1, west: 0, east: 1 } },
        [type]
      );
      for (const rule of POI_CATALOG[type]) {
        const exact = `["${rule.key}"="${rule.value}"]`;
        const inUnion = new RegExp(
          `"${rule.key}"~"\\^\\([^"]*\\b${rule.value}\\b[^"]*\\)\\$"`
        ).test(query);
        expect(
          query.includes(exact) || inUnion,
          `${type}: ${rule.key}=${rule.value} missing from query:\n${query}`
        ).toBe(true);
      }
    }
  });

  it("unions same-key rules into one regex statement", () => {
    const query = buildOverpassQuery(
      { bounds: { south: 0, north: 1, west: 0, east: 1 } },
      ["water"]
    );
    expect(query).toContain('["amenity"~"^(drinking_water|water_point)$"]');
    expect(query).toContain('["natural"="spring"]');
    expect(query).toContain('["man_made"="water_tap"]');
  });

  it("gives conditional rules their own statement", () => {
    const query = buildOverpassQuery(
      { bounds: { south: 0, north: 1, west: 0, east: 1 } },
      ["camping"]
    );
    expect(query).toContain(
      '["amenity"="shelter"]["shelter_type"!="public_transport"]'
    );
  });

  it("drops a bus shelter rather than calling it camping", () => {
    expect(categorizePOI({ amenity: "shelter" })).toBe("camping");
    expect(
      categorizePOI({ amenity: "shelter", shelter_type: "public_transport" })
    ).toBeNull();
  });

  it("runs fallback rules only after every specific rule has failed", () => {
    // A cafe that also has a tap stays resupply...
    expect(categorizePOI({ amenity: "cafe", drinking_water: "yes" })).toBe(
      "resupply"
    );
    // ...but toilets with a tap are the only water source around.
    expect(categorizePOI({ amenity: "toilets", drinking_water: "yes" })).toBe(
      "water"
    );
  });

  it("no longer treats a named lake as a water source", () => {
    expect(
      categorizePOI({ natural: "water", name: "Lake Bad Idea" })
    ).toBeNull();
  });

  it("returns null for unrecognised tags", () => {
    expect(categorizePOI({})).toBeNull();
    expect(categorizePOI({ foo: "bar" })).toBeNull();
  });
});

describe("getPOIName / getPOIDescription", () => {
  it("uses the name tag when present and derives one otherwise", () => {
    expect(getPOIName({ tags: { name: "My Hut" } })).toBe("My Hut");
    expect(getPOIName({ tags: { amenity: "drinking_water" } })).toBe(
      "Drinking Water"
    );
    expect(getPOIName({ tags: {} })).toBe("Unknown POI");
  });

  it("assembles a description from the informative tags", () => {
    expect(getPOIDescription({ tags: {} })).toBe("No additional information");
    expect(
      getPOIDescription({ tags: { opening_hours: "9-5", fee: "yes" } })
    ).toBe("Hours: 9-5 | Fee required");
  });
});

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

describe("buildOverpassQuery", () => {
  const corridor: LatLon[] = [
    { lat: -37.812345, lon: 144.963789 },
    { lat: -37.900001, lon: 145.000049 },
  ];

  it("uses nwr and out center so mapped-as-area POIs come back with a point", () => {
    const query = buildOverpassQuery({ corridor, radiusMeters: 2000 }, [
      "water",
    ]);
    expect(query).toContain("[out:json][timeout:22];");
    expect(query).toContain("nwr[");
    expect(query).not.toMatch(/^\s*node\[/m);
    expect(query.trimEnd().endsWith("out center;")).toBe(true);
  });

  it("emits an around: polyline with rounded coordinates", () => {
    const query = buildOverpassQuery({ corridor, radiusMeters: 2500 }, [
      "water",
    ]);
    // 145.000049 rounds to 145 and serialises without a trailing ".0"
    expect(query).toContain("(around:2500,-37.8123,144.9638,-37.9,145)");
    expect(query).not.toContain("144.963789");
  });

  it("emits a rounded bbox filter in bbox mode", () => {
    const query = buildOverpassQuery(
      {
        bounds: {
          south: -37.812345,
          north: -37.1,
          west: 144.963789,
          east: 145.2,
        },
      },
      ["transport"]
    );
    expect(query).toContain("(-37.8123,144.9638,-37.1,145.2)");
  });

  it("honours the timeout option", () => {
    const query = buildOverpassQuery(
      { bounds: { south: 0, north: 1, west: 0, east: 1 } },
      ["water"],
      {
        timeoutSeconds: 60,
      }
    );
    expect(query).toContain("[timeout:60]");
  });

  it("does not repeat an identical statement across types", () => {
    const query = buildOverpassQuery(
      { bounds: { south: 0, north: 1, west: 0, east: 1 } },
      ["water", "water"]
    );
    const occurrences = query.split('["natural"="spring"]').length - 1;
    expect(occurrences).toBe(1);
  });

  it("ignores unknown types without throwing", () => {
    const query = buildOverpassQuery(
      { bounds: { south: 0, north: 1, west: 0, east: 1 } },
      ["nonsense" as unknown as (typeof POI_TYPES)[number]]
    );
    expect(query).toContain("out center;");
  });
});

describe("roundCoord", () => {
  it("rounds to 4 decimal places (~11 m)", () => {
    expect(roundCoord(144.963789)).toBe(144.9638);
    expect(roundCoord(-37.812345)).toBe(-37.8123);
    expect(roundCoord(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

describe("normalizeOverpassElements", () => {
  it("uses center for ways/relations and drops coordless elements", () => {
    const pois = normalizeOverpassElements([
      { id: 1, type: "node", lat: 1, lon: 2, tags: { amenity: "cafe" } },
      {
        id: 2,
        type: "way",
        center: { lat: 3, lon: 4 },
        tags: { shop: "supermarket" },
      },
      { id: 3, type: "relation", tags: { shop: "supermarket" } },
      { id: 4, type: "node", lat: 0, lon: 0 },
    ]);

    expect(pois.map((p) => p.id)).toEqual([1, 2, 4]);
    expect(pois[1]).toEqual({
      id: 2,
      type: "way",
      lat: 3,
      lon: 4,
      tags: { shop: "supermarket" },
    });
    // lat/lon of 0 is a real coordinate, not a missing one
    expect(pois[2]).toEqual({ id: 4, type: "node", lat: 0, lon: 0, tags: {} });
  });

  it("handles a missing elements array", () => {
    expect(normalizeOverpassElements(undefined)).toEqual([]);
  });
});

describe("poiKey", () => {
  it("distinguishes node and way ids, which share numbers", () => {
    expect(poiKey({ type: "node", id: 42 })).toBe("node/42");
    expect(poiKey({ type: "way", id: 42 })).toBe("way/42");
    expect(poiKey({ type: "node", id: 42 })).not.toBe(
      poiKey({ type: "way", id: 42 })
    );
  });
});

// ---------------------------------------------------------------------------
// Corridor chunks
// ---------------------------------------------------------------------------

/** Zigzag with ~11 m of lateral deviation so Douglas-Peucker keeps every vertex. */
function zigzag(count: number, lonStep = 0.001): LatLon[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: i % 2 === 0 ? 0 : 0.0001,
    lon: i * lonStep,
  }));
}

describe("buildCorridorChunks", () => {
  it("splits into chunks that overlap by one vertex and cover the whole route", () => {
    const route = zigzag(10);
    const chunks = buildCorridorChunks(route, 4, 4);

    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4);
    }
    // Last vertex of each chunk is the first of the next
    for (let i = 0; i + 1 < chunks.length; i++) {
      expect(chunks[i][chunks[i].length - 1]).toEqual(chunks[i + 1][0]);
    }
    // Concatenating without the duplicated joins reproduces the route
    const rebuilt = chunks.flatMap((c, i) => (i === 0 ? c : c.slice(1)));
    expect(rebuilt).toEqual(route);
  });

  it("returns one chunk per track for multi-track routes", () => {
    const chunks = buildCorridorChunks([zigzag(5), zigzag(5, 0.002)], 4, 300);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(5);
    expect(chunks[1]).toHaveLength(5);
  });

  it("joins consecutive segments that start where the previous one ended", () => {
    // A recording split at a rest stop: segment 2 begins ~110 m from the end of
    // segment 1, well inside the 2 x radius join gap.
    const seg1 = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.05 },
    ];
    const seg2 = [
      { lat: 0.001, lon: 0.05 },
      { lat: 0.001, lon: 0.1 },
    ];
    // A side trip branching from km 0, far from where segment 2 ended.
    const sideTrip = [
      { lat: 0.001, lon: 0 },
      { lat: 0.02, lon: 0 },
    ];
    const chunks = buildCorridorChunks([seg1, seg2, sideTrip], 2000, 300);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual([...seg1, ...seg2]);
    expect(chunks[1]).toEqual(sideTrip);
  });

  it("does not join across a gap larger than joinGapMeters", () => {
    const a = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
    ];
    const b = [
      { lat: 0, lon: 0.1 }, // ~10 km further on
      { lat: 0, lon: 0.11 },
    ];
    expect(buildCorridorChunks([a, b], 2000, 300)).toHaveLength(2);
    expect(buildCorridorChunks([a, b], 2000, 300, 20000)).toHaveLength(1);
  });

  it("simplifies dense tracks with a radius/4 tolerance", () => {
    // A straight line collapses to its endpoints.
    const straight = Array.from({ length: 500 }, (_, i) => ({
      lat: 0,
      lon: i * 0.0001,
    }));
    const chunks = buildCorridorChunks(straight, 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("keeps a single-point track as a one-vertex (circular) corridor", () => {
    const chunks = buildCorridorChunks([[{ lat: 1, lon: 2 }]], 2000);
    expect(chunks).toEqual([[{ lat: 1, lon: 2 }]]);
  });

  it("skips empty and non-finite input", () => {
    expect(buildCorridorChunks([], 2000)).toEqual([]);
    expect(buildCorridorChunks([{ lat: NaN, lon: 0 }], 2000)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateOverpassArea", () => {
  const corridor = [
    { lat: 0, lon: 0 },
    { lat: 0.1, lon: 0.1 },
  ];

  it("accepts a valid corridor in both object and pair form", () => {
    expect(validateOverpassArea({ corridor, radiusMeters: 2000 })).toBeNull();
    expect(
      validateOverpassArea({
        corridor: [
          [0, 0],
          [0.1, 0.1],
        ],
        radiusMeters: 2000,
      })
    ).toBeNull();
  });

  it("accepts a valid bbox", () => {
    expect(
      validateOverpassArea({ bounds: { south: 0, north: 1, west: 0, east: 1 } })
    ).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(validateOverpassArea(null)).toMatch(/object/);
    expect(validateOverpassArea("nope")).toMatch(/object/);
    expect(validateOverpassArea({})).toMatch(/corridor.*bounds/);
    expect(validateOverpassArea({ corridor: [], radiusMeters: 100 })).toMatch(
      /non-empty/
    );
    expect(validateOverpassArea({ corridor, radiusMeters: 0 })).toMatch(
      /positive/
    );
    expect(validateOverpassArea({ corridor, radiusMeters: "big" })).toMatch(
      /positive/
    );
  });

  it("enforces the shared limits", () => {
    const tooMany = Array.from(
      { length: CORRIDOR_LIMITS.maxVertices + 1 },
      () => ({ lat: 0, lon: 0 })
    );
    expect(
      validateOverpassArea({ corridor: tooMany, radiusMeters: 100 })
    ).toMatch(/too many vertices/);
    expect(
      validateOverpassArea({
        corridor,
        radiusMeters: CORRIDOR_LIMITS.maxRadiusMeters + 1,
      })
    ).toMatch(/radiusMeters too large/);
    expect(
      validateOverpassArea({ bounds: { south: 0, north: 5, west: 0, east: 1 } })
    ).toMatch(/Bounding box too large/);
  });

  it("rejects non-finite and out-of-range coordinates", () => {
    expect(
      validateOverpassArea({
        corridor: [{ lat: NaN, lon: 0 }],
        radiusMeters: 100,
      })
    ).toMatch(/finite/);
    expect(
      validateOverpassArea({
        corridor: [{ lat: 91, lon: 0 }],
        radiusMeters: 100,
      })
    ).toMatch(/latitude out of range/);
    expect(
      validateOverpassArea({
        corridor: [{ lat: 0, lon: 181 }],
        radiusMeters: 100,
      })
    ).toMatch(/longitude out of range/);
    expect(
      validateOverpassArea({ bounds: { south: 1, north: 0, west: 0, east: 1 } })
    ).toMatch(/latitudes out of range/);
    expect(
      validateOverpassArea({
        bounds: { south: 0, north: 1, west: 0, east: "x" },
      })
    ).toMatch(/finite number/);
  });
});

describe("parseOverpassArea", () => {
  it("normalises wire pairs into LatLon objects", () => {
    expect(
      parseOverpassArea({
        corridor: [
          [1, 2],
          [3, 4],
        ],
        radiusMeters: 500,
      })
    ).toEqual({
      corridor: [
        { lat: 1, lon: 2 },
        { lat: 3, lon: 4 },
      ],
      radiusMeters: 500,
    });
  });

  it("passes bounds through and rejects junk", () => {
    expect(
      parseOverpassArea({ bounds: { south: 0, north: 1, west: 0, east: 1 } })
    ).toEqual({ bounds: { south: 0, north: 1, west: 0, east: 1 } });
    expect(
      parseOverpassArea({ corridor: [["a", "b"]], radiusMeters: 500 })
    ).toBeNull();
    expect(parseOverpassArea(null)).toBeNull();
    expect(parseOverpassArea({})).toBeNull();
  });
});

describe("escapeXml re-export", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml(`Joe's "Café" & <Bar>`)).toBe(
      "Joe&apos;s &quot;Café&quot; &amp; &lt;Bar&gt;"
    );
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe("buildRouteGeometry", () => {
  it("flattens a single track with no breaks", () => {
    const route = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
      { lat: 0, lon: 0.02 },
    ];
    const geom = buildRouteGeometry(route);

    expect(geom.points).toHaveLength(3);
    expect(geom.segmentBreaks.size).toBe(0);
    expect(geom.cumulativeKm[0]).toBe(0);
    expect(geom.cumulativeKm[2]).toBeCloseTo(2 * geom.cumulativeKm[1], 9);
    expect(geom.coarseIndices[0]).toBe(0);
    expect(geom.coarseIndices[geom.coarseIndices.length - 1]).toBe(2);
  });

  it("records track boundaries and does not add the gap to the distance", () => {
    const geom = buildRouteGeometry([
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.01 },
      ],
      // Same latitude and span as track 1, so its length is identical
      [
        { lat: 0, lon: 5 },
        { lat: 0, lon: 5.01 },
      ],
    ]);

    expect(geom.points).toHaveLength(4);
    expect([...geom.segmentBreaks]).toEqual([1]);
    // The jump from track 1 to track 2 contributes nothing
    expect(geom.cumulativeKm[2]).toBe(geom.cumulativeKm[1]);
    expect(geom.cumulativeKm[3]).toBeCloseTo(2 * geom.cumulativeKm[1], 6);
  });

  it("forces every track edge into coarseIndices so no coarse interval spans a break", () => {
    // 400 dense points per track means the 150 m sampler would otherwise skip
    // straight over the boundary.
    const track = (lat: number) =>
      Array.from({ length: 400 }, (_, i) => ({ lat, lon: i * 0.0003 }));
    const geom = buildRouteGeometry([track(0), track(1)]);

    expect(geom.coarseIndices).toContain(399);
    expect(geom.coarseIndices).toContain(400);
    for (let k = 0; k + 1 < geom.coarseIndices.length; k++) {
      const a = geom.coarseIndices[k];
      const b = geom.coarseIndices[k + 1];
      for (let i = a; i < b; i++) {
        // A break may only sit at the very edge of an interval
        if (geom.segmentBreaks.has(i)) {
          expect(i).toBe(a);
          expect(b).toBe(a + 1);
        }
      }
    }
  });

  it("drops non-finite points", () => {
    const geom = buildRouteGeometry([
      { lat: 0, lon: 0 },
      { lat: NaN, lon: 1 },
      { lat: 0, lon: 0.01 },
    ]);
    expect(geom.points).toHaveLength(2);
  });
});

describe("computeCumulativeDistances", () => {
  it("starts at 0 and increases monotonically", () => {
    const cumulative = computeCumulativeDistances([
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
      { lat: 0, lon: 0.02 },
    ]);

    expect(cumulative).toHaveLength(3);
    expect(cumulative[0]).toBe(0);
    expect(cumulative[1]).toBeCloseTo(1.113, 2);
    expect(cumulative[2]).toBeCloseTo(2 * cumulative[1], 6);
  });

  it("handles an empty route", () => {
    expect(computeCumulativeDistances([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// nearestPointOnRoute vs brute force — the important one
// ---------------------------------------------------------------------------

const METERS_PER_DEGREE = (Math.PI / 180) * 6371000;

/**
 * Independent, deliberately naive reference: exact point-to-segment distance
 * over EVERY segment, with no coarse pass and no pruning. Same local
 * equirectangular projection as the implementation, so any difference is a
 * search bug rather than a metric difference.
 */
function bruteForceNearest(
  poi: LatLon,
  points: LatLon[],
  breaks: Set<number>
): { distanceKm: number; segmentIndex: number; t: number } {
  const cosLat0 = Math.cos((poi.lat * Math.PI) / 180);
  const proj = (p: LatLon) => ({
    x: (p.lon - poi.lon) * cosLat0 * METERS_PER_DEGREE,
    y: (p.lat - poi.lat) * METERS_PER_DEGREE,
  });

  let best = Infinity;
  let bestIndex = -1;
  let bestT = 0;

  for (let i = 0; i + 1 < points.length; i++) {
    if (breaks.has(i)) {
      continue;
    }
    const a = proj(points[i]);
    const b = proj(points[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = Math.min(1, Math.max(0, -(a.x * dx + a.y * dy) / lenSq));
    }
    const d = Math.hypot(a.x + t * dx, a.y + t * dy) / 1000;
    if (d < best) {
      best = d;
      bestIndex = i;
      bestT = t;
    }
  }

  // Every vertex is a candidate too. For a vertex with a segment attached this
  // can only tie, but an isolated single-point track has no segment at all and
  // would otherwise be invisible to the reference.
  for (let i = 0; i < points.length; i++) {
    const p = proj(points[i]);
    const d = Math.hypot(p.x, p.y) / 1000;
    if (d < best) {
      best = d;
      bestIndex = i;
      bestT = 0;
    }
  }

  return { distanceKm: best, segmentIndex: bestIndex, t: bestT };
}

/** Deterministic PRNG so a failing case is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("nearestPointOnRoute", () => {
  it("matches brute force over hundreds of random POIs on a wiggly dense route", () => {
    // ~1000 points, 5 km of switchbacks: the coarse sampler skips most vertices
    // and the out-and-back shape makes the nearest coarse sample belong to the
    // wrong pass of the route unless pruning is done properly.
    const route: LatLon[] = Array.from({ length: 1000 }, (_, i) => ({
      lat: -37.8 + Math.sin(i * 0.09) * 0.02 + i * 0.00002,
      lon: 144.9 + i * 0.00005 + Math.cos(i * 0.13) * 0.01,
    }));
    const geom = buildRouteGeometry(route);
    const rand = mulberry32(1234);

    for (let n = 0; n < 400; n++) {
      const poi = {
        lat: -37.85 + rand() * 0.14,
        lon: 144.86 + rand() * 0.14,
      };
      const actual = nearestPointOnRoute(poi, geom);
      const expected = bruteForceNearest(poi, geom.points, geom.segmentBreaks);

      expect(actual.distanceKm, `poi ${JSON.stringify(poi)}`).toBeCloseTo(
        expected.distanceKm,
        9
      );
      // The reported position must describe the point we claim to have found
      const start = geom.cumulativeKm[actual.segmentIndex];
      const end =
        geom.cumulativeKm[
          Math.min(actual.segmentIndex + 1, geom.points.length - 1)
        ];
      expect(actual.distanceAlongRouteKm).toBeCloseTo(
        start + actual.t * (end - start),
        9
      );
      expect(actual.t).toBeGreaterThanOrEqual(0);
      expect(actual.t).toBeLessThanOrEqual(1);
    }
  });

  it("matches brute force on a sparse route where cross-track beats vertex distance", () => {
    // 6 vertices, ~20 km apart. Every POI sits near a segment mid-point, so the
    // nearest VERTEX is an order of magnitude further away than the answer.
    const route: LatLon[] = Array.from({ length: 6 }, (_, i) => ({
      lat: 0,
      lon: i * 0.2,
    }));
    const geom = buildRouteGeometry(route);
    const rand = mulberry32(99);

    for (let n = 0; n < 200; n++) {
      const poi = { lat: (rand() - 0.5) * 0.05, lon: rand() * 1.0 };
      const actual = nearestPointOnRoute(poi, geom);
      const expected = bruteForceNearest(poi, geom.points, geom.segmentBreaks);
      expect(actual.distanceKm).toBeCloseTo(expected.distanceKm, 9);
    }

    // Explicit sanity check: a POI over the middle of a 22 km segment
    const mid = nearestPointOnRoute({ lat: 0.01, lon: 0.1 }, geom);
    expect(mid.distanceKm).toBeCloseTo(1.1119, 3);
    expect(mid.segmentIndex).toBe(0);
    expect(mid.t).toBeCloseTo(0.5, 6);
    expect(mid.nearestPointIndex).toBe(0);
  });

  it("matches brute force on a multi-track route and never spans a break", () => {
    const trackA: LatLon[] = Array.from({ length: 120 }, (_, i) => ({
      lat: 0,
      lon: i * 0.001,
    }));
    const trackB: LatLon[] = Array.from({ length: 120 }, (_, i) => ({
      lat: 1,
      lon: 2 + i * 0.001,
    }));
    const trackC: LatLon[] = [{ lat: -1, lon: -1 }]; // isolated single point, no segment
    const geom = buildRouteGeometry([trackA, trackB, trackC]);
    const rand = mulberry32(7);

    for (let n = 0; n < 300; n++) {
      const poi = { lat: -1.2 + rand() * 2.6, lon: -1.2 + rand() * 3.6 };
      const actual = nearestPointOnRoute(poi, geom);
      const expected = bruteForceNearest(poi, geom.points, geom.segmentBreaks);
      expect(actual.distanceKm, `poi ${JSON.stringify(poi)}`).toBeCloseTo(
        expected.distanceKm,
        9
      );
      expect(geom.segmentBreaks.has(actual.segmentIndex)).toBe(false);
    }
  });

  it("does not measure against the phantom line joining two tracks", () => {
    const geom = buildRouteGeometry([
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.01 },
      ],
      [
        { lat: 0, lon: 1.0 },
        { lat: 0, lon: 1.01 },
      ],
    ]);
    // Sits above the middle of the gap. On the phantom segment it would be ~22 km away.
    const result = nearestPointOnRoute({ lat: 0.2, lon: 0.5 }, geom);
    expect(geom.segmentBreaks.has(result.segmentIndex)).toBe(false);
    expect(result.distanceKm).toBeGreaterThan(50);
  });

  it("skips the phantom segment even when pruning cannot rule it out", () => {
    // The coarse bound across a track break is (d_end + d_start) / 2, which is
    // never below the best vertex distance — EXCEPT when the POI is very nearly
    // equidistant from both endpoints, where the bound collapses onto the best
    // and the interval is opened up. Only the explicit break guard saves us here.
    const geom = buildRouteGeometry([
      [
        { lat: 0, lon: -0.01 },
        { lat: 0, lon: 0 },
      ],
      [
        { lat: 0, lon: 0.1 },
        { lat: 0, lon: 0.11 },
      ],
    ]);
    const poi = { lat: 0.05, lon: 0.05 }; // equidistant from (0,0) and (0,0.1)
    const result = nearestPointOnRoute(poi, geom);

    // The phantom line would put the POI 5.6 km away; the real answer is 7.9 km.
    expect(result.distanceKm).toBeCloseTo(7.863, 2);
    expect(geom.segmentBreaks.has(result.segmentIndex)).toBe(false);
    expect(result.distanceKm).toBeCloseTo(
      bruteForceNearest(poi, geom.points, geom.segmentBreaks).distanceKm,
      9
    );
  });

  it("finds an isolated single-point track", () => {
    const geom = buildRouteGeometry([[{ lat: 10, lon: 10 }]]);
    const result = nearestPointOnRoute({ lat: 10.001, lon: 10 }, geom);
    expect(result.distanceKm).toBeCloseTo(0.1112, 3);
    expect(result.segmentIndex).toBe(0);
    expect(result.nearestPointIndex).toBe(0);
    expect(result.distanceAlongRouteKm).toBe(0);
  });

  it("handles an empty route", () => {
    const result = nearestPointOnRoute(
      { lat: 0, lon: 0 },
      buildRouteGeometry([])
    );
    expect(result.distanceKm).toBe(Infinity);
    expect(result.distanceAlongRouteKm).toBe(0);
  });

  it("reports the nearer endpoint as nearestPointIndex", () => {
    const geom = buildRouteGeometry([
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
    ]);
    expect(
      nearestPointOnRoute({ lat: 0.0001, lon: 0.002 }, geom).nearestPointIndex
    ).toBe(0);
    expect(
      nearestPointOnRoute({ lat: 0.0001, lon: 0.008 }, geom).nearestPointIndex
    ).toBe(1);
  });
});

describe("catalog rule typing", () => {
  it("exposes rules as POITagRule", () => {
    const rule: POITagRule = POI_CATALOG.water[0];
    expect(rule.key).toBe("amenity");
    expect(rule.value).toBe("drinking_water");
  });
});
