// @vitest-environment node
//
// The handler is a Web-standard `Request` -> `Response` function, so it runs
// natively under Node with no DOM shim; jsdom would only get in the way.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("./_redis", () => ({
  createRedisClient: () => redisMock,
}));

import handler from "./overpass";

const URL_ = "https://example.test/api/overpass";

const CORRIDOR = [
  [-37.8136, 144.9631],
  [-37.9, 145.0],
];

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function overpassOk(payload: unknown = { elements: [] }): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchMock(response: Response | (() => Response | Promise<Response>)) {
  const fn = vi.fn(async () =>
    typeof response === "function" ? await response() : response
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The `data=` form body the handler POSTs to Overpass, decoded back to QL. */
function sentQuery(fn: ReturnType<typeof vi.fn>): string {
  const init = fn.mock.calls[0][1] as RequestInit;
  return decodeURIComponent(String(init.body).replace(/^data=/, ""));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Healthy Redis by default: first request in the window, nothing cached.
  redisMock.incr.mockResolvedValue(1);
  redisMock.expire.mockResolvedValue(1);
  redisMock.ttl.mockResolvedValue(60);
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("overpass handler: protocol", () => {
  it("answers a CORS preflight with 204", async () => {
    const res = await handler(new Request(URL_, { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("rejects non-POST methods with 405", async () => {
    const res = await handler(new Request(URL_, { method: "GET" }));
    expect(res.status).toBe(405);
    await expect(res.json()).resolves.toEqual({ error: "Method not allowed" });
  });
});

describe("overpass handler: validation", () => {
  const cases: [string, unknown][] = [
    ["missing types", { corridor: CORRIDOR, radiusMeters: 2000 }],
    [
      "unknown type",
      { corridor: CORRIDOR, radiusMeters: 2000, types: ["water", "wifi"] },
    ],
    ["empty types", { corridor: CORRIDOR, radiusMeters: 2000, types: [] }],
    [
      "corridor with too many vertices",
      {
        corridor: Array.from({ length: 401 }, (_, i) => [-37 - i * 1e-4, 145]),
        radiusMeters: 2000,
        types: ["water"],
      },
    ],
    [
      "radius too big",
      { corridor: CORRIDOR, radiusMeters: 50000, types: ["water"] },
    ],
    [
      "bbox too big",
      {
        bounds: { south: -38, north: -36, west: 144, east: 145 },
        types: ["water"],
      },
    ],
    ["neither corridor nor bounds", { types: ["water"] }],
  ];

  for (const [name, body] of cases) {
    it(`rejects ${name} with 400 and a message`, async () => {
      const fn = fetchMock(overpassOk());
      const res = await handler(post(body));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBeTruthy();
      expect(fn).not.toHaveBeenCalled();
    });
  }

  it("rejects a malformed JSON body with 400", async () => {
    const res = await handler(post("{not json"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });
});

describe("overpass handler: querying", () => {
  it("builds a corridor query and form-encodes it for Overpass", async () => {
    const fn = fetchMock(overpassOk({ elements: [{ id: 1, type: "node" }] }));

    const res = await handler(
      post({
        corridor: CORRIDOR,
        radiusMeters: 2000,
        types: ["water", "camping"],
      })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(fn).toHaveBeenCalledTimes(1);

    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("overpass-api.de");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(String(init.body).startsWith("data=")).toBe(true);

    const query = sentQuery(fn);
    expect(query).toContain("around:2000");
    expect(query).toContain("nwr");
    expect(query).toContain("out center");
    expect(query).toContain("[timeout:22]");
  });

  it("supports the bbox fallback body", async () => {
    const fn = fetchMock(overpassOk());
    const res = await handler(
      post({
        bounds: { south: -37.9, north: -37.8, west: 144.9, east: 145.0 },
        types: ["resupply"],
      })
    );

    expect(res.status).toBe(200);
    const query = sentQuery(fn);
    expect(query).toContain("(-37.9,144.9,-37.8,145)");
    expect(query).toContain("nwr");
  });
});

describe("overpass handler: caching", () => {
  it("returns the cached payload without calling Overpass", async () => {
    const fn = fetchMock(overpassOk());
    redisMock.get.mockResolvedValue('{"elements":[{"id":7}]}');

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    await expect(res.text()).resolves.toBe('{"elements":[{"id":7}]}');
    expect(fn).not.toHaveBeenCalled();
  });

  it("stores a miss with the configured TTL", async () => {
    fetchMock(overpassOk({ elements: [] }));

    await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(redisMock.set).toHaveBeenCalledTimes(1);
    const [key, value, opts] = redisMock.set.mock.calls[0];
    expect(String(key)).toMatch(/^overpass:[0-9a-f]{32}$/);
    expect(value).toBe(JSON.stringify({ elements: [] }));
    expect(opts).toEqual({ ex: 604800 });
  });

  it("shares a cache key across corridors that differ below coordinate precision", async () => {
    fetchMock(overpassOk());

    await handler(
      post({
        corridor: [[-37.81361111, 144.96309999]],
        radiusMeters: 2000,
        types: ["water"],
      })
    );
    await handler(
      post({
        corridor: [[-37.8136, 144.9631]],
        radiusMeters: 2000,
        types: ["water"],
      })
    );

    const [first, second] = redisMock.get.mock.calls.map((c) => c[0]);
    expect(first).toBe(second);
  });

  it("uses the same cache key regardless of the order types arrive in", async () => {
    fetchMock(overpassOk());

    await handler(
      post({
        corridor: CORRIDOR,
        radiusMeters: 2000,
        types: ["camping", "water"],
      })
    );
    await handler(
      post({
        corridor: CORRIDOR,
        radiusMeters: 2000,
        types: ["water", "camping"],
      })
    );

    const [first, second] = redisMock.get.mock.calls.map((c) => c[0]);
    expect(first).toBe(second);
  });

  it("does not cache payloads above the Upstash value limit", async () => {
    const huge = JSON.stringify({ blob: "x".repeat(950 * 1024) });
    fetchMock(
      new Response(huge, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(huge);
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

describe("overpass handler: Redis failures", () => {
  it("serves the request and reports X-Cache BYPASS when Redis is down", async () => {
    const fn = fetchMock(overpassOk({ elements: [] }));
    const boom = new Error("redis unreachable");
    redisMock.incr.mockRejectedValue(boom);
    redisMock.get.mockRejectedValue(boom);
    redisMock.set.mockRejectedValue(boom);

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("BYPASS");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("overpass handler: rate limiting", () => {
  it("returns 429 with resetIn once the window is exhausted", async () => {
    const fn = fetchMock(overpassOk());
    redisMock.incr.mockResolvedValue(11);
    redisMock.ttl.mockResolvedValue(42);

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("42");
    await expect(res.json()).resolves.toEqual({
      error: "Rate limit exceeded",
      resetIn: 42,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("reports the remaining budget on a successful request", async () => {
    fetchMock(overpassOk());
    redisMock.incr.mockResolvedValue(3);

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.headers.get("X-RateLimit-Remaining")).toBe("7");
  });
});

describe("overpass handler: upstream errors", () => {
  it("maps an Overpass 429 to 503 with Retry-After", async () => {
    fetchMock(
      new Response("too many requests", {
        status: 429,
        headers: { "Retry-After": "17" },
      })
    );

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("17");
    const json = (await res.json()) as { retryAfter: number; resetIn: number };
    expect(json.retryAfter).toBe(17);
    expect(json.resetIn).toBe(17);
  });

  it("maps an Overpass 504 to 503 with the default Retry-After", async () => {
    fetchMock(new Response("gateway timeout", { status: 504 }));

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("maps an Overpass 500 to 502", async () => {
    fetchMock(new Response("boom", { status: 500 }));

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string; status: number };
    expect(json.status).toBe(500);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("maps a fetch timeout to 503", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeout;
      })
    );

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const json = (await res.json()) as { resetIn: number };
    expect(json.resetIn).toBe(30);
  });

  it("maps a network failure to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const res = await handler(
      post({ corridor: CORRIDOR, radiusMeters: 2000, types: ["water"] })
    );

    expect(res.status).toBe(502);
  });
});
