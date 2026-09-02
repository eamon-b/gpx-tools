import {
  normalizeOverpassElements,
  roundCoord,
  type BBox,
  type OverpassArea,
  type OverpassElement,
  type POI,
  type POIType,
} from "./osm-poi.js";
import type { POIFetcher } from "./overpass-client.js";

const API_BASE = "/api";

/**
 * Wire format for POST /api/overpass.
 *
 * The area is spread flat at the top level (rather than nested under `area`)
 * so the serverless handler can validate a single object, and corridors travel
 * as compact `[lat, lon]` pairs to keep the payload small on long routes.
 */
export type POIRequest =
  | { corridor: [number, number][]; radiusMeters: number; types: POIType[] }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** Turn an OverpassArea into the flat wire body, rounding coordinates. */
export function toPOIRequest(area: OverpassArea, types: POIType[]): POIRequest {
  if ("corridor" in area) {
    return {
      corridor: area.corridor.map(
        (p) => [roundCoord(p.lat), roundCoord(p.lon)] as [number, number]
      ),
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
        // Per-attempt 30s timeout, combined with the caller's cancellation signal
        // so an aborted enrichment stops immediately instead of after the timeout.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        const onOuterAbort = () => controller.abort();
        signal?.addEventListener("abort", onOuterAbort, { once: true });

        let response: Response;
        try {
          response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", onOuterAbort);
        }

        if (response.ok) {
          return await parseResponse(response);
        }

        // Handle specific error codes
        const errorBody = await response
          .json()
          .catch(() => ({ error: "Unknown error" }));

        if (response.status === 429) {
          const retryAfter = errorBody.resetIn || 60;
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
            undefined,
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

        // Handle rate limiting with server-specified delay
        if (error instanceof APIError && error.retryAfter) {
          await sleep(error.retryAfter * 1000);
        } else {
          // Timeout, network error or server error - use backoff
          await sleep(calculateBackoff(attempt, this.retryOptions));
        }
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
        const data = (await response.json()) as {
          elements?: OverpassElement[];
        };
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
