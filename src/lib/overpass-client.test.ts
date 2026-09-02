import { describe, it, expect, vi, afterEach } from "vitest";
import { createOverpassFetcher } from "./overpass-client";
import type { OverpassArea } from "./osm-poi";

const AREA: OverpassArea = {
  corridor: [
    { lat: -37.8, lon: 144.96 },
    { lat: -37.9, lon: 145.0 },
  ],
  radiusMeters: 2000,
};

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockResponse({
  status = 200,
  body = { elements: [] },
  headers = {},
}: MockResponseInit = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: {
      get: (name: string) =>
        headers[
          Object.keys(headers).find(
            (k) => k.toLowerCase() === name.toLowerCase()
          ) ?? ""
        ] ?? null,
    },
  } as unknown as Response;
}

const ELEMENTS = {
  elements: [
    {
      id: 1,
      type: "node",
      lat: -37.81,
      lon: 144.97,
      tags: { amenity: "drinking_water" },
    },
    {
      id: 2,
      type: "way",
      center: { lat: -37.85, lon: 144.98 },
      tags: { tourism: "camp_site" },
    },
    { id: 3, type: "relation", tags: { shop: "supermarket" } }, // no coordinates - dropped
  ],
};

describe("createOverpassFetcher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts the built query and normalizes the response", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ body: ELEMENTS }));
    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 0,
    });

    const pois = await fetcher(AREA, ["water", "camping"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    const body = decodeURIComponent(String(init.body).replace(/^data=/, ""));
    expect(body).toContain("nwr[");
    expect(body).toContain("out center;");
    expect(body).toContain("around:2000");

    // The coordless relation is dropped; the way uses its center
    expect(pois.map((p) => p.id)).toEqual([1, 2]);
    expect(pois[1].lat).toBe(-37.85);
  });

  it("honours a custom endpoint and timeout in the query", async () => {
    const fetchMock = vi.fn(async () => mockResponse());
    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 0,
      endpoint: "https://overpass.kumi.systems/api/interpreter",
      timeoutSeconds: 90,
    });

    await fetcher(AREA, ["water"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://overpass.kumi.systems/api/interpreter");
    expect(decodeURIComponent(String(init.body))).toContain("[timeout:90]");
  });

  it("retries a 429 after the Retry-After delay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ status: 429, headers: { "Retry-After": "3" } })
      )
      .mockResolvedValueOnce(mockResponse({ body: ELEMENTS }));

    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 1000,
      maxRetries: 2,
    });

    const promise = fetcher(AREA, ["water"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still waiting out Retry-After at 2.9 s
    await vi.advanceTimersByTimeAsync(2900);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx with exponential backoff and gives up after maxRetries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 503 }));
    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 100,
      maxRetries: 2,
    });

    const promise = fetcher(AREA, ["water"]);
    const assertion = expect(promise).rejects.toThrow(/503/);

    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    // Initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable status", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: 400 }));
    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 0,
      maxRetries: 3,
    });

    await expect(fetcher(AREA, ["water"])).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the HTTP request once the Overpass timeout plus slack elapses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );

    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 0,
      maxRetries: 0,
      timeoutSeconds: 5,
    });

    const promise = fetcher(AREA, ["water"]);
    const assertion = expect(promise).rejects.toThrow(/timed out after 10s/);

    // timeoutSeconds (5) + 5 s slack
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });

  it("spaces consecutive requests by minDelayMs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => mockResponse({ body: ELEMENTS }));
    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 2000,
    });

    const first = fetcher(AREA, ["water"]);
    const second = fetcher(AREA, ["camping"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1900);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(first).resolves.toHaveLength(2);
    await expect(second).resolves.toHaveLength(2);
  });

  it("rejects with an AbortError when the caller cancels", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );

    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 0,
    });

    const promise = fetcher(AREA, ["water"], controller.signal);
    // Let the queued request actually reach fetch before cancelling
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not issue a request for an already-aborted signal", async () => {
    const fetchMock = vi.fn(async () => mockResponse());
    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 0,
    });

    await expect(
      fetcher(AREA, ["water"], AbortSignal.abort())
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps working after a failed request (the queue is not poisoned)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400 }))
      .mockResolvedValueOnce(mockResponse({ body: ELEMENTS }));

    const fetcher = createOverpassFetcher({
      fetch: fetchMock as unknown as typeof fetch,
      minDelayMs: 0,
      maxRetries: 0,
    });

    await expect(fetcher(AREA, ["water"])).rejects.toThrow();
    await expect(fetcher(AREA, ["water"])).resolves.toHaveLength(2);
  });
});
