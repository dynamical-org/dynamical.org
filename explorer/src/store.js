// The one place stores are opened. An Icechunk repo is opened on its main
// branch once; the session is pinned to the snapshot the branch pointed at, so
// every later read (metadata, coordinates, chunks) comes from that snapshot.
//
// Virtual chunks (the *-virtual stores' GRIB messages on NOAA/ECMWF buckets) are
// read through a retrying fetch client: ecmwf-forecasts answers large range GETs
// with intermittent "503 Slow Down" that carries no CORS headers (seen by the page
// as a network error). icechunk-js uses the fetch client only for virtual chunks;
// the dynamical buckets (metadata, native chunks) keep plain fetches.
//
// A plain zarr v3 URL (ending in .zarr) opens with zarrita's FetchStore, which
// the verification harness uses for synthetic grids; anything else is Icechunk.
import { HttpStorage, IcechunkStore, NotFoundError, StorageError, encodeObjectId12 } from "icechunk-js";
import * as zarr from "zarrita";
import { registerCodecs } from "./codecs.js";
import { retryingFetchClient } from "./grib/retry-fetch.js";
import { cachingStore } from "./lib/byte-cache.js";
import { cachedPromise } from "./lib/cache.js";
import { meteredFetch } from "./lib/meter.js";

/**
 * @typedef {{
 *   store: zarr.AsyncReadable & { getRange: NonNullable<zarr.AsyncReadable["getRange"]> },
 *   snapshotId: string | null,
 *   getMeta: (path: string) => Promise<Record<string, any> | null>,
 *   open: (path: string) => Promise<zarr.Array<zarr.DataType, zarr.Readable>>,
 * }} Store
 */

/**
 * Default budget for the bytes kept of chunk reads (lib/byte-cache.js): enough for a
 * first view of the heaviest ensemble store, whose every chunk holds all its members.
 */
export const DEFAULT_CACHE_BYTES = 256e6;

/** Icechunk objects named by their content hash; everything else (the v2 "repo"
 * file, v1 refs/) can change in place. */
const IMMUTABLE = /^\/?(snapshots|manifests|chunks|transactions)\//;

/**
 * HttpStorage reading through a given fetch (icechunk-js's calls the global one), so the
 * explorer can count what the store's own objects (repo, snapshot, manifests, native chunks)
 * deliver. getObject is HttpStorage's, with only the fetch swapped.
 */
class FetchingStorage extends HttpStorage {
  constructor(url, options, fetchImpl) {
    super(url, options);
    this.fetchImpl = fetchImpl;
  }

  async getObject(path, range, options) {
    options?.signal?.throwIfAborted();
    const url = this.getUrl(path);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.getHeaders(range),
        credentials: this.options.credentials,
        cache: this.options.cache,
        signal: options?.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new StorageError(`Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error : undefined);
    }
    if (response.status === 404) throw new NotFoundError(path);
    if (response.status !== 200 && response.status !== 206) throw new StorageError(`HTTP ${response.status} ${response.statusText} for ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * An Icechunk storage that revalidates mutable objects (`cache: "no-cache"`),
 * so a reload never opens a snapshot a stale cached "repo" points at, while
 * content-addressed objects keep the browser's normal HTTP caching.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {import("icechunk-js").Storage}
 */
function revalidatingStorage(url, fetchImpl) {
  const cached = new FetchingStorage(url, {}, fetchImpl);
  const fresh = new FetchingStorage(url, { cache: "no-cache" }, fetchImpl);
  const pick = (path) => (IMMUTABLE.test(path) ? cached : fresh);
  return {
    getObject: (path, range, options) => pick(path).getObject(path, range, options),
    exists: (path, options) => pick(path).exists(path, options),
    listPrefix: (prefix) => pick(prefix).listPrefix(prefix),
  };
}

/**
 * @param {string} href
 * @param {{
 *   signal?: AbortSignal,
 *   onRetry?: (info: { url: string, attempt: number, reason: string }) => void,
 *   onBytes?: (bytes: number) => void,
 *   maxCacheBytes?: number,
 * }} [opts]
 *   `onRetry` is called before each retry of a virtual chunk read (for a status line).
 *   `onBytes` is called as response bodies arrive, on every path the store reads through:
 *   its own objects, upstream virtual chunks (each retry counts again), or a plain zarr URL.
 *   Arrays are opened through a byte cache of `maxCacheBytes` (lib/byte-cache.js), so a
 *   chunk read again (an ensemble member switch) comes from memory, not the network. For
 *   Icechunk it defaults to DEFAULT_CACHE_BYTES: the session is pinned to one snapshot, so a
 *   key's bytes can't change. A plain zarr URL has no such pin, so it caches nothing unless
 *   `maxCacheBytes` is given (the tests do, for fixtures that never change).
 * @returns {Promise<Store>}
 */
export async function openStore(href, { signal, onRetry, onBytes = () => {}, maxCacheBytes } = {}) {
  registerCodecs();
  const url = href.replace(/\/$/, "");
  const fetchImpl = meteredFetch((...args) => globalThis.fetch(...args), onBytes);
  if (!/\.zarr$/.test(url)) {
    const store = await IcechunkStore.open(revalidatingStorage(url, fetchImpl), {
      branch: "main",
      signal,
      fetchClient: retryingFetchClient({ onRetry, fetchImpl }),
    });
    const root = zarr.root(cachingStore(store, { maxBytes: maxCacheBytes ?? DEFAULT_CACHE_BYTES }));
    return {
      store,
      snapshotId: encodeObjectId12(store.session.getSnapshotId()),
      getMeta: async (path) => /** @type {any} */ (store.getMetadata(path)),
      open: (path) => zarr.open(root.resolve(path), { kind: "array" }),
    };
  }
  const store = new zarr.FetchStore(url, { fetch: fetchImpl });
  const root = zarr.root(cachingStore(store, { maxBytes: maxCacheBytes ?? 0 }));
  const metaCache = new Map();
  return {
    store,
    snapshotId: null,
    getMeta: (path) =>
      cachedPromise(metaCache, path, () => {
        const key = /** @type {zarr.AbsolutePath} */ (`${path === "/" ? "" : path}/zarr.json`);
        return store.get(key).then((b) => (b ? JSON.parse(new TextDecoder().decode(b)) : null));
      }),
    open: (path) => zarr.open(root.resolve(path), { kind: "array" }),
  };
}
