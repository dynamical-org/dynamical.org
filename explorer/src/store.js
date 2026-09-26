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
import { HttpStorage, IcechunkStore, encodeObjectId12 } from "icechunk-js";
import * as zarr from "zarrita";
import { registerCodecs } from "./codecs.js";
import { retryingFetchClient } from "./grib/retry-fetch.js";
import { cachedPromise } from "./lib/cache.js";

/**
 * @typedef {{
 *   store: zarr.AsyncReadable & { getRange: NonNullable<zarr.AsyncReadable["getRange"]> },
 *   snapshotId: string | null,
 *   getMeta: (path: string) => Promise<Record<string, any> | null>,
 *   open: (path: string) => Promise<zarr.Array<zarr.DataType, zarr.Readable>>,
 * }} Store
 */

/** Icechunk objects named by their content hash; everything else (the v2 "repo"
 * file, v1 refs/) can change in place. */
const IMMUTABLE = /^\/?(snapshots|manifests|chunks|transactions)\//;

/**
 * An Icechunk storage that revalidates mutable objects (`cache: "no-cache"`),
 * so a reload never opens a snapshot a stale cached "repo" points at, while
 * content-addressed objects keep the browser's normal HTTP caching.
 * @param {string} url
 * @returns {import("icechunk-js").Storage}
 */
function revalidatingStorage(url) {
  const cached = new HttpStorage(url);
  const fresh = new HttpStorage(url, { cache: "no-cache" });
  const pick = (path) => (IMMUTABLE.test(path) ? cached : fresh);
  return {
    getObject: (path, range, options) => pick(path).getObject(path, range, options),
    exists: (path, options) => pick(path).exists(path, options),
    listPrefix: (prefix) => pick(prefix).listPrefix(prefix),
  };
}

/**
 * @param {string} href
 * @param {{ signal?: AbortSignal, onRetry?: (info: { url: string, attempt: number, reason: string }) => void }} [opts]
 *   `onRetry` is called before each retry of a virtual chunk read (for a status line).
 * @returns {Promise<Store>}
 */
export async function openStore(href, { signal, onRetry } = {}) {
  registerCodecs();
  const url = href.replace(/\/$/, "");
  if (!/\.zarr$/.test(url)) {
    const store = await IcechunkStore.open(revalidatingStorage(url), {
      branch: "main",
      signal,
      fetchClient: retryingFetchClient({ onRetry }),
    });
    const root = zarr.root(store);
    return {
      store,
      snapshotId: encodeObjectId12(store.session.getSnapshotId()),
      getMeta: async (path) => /** @type {any} */ (store.getMetadata(path)),
      open: (path) => zarr.open(root.resolve(path), { kind: "array" }),
    };
  }
  const store = new zarr.FetchStore(url);
  const root = zarr.root(store);
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
