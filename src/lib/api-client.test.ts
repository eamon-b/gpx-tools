import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APIClient, toPOIRequest } from "./api-client";
import type { OverpassArea } from "./osm-poi";

/** A one-vertex corridor: enough to exercise the client, tiny on the wire. */
const AREA: OverpassArea = {
  corridor: [{ lat: 1, lon: 2 }],
  radiusMeters: 1000,
};

/** Minimal stand-in for a fetch Response; only `ok`, `status` and `json` are read. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that never settles until its signal aborts — models a stalled request. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  );
}

describe("toPOIRequest", () => {
  it("keeps a single corridor polyline flat and rounds its coordinates", () => {
    const request = toPOIRequest(
      {
        corridor: [
          { lat: 1.234567, lon: 2.345678 },
          { lat: 3, lon: 4 },
        ],
        radiusMeters: 2499.6,
      },
      ["water"]
    );

    expect(request).toEqual({
      corridor: [
        [1.2346, 2.3457],
        [3, 4],
      ],
      radiusMeters: 2500,
      types: ["water"],
    });
  });

  it("keeps several polylines nested", () => {
    const request = toPOIRequest(
      {
        corridor: [
          [{ lat: 1, lon: 2 }],
          [
            { lat: 3, lon: 4 },
            { lat: 5, lon: 6 },
          ],
        ],
        radiusMeters: 1000,
      },
      ["water", "camping"]
    );

    expect(request).toEqual({
      corridor: [
        [[1, 2]],
        [
          [3, 4],
          [5, 6],
        ],
      ],
      radiusMeters: 1000,
      types: ["water", "camping"],
    });
  });
});

describe("APIClient.fetchPOIs retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits the server's resetIn after a 429, then retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { resetIn: 5 }))
      .mockResolvedValueOnce(jsonResponse(200, { elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient().fetchPOIs(AREA, ["water"]);

    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500);
    await expect(promise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours a 503's resetIn as well as a 429's", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "Busy", resetIn: 20 }))
      .mockResolvedValueOnce(jsonResponse(200, { elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient().fetchPOIs(AREA, ["water"]);

    await vi.advanceTimersByTimeAsync(19000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500);
    await expect(promise).resolves.toEqual([]);
  });

  it("clamps an absurd server delay to 120 s", async () => {
    const fetchMock = vi
      .fn()
      // A buggy proxy asking for a day off must not park the browser for a day.
      .mockResolvedValueOnce(jsonResponse(503, { retryAfter: 86400 }))
      .mockResolvedValueOnce(jsonResponse(200, { elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient().fetchPOIs(AREA, ["water"]);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toEqual([]);
  });

  it("ignores a non-numeric resetIn instead of sleeping for NaN ms", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(503, { resetIn: "soon", retryAfter: 3 })
      )
      .mockResolvedValueOnce(jsonResponse(200, { elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient("/api", { maxRetries: 1 }).fetchPOIs(AREA, [
      "water",
    ]);

    // setTimeout(NaN) fires immediately; the usable retryAfter does not.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500);
    await expect(promise).resolves.toEqual([]);
  });

  it("falls back to exponential backoff when the server names no delay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockResolvedValueOnce(jsonResponse(200, { elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient("/api", {
      maxRetries: 1,
      baseDelayMs: 1000,
    }).fetchPOIs(AREA, ["water"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Base delay plus up to 30% jitter.
    await vi.advanceTimersByTimeAsync(1400);
    await expect(promise).resolves.toEqual([]);
  });

  it("stops backing off as soon as the caller cancels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const promise = new APIClient().fetchPOIs(
      AREA,
      ["water"],
      controller.signal
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Default 429 backoff is 60 s; Cancel must not wait it out.
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a stalled request and reports the timeout as an APIError, not an abort", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient("/api", { maxRetries: 1 }).fetchPOIs(AREA, [
      "water",
    ]);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "APIError",
      status: 0,
      isRetryable: true,
    });

    await vi.advanceTimersByTimeAsync(30_000); // attempt 1 times out
    await vi.advanceTimersByTimeAsync(2000); // backoff
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000); // attempt 2 times out
    await assertion;
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it("treats a 200 carrying an Overpass runtime error as a retryable failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        elements: [],
        remark: "runtime error: Query timed out in queryFilter",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient("/api", { maxRetries: 1 }).fetchPOIs(AREA, [
      "water",
    ]);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "APIError",
      isRetryable: true,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    // Retryable: the one retry was spent before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(promise).rejects.toThrow(/runtime error/i);
  });

  it("does not retry a client error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: "corridor too long" }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = new APIClient().fetchPOIs(AREA, ["water"]);
    const assertion = expect(promise).rejects.toThrow("corridor too long");

    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
