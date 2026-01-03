const API_BASE = typeof import.meta !== 'undefined' && import.meta.env?.PROD ? '/api' : 'http://localhost:3000/api';

interface POIRequest {
  bounds: {
    south: number;
    north: number;
    west: number;
    east: number;
  };
  types: string[];
}

interface POI {
  id: number;
  type: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

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
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
    public isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export class APIClient {
  private baseUrl: string;
  private retryOptions: RetryOptions;

  constructor(baseUrl: string = API_BASE, retryOptions: Partial<RetryOptions> = {}) {
    this.baseUrl = baseUrl;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  }

  private async fetchWithRetry<T>(
    url: string,
    options: RequestInit,
    parseResponse: (response: Response) => Promise<T>
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return await parseResponse(response);
        }

        // Handle specific error codes
        const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));

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
        } else if (error instanceof Error && error.name === 'AbortError') {
          // Timeout - use backoff
          await sleep(calculateBackoff(attempt, this.retryOptions));
        } else {
          // Network error or server error - use backoff
          await sleep(calculateBackoff(attempt, this.retryOptions));
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  async fetchPOIs(request: POIRequest): Promise<POI[]> {
    return this.fetchWithRetry(
      `${this.baseUrl}/overpass`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      async (response) => {
        const data = await response.json();
        // Transform Overpass response to simplified POI format
        return data.elements?.map((el: { id: number; type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }) => ({
          id: el.id,
          type: el.type,
          lat: el.lat || el.center?.lat,
          lon: el.lon || el.center?.lon,
          tags: el.tags || {},
        })) || [];
      }
    );
  }

  async fetchElevations(locations: { lat: number; lon: number }[]): Promise<ElevationResult[]> {
    return this.fetchWithRetry(
      `${this.baseUrl}/elevation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        console.warn('Elevation batch failed:', error);
        results.push(...batch.map(loc => ({
          lat: loc.lat,
          lon: loc.lon,
          elevation: null,
        })));
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

  async checkHealth(): Promise<{ status: string; checks: Record<string, boolean> }> {
    const response = await fetch(`${this.baseUrl}/health`);
    return response.json();
  }
}

// Singleton instance
export const apiClient = new APIClient();

// Helper to get bounding box from GPX track points
export function getBoundsFromPoints(
  points: { lat: number; lon: number }[],
  bufferKm: number = 5
): POIRequest['bounds'] {
  const lats = points.map(p => p.lat);
  const lons = points.map(p => p.lon);

  // Approximate degrees per km
  const latBuffer = bufferKm / 111;
  const lonBuffer = bufferKm / (111 * Math.cos((Math.min(...lats) + Math.max(...lats)) / 2 * Math.PI / 180));

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
 * IMPORTANT: The server enforces a maximum of 1.5 degrees per side.
 * Long-distance trails (like AAWT spanning >2 degrees) MUST use this
 * function to chunk requests, then merge results client-side.
 *
 * Example usage:
 *   const chunks = splitBounds(getBoundsFromPoints(trackPoints));
 *   const allPOIs = await Promise.all(chunks.map(chunk => apiClient.fetchPOIs({ bounds: chunk, types })));
 *   const mergedPOIs = allPOIs.flat();
 */
export function splitBounds(
  bounds: POIRequest['bounds'],
  maxDegrees: number = 1.5
): POIRequest['bounds'][] {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;

  if (latSpan <= maxDegrees && lonSpan <= maxDegrees) {
    return [bounds];
  }

  const latChunks = Math.ceil(latSpan / maxDegrees);
  const lonChunks = Math.ceil(lonSpan / maxDegrees);
  const latStep = latSpan / latChunks;
  const lonStep = lonSpan / lonChunks;

  const chunks: POIRequest['bounds'][] = [];

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

// Export types for consumers
export type { POIRequest, POI, ElevationResult, RetryOptions };
