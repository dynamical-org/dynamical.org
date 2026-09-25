// icechunk-js FetchClient for virtual chunk reads that retries upstream throttling.
//
// About 5% of ecmwf-aifs-single-forecast-virtual's references (2024-11 to 2025-02) point at
// s3://ecmwf-forecasts (eu-central-1). That bucket intermittently answers large range GETs
// with "503 Slow Down" carrying no CORS headers, which a browser reports as a TypeError
// ("Failed to fetch"), not as a 503. So network errors are retried as well as 429 and 5xx.
// Pass it per store: IcechunkStore.open(url, { fetchClient: retryingFetchClient() }).

/** @typedef {{ fetch(url: string, init?: RequestInit): Promise<Response> }} FetchClient */

/**
 * @param {object} [options]
 * @param {number} [options.maxAttempts] Total tries per request, including the first.
 * @param {number} [options.baseMs] Backoff before retry n is baseMs * 2^(n-1), jittered 0.5–1.5×.
 * @param {typeof fetch} [options.fetchImpl] Defaults to globalThis.fetch (injectable for tests).
 * @param {(ms: number) => Promise<void>} [options.sleep] Injectable for tests.
 * @param {(info: { url: string, attempt: number, reason: string }) => void} [options.onRetry]
 *   Called before each retry, e.g. to show "upstream is throttling, retrying…".
 * @returns {FetchClient & { stats: { attempts: number, retries: number } }}
 */
export function retryingFetchClient({
  maxAttempts = 6,
  baseMs = 250,
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry,
} = {}) {
  const stats = { attempts: 0, retries: 0 };
  return {
    stats,
    async fetch(url, init) {
      for (let attempt = 1; ; attempt++) {
        stats.attempts++;
        let reason;
        try {
          const response = await fetchImpl(url, init);
          if (response.status !== 429 && response.status < 500) return response;
          if (attempt >= maxAttempts) return response;
          reason = `HTTP ${response.status}`;
          response.body?.cancel().catch(() => {});
        } catch (e) {
          if (init?.signal?.aborted || attempt >= maxAttempts) throw e;
          reason = e instanceof Error ? e.message : String(e);
        }
        stats.retries++;
        onRetry?.({ url, attempt, reason });
        await sleep(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
        init?.signal?.throwIfAborted();
      }
    },
  };
}
