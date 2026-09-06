import {
  normalizeOverpassElements,
  overpassPayloadError,
  roundCoord,
  type BBox,
  type LatLon,
  type OverpassArea,
  type OverpassElement,
  type POI,
  type POIType,
} from "./osm-poi.js";
import type { POIFetcher } from "./overpass-client.js";

const API_BASE = "/api";

/** Per-attempt HTTP timeout. Matches the proxy's own 30 s function budget. */
const ATTEMPT_TIMEOUT_MS = 30000;

/**
 * Upper bound on a server-specified retry delay.
 *
 * `resetIn`/`retryAfter` come from a response body we do not control: a buggy
 * (or hostile) proxy answering `retryAfter: 86400` must not park the browser
 * for a day, and a non-numeric value must never reach `setTimeout` as NaN.
 */
const MAX_SERVER_DELAY_SECONDS = 120;

/**
 * Wire format for POST /api/overpass.
 *
 * The area is spread flat at the top level (rather than nested under `area`)
 * so the serverless handler can validate a single object, and corridors travel
 * as compact `[lat, lon]` pairs to keep the payload small on long routes.
 * A corridor is one polyline (`[[lat, lon], ...]`) or several
 * (`[[[lat, lon], ...], ...]`); the server's vertex limit applies to the total.
 */
export type POIRequest =
  | {
      corridor: [number, number][] | [number, number][][];
      radiusMeters: number;
      types: POIType[];
    }
  | { bounds: BBox; types: POIType[] };

interface ElevationResult {
  lat: number;
  lon: number;
  elevation: number | null;
}

interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

// Exponential backoff with jitter
function calculateBackoff(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, options.maxDelayMs);
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Sleep that rejects with an AbortError as soon as `signal` fires, so pressing
 * Cancel during a backoff wait stops right away instead of at the end of it.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) {
    return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry delay (seconds) the server asked for, or undefined when it did not ask
 * for a usable one. Only a finite positive number counts, and it is clamped:
 * see MAX_SERVER_DELAY_SECONDS.
 */
function serverDelaySeconds(body: unknown): number | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const { resetIn, retryAfter } = body as {
    resetIn?: unknown;
    retryAfter?: unknown;
  };
  for (const value of [resetIn, retryAfter]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.min(value, MAX_SERVER_DELAY_SECONDS);
    }
  }
  return undefined;
}

/** Round one polyline's vertices into the compact `[lat, lon]` wire form. */
function toWireVertices(polyline: LatLon[]): [number, number][] {
  return polyline.map(
    (p) => [roundCoord(p.lat), roundCoord(p.lon)] as [number, number]
  );
}

/** Turn an OverpassArea into the flat wire body, rounding coordinates. */
export function toPOIRequest(area: OverpassArea, types: POIType[]): POIRequest {
  if ("corridor" in area) {
    const corridor = area.corridor;
    // One polyline or several: keep whichever shape the caller sent.
    const nested = corridor.length > 0 && Array.isArray(corridor[0]);
    return {
      corridor: nested
        ? (corridor as LatLon[][]).map(toWireVertices)
        : toWireVertices(corridor as LatLon[]),
      radiusMeters: Math.round(area.radiusMeters),
      types,
    };
  }
  return {
    bounds: {
      south: roundCoord(area.bounds.south),
      north: roundCoord(area.bounds.north),
      west: roundCoord(area.bounds.west),
      east: roundCoord(area.bounds.east),
    },
    types,
  };
}

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
    public isRetryable: boolean = false
  ) {
    super(message);
    this.name = "APIError";
  }
}

export class APIClient {
  private baseUrl: string;
  private retryOptions: RetryOptions;

  constructor(
    baseUrl: string = API_BASE,
    retryOptions: Partial<RetryOptions> = {}
  ) {
    this.baseUrl = baseUrl;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  }

  private async fetchWithRetry<T>(
    url: string,
    options: RequestInit,
    parseResponse: (response: Response) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw abortError();
      }

      try {
        // Per-attempt timeout, combined with the caller's cancellation signal
        // so an aborted enrichment stops immediately instead of after the timeout.
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, ATTEMPT_TIMEOUT_MS);
        const onOuterAbort = () => controller.abort();
        signal?.addEventListener("abort", onOuterAbort, { once: true });

        // The timer and the abort listener are torn down only once the body has
        // been read: a response whose body stalls mid-stream must still hit the
        // timeout, and Cancel must still interrupt it.
        try {
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          if (response.ok) {
            return await parseResponse(response);
          }

          // Handle specific error codes
          const errorBody = await response
            .json()
            .catch(() => ({ error: "Unknown error" }));
          const serverDelay = serverDelaySeconds(errorBody);

          if (response.status === 429) {
            const retryAfter = serverDelay ?? 60;
            throw new APIError(
              `Rate limited. Try again in ${retryAfter} seconds.`,
              429,
              retryAfter,
              true
            );
          }

          if (response.status >= 500) {
            throw new APIError(
              errorBody.error || `Server error: ${response.status}`,
              response.status,
              // 503 from the proxy carries the same "come back in N s" hint.
              serverDelay,
              true // Server errors are retryable
            );
          }

          // Client errors (4xx except 429) are not retryable
          throw new APIError(
            errorBody.error || `Request failed: ${response.status}`,
            response.status,
            undefined,
            false
          );
        } catch (error) {
          // Our own timeout, not the caller's Cancel: report it as a retryable
          // APIError so nothing downstream mistakes it for user cancellation.
          if (timedOut && !signal?.aborted && !(error instanceof APIError)) {
            throw new APIError(
              `Request timed out after ${ATTEMPT_TIMEOUT_MS / 1000} s`,
              0,
              undefined,
              true
            );
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", onOuterAbort);
        }
      } catch (error) {
        // Caller cancellation is final; never burn retries on it.
        if (signal?.aborted) {
          throw abortError();
        }

        lastError = error as Error;

        // Don't retry non-retryable errors
        if (error instanceof APIError && !error.isRetryable) {
          throw error;
        }

        // Don't retry if we've exhausted attempts
        if (attempt >= this.retryOptions.maxRetries) {
          break;
        }

        // Honour a server-specified delay (429/503); otherwise back off.
        const delayMs =
          error instanceof APIError && error.retryAfter
            ? error.retryAfter * 1000
            : calculateBackoff(attempt, this.retryOptions);
        await sleep(delayMs, signal);
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /**
   * Fetch POIs for an area through the /api/overpass proxy.
   *
   * The proxy answers with a raw Overpass payload, so the elements are
   * normalized here (ways/relations carry their point in `center`).
   */
  async fetchPOIs(
    area: OverpassArea,
    types: POIType[],
    signal?: AbortSignal
  ): Promise<POI[]> {
    return this.fetchWithRetry(
      `${this.baseUrl}/overpass`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPOIRequest(area, types)),
      },
      async (response) => {
        const data = (await response.json().catch(() => null)) as {
          elements?: OverpassElement[];
        } | null;
        // Overpass reports runtime failures with HTTP 200 and a `remark`. The
        // proxy turns those into 503s, but a stale cached payload or a
        // direct-to-Overpass base URL can still deliver one: retry it rather
        // than telling the user there is nothing along their route.
        const payloadError = overpassPayloadError(data);
        if (payloadError) {
          throw new APIError(payloadError, response.status, undefined, true);
        }
        return normalizeOverpassElements(data?.elements);
      },
      signal
    );
  }

  async fetchElevations(
    locations: { lat: number; lon: number }[]
  ): Promise<ElevationResult[]> {
    return this.fetchWithRetry(
      `${this.baseUrl}/elevation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locations }),
      },
      async (response) => {
        const data = await response.json();
        return data.results;
      }
    );
  }

  // Fetch elevations in batches with partial failure handling
  async fetchElevationsBatched(
    locations: { lat: number; lon: number }[],
    batchSize: number = 200,
    onProgress?: (completed: number, total: number) => void
  ): Promise<ElevationResult[]> {
    const results: ElevationResult[] = [];
    const batches: { lat: number; lon: number }[][] = [];

    // Split into batches
    for (let i = 0; i < locations.length; i += batchSize) {
      batches.push(locations.slice(i, i + batchSize));
    }

    let completed = 0;
    for (const batch of batches) {
      try {
        const batchResults = await this.fetchElevations(batch);
        results.push(...batchResults);
      } catch (error) {
        // On failure, fill with nulls so we don't lose position alignment
        console.warn("Elevation batch failed:", error);
        results.push(
          ...batch.map((loc) => ({
            lat: loc.lat,
            lon: loc.lon,
            elevation: null,
          }))
        );
      }

      completed += batch.length;
      onProgress?.(completed, locations.length);

      // Small delay between batches to be nice to the server
      if (batches.indexOf(batch) < batches.length - 1) {
        await sleep(100);
      }
    }

    return results;
  }

  async checkHealth(): Promise<{
    status: string;
    checks: Record<string, boolean>;
  }> {
    const response = await fetch(`${this.baseUrl}/health`);
    return response.json();
  }
}

// Singleton instance
export const apiClient = new APIClient();

/**
 * The default POIFetcher for browser tools: routes through the proxy so the
 * server-side cache and rate limiter stay in play.
 *
 * Written as a wrapper rather than a bound method so tests can spy on
 * `apiClient.fetchPOIs` and still intercept the call.
 */
export const proxyPOIFetcher: POIFetcher = (area, types, signal) =>
  apiClient.fetchPOIs(area, types, signal);

/**
 * Bounding box around a set of points, padded by `bufferKm`.
 * Retained for bbox-mode callers; `enrichRoute` uses corridors instead.
 */
export function getBoundsFromPoints(
  points: { lat: number; lon: number }[],
  bufferKm: number = 5
): BBox {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);

  // Approximate degrees per km
  const latBuffer = bufferKm / 111;
  const lonBuffer =
    bufferKm /
    (111 *
      Math.cos(
        (((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180
      ));

  return {
    south: Math.min(...lats) - latBuffer,
    north: Math.max(...lats) + latBuffer,
    west: Math.min(...lons) - lonBuffer,
    east: Math.max(...lons) + lonBuffer,
  };
}

/**
 * Split large bounding boxes into smaller chunks for API requests.
 *
 * The server enforces a maximum of 1.5 degrees per side (CORRIDOR_LIMITS.maxBBoxDegrees),
 * so bbox-mode callers covering long trails must chunk and merge client-side.
 * Corridor mode (the default in enrichRoute) does not need this.
 */
export function splitBounds(bounds: BBox, maxDegrees: number = 1.5): BBox[] {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;

  if (latSpan <= maxDegrees && lonSpan <= maxDegrees) {
    return [bounds];
  }

  const latChunks = Math.ceil(latSpan / maxDegrees);
  const lonChunks = Math.ceil(lonSpan / maxDegrees);
  const latStep = latSpan / latChunks;
  const lonStep = lonSpan / lonChunks;

  const chunks: BBox[] = [];

  for (let i = 0; i < latChunks; i++) {
    for (let j = 0; j < lonChunks; j++) {
      chunks.push({
        south: bounds.south + i * latStep,
        north: bounds.south + (i + 1) * latStep,
        west: bounds.west + j * lonStep,
        east: bounds.west + (j + 1) * lonStep,
      });
    }
  }

  return chunks;
}

// Export types for consumers (POI/POIType/areas come from osm-poi — one definition only)
export type { POI, POIType, OverpassArea, BBox, ElevationResult, RetryOptions };
export type { POIFetcher };
