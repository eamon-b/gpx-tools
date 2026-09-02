/**
 * Direct Overpass API access.
 *
 * Used by Node build scripts that talk to Overpass without the Vercel proxy in
 * front of them. Browser tools should keep using `proxyPOIFetcher` from
 * ./api-client.js so requests stay rate-limited and cached server-side.
 *
 * Runtime-neutral: only global `fetch`, `AbortController` and timers.
 */

import {
  buildOverpassQuery,
  normalizeOverpassElements,
  type OverpassArea,
  type OverpassElement,
  type POI,
  type POIType,
} from "./osm-poi.js";

export interface OverpassFetcherOptions {
  /** Overpass instance. Default the main public endpoint. */
  endpoint?: string;
  /** Injectable fetch, for tests or for a custom agent. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Minimum gap between request starts. Overpass etiquette asks for a slow trickle. Default 2000 ms. */
  minDelayMs?: number;
  /** Overpass `[timeout:]` in seconds. The HTTP abort fires 5 s later. Default 22. */
  timeoutSeconds?: number;
  /** Retries after a retryable failure. Default 2, exponential backoff, honours Retry-After. */
  maxRetries?: number;
}

/** How a caller obtains POIs for an area — proxy-backed or direct Overpass. */
export type POIFetcher = (
  area: OverpassArea,
  types: POIType[],
  signal?: AbortSignal
) => Promise<POI[]>;

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** Sleep that rejects with an AbortError as soon as `signal` fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const when = Date.parse(value);
  if (Number.isFinite(when)) {
    return Math.max(0, when - Date.now());
  }
  return null;
}

/**
 * Create a POIFetcher that queries Overpass directly.
 *
 * Requests are serialised through an internal queue and spaced by
 * `minDelayMs`: Overpass allocates very few slots per source IP, so parallel
 * queries mostly earn 429s and get us blocked rather than finishing sooner.
 */
export function createOverpassFetcher(
  opts: OverpassFetcherOptions = {}
): POIFetcher {
  const endpoint = opts.endpoint ?? "https://overpass-api.de/api/interpreter";
  const doFetch =
    opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const minDelayMs = opts.minDelayMs ?? 2000;
  const timeoutSeconds = opts.timeoutSeconds ?? 22;
  const maxRetries = opts.maxRetries ?? 2;
  // Give Overpass its full server-side budget plus slack for transfer before
  // giving up on the socket, otherwise we abort answers that were about to land.
  const httpTimeoutMs = (timeoutSeconds + 5) * 1000;

  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;

  const runOne = async (
    area: OverpassArea,
    types: POIType[],
    signal?: AbortSignal
  ): Promise<POI[]> => {
    const query = buildOverpassQuery(area, types, { timeoutSeconds });
    let lastError: Error = new Error("Overpass request failed");

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        throw abortError();
      }

      const wait = lastStart + minDelayMs - Date.now();
      if (wait > 0) {
        await delay(wait, signal);
      }
      lastStart = Date.now();

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, httpTimeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

      /** Set when the failure must not be retried. */
      let fatal: Error | null = null;
      let retryDelayMs = minDelayMs * Math.pow(2, attempt);

      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          body: `data=${encodeURIComponent(query)}`,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          signal: controller.signal,
        });

        if (response.ok) {
          const data = (await response.json()) as {
            elements?: OverpassElement[];
          };
          return normalizeOverpassElements(data?.elements);
        }

        lastError = new Error(`Overpass request failed: ${response.status}`);
        // 429 (no free slot) and 5xx (incl. the 504 Overpass returns when a
        // query outruns its timeout) are the "come back later" answers.
        if (response.status === 429 || response.status >= 500) {
          retryDelayMs =
            parseRetryAfter(response.headers?.get?.("Retry-After")) ??
            retryDelayMs;
        } else {
          fatal = lastError;
        }
      } catch (error) {
        if (signal?.aborted) {
          throw abortError();
        }
        lastError = timedOut
          ? new Error(
              `Overpass request timed out after ${httpTimeoutMs / 1000}s`
            )
          : (error as Error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }

      if (fatal) {
        throw fatal;
      }
      if (attempt >= maxRetries) {
        break;
      }
      await delay(retryDelayMs, signal);
    }

    throw lastError;
  };

  return (area, types, signal) => {
    const result = queue.then(() => runOne(area, types, signal));
    // Keep the chain alive whatever this call does, so one failure does not
    // poison every later request.
    queue = result.catch(() => undefined);
    return result;
  };
}
