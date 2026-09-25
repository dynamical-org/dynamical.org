// Tile facade for whole-grid chunks (the virtual GRIB stores).
//
// A virtual store's chunk is one GRIB message: one step of one variable over the whole grid,
// e.g. (1, 1, 721, 1440) for GFS or (1, 1, 1059, 1799) for HRRR. deck.gl-zarr makes one tile,
// and so one reprojection mesh, per chunk. For a globe-sized tile the mesh refinement hits its
// 10,000-iteration cap at the clamped poles, and mid-latitudes render 1–3 cells off (17/54
// points in the right cell in the spike, against 54/54 with 121×121 tiles).
//
// So ZarrLayer gets a facade: an object with the real array's shape, dimension names and
// attrs, but spatial chunks of at most `tileSize`. Tiles are read through `get`, which has
// zarr.get's signature. It fetches and decodes each real chunk once, through a small shared
// cache, and copies out each tile's window. Hook-up: pass `facade.view` as ZarrLayer's `node`,
// and call `facade.get` where tile code calls `zarr.get`.
//
// The view also moves (y, x) to the end. Level variables in the virtual stores put their level
// dim after the grid, e.g. (init_time, lead_time, latitude, longitude, pressure_level) with
// chunk (1, 1, 721, 1440, 1), and deck.gl-zarr 0.8.1 requires the spatial dims last (it has no
// transpose). Since every non-spatial chunk is 1 wide, reordering is only index bookkeeping.
//
// No zarrita import: the caller passes zarr.get in, so this module is testable offline.

/**
 * @typedef {number | null | { start: number | null, stop: number | null, step?: number | null }} DimSel
 * @typedef {{ data: ArrayLike<number> & { length: number, constructor: any }, shape: number[] }} GetResult
 * @typedef {(arr: any, selection: DimSel[], opts?: { signal?: AbortSignal }) => Promise<GetResult>} GetFn
 */

/**
 * True when every chunk is one full grid at one position on every other dim: the virtual
 * stores' layout, which the facade expects.
 *
 * @param {{ shape: number[], chunks: number[] }} array
 * @param {[number, number]} [spatial] indices of the (y, x) dims; default the last two
 */
export function isWholeGridChunked(array, spatial) {
  const n = array.shape.length;
  const [iy, ix] = spatial ?? [n - 2, n - 1];
  if (n < 2 || !(iy >= 0 && iy < ix && ix < n)) return false;
  return array.chunks.every((c, i) => (i === iy || i === ix ? c >= array.shape[i] : c === 1));
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** @param {DimSel} sel @param {number} size @returns {number[] | number} indices, or a scalar index */
function expand(sel, size) {
  if (typeof sel === "number") return sel < 0 ? sel + size : sel;
  const start = sel?.start ?? 0;
  const stop = Math.min(sel?.stop ?? size, size);
  const step = sel?.step ?? 1;
  const out = [];
  for (let i = start; i < stop; i += step) out.push(i);
  return out;
}

/**
 * @param {object} options
 * @param {{ shape: number[], chunks: number[], dimensionNames?: (string|null)[], attrs?: object, dtype?: string }} options.array
 *   The real zarrita array (whole-grid chunks, see isWholeGridChunked).
 * @param {GetFn} options.get zarrita's `get`.
 * @param {[number, number]} [options.spatial] indices of the (y, x) dims in `array`; default the last two.
 * @param {number} [options.tileSize] Logical tile edge in cells (121 matches the materialized GFS store).
 * @param {number} [options.cacheSize] Decoded chunks kept (each is a full grid: 0.25° f64 ≈ 8.3 MB).
 * @param {number} [options.maxConcurrent] Real chunk reads in flight at once.
 */
export function createTileFacade({ array, get, spatial, tileSize = 121, cacheSize = 4, maxConcurrent = 4 }) {
  const n = array.shape.length;
  const [iy, ix] = spatial ?? [n - 2, n - 1];
  if (!isWholeGridChunked(array, [iy, ix])) {
    throw new Error(`tile facade needs whole-grid chunks, got chunks [${array.chunks}] for shape [${array.shape}]`);
  }
  const H = array.shape[iy];
  const W = array.shape[ix];
  /** Real dim index of each view dim: the non-spatial dims in order, then y, x. */
  const order = [...array.shape.keys()].filter((i) => i !== iy && i !== ix).concat(iy, ix);
  const nonSpatial = order.slice(0, -2);
  const view = {
    shape: order.map((i) => array.shape[i]),
    chunks: [...nonSpatial.map(() => 1), Math.min(tileSize, H), Math.min(tileSize, W)],
    dimensionNames: array.dimensionNames && order.map((i) => array.dimensionNames[i]),
    attrs: array.attrs,
    dtype: array.dtype,
  };

  /** @type {Map<string, Promise<GetResult>>} insertion order = LRU order */
  const cache = new Map();
  const stats = { reads: 0, hits: 0 };
  let active = 0;
  /** @type {(() => void)[]} */
  const queue = [];

  async function limited(fn) {
    if (active >= maxConcurrent) await new Promise((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  }

  /** One full grid at the given non-spatial indices; shared by every tile that needs it. */
  function fullGrid(indices) {
    const key = indices.join(",");
    let p = cache.get(key);
    if (p) {
      stats.hits++;
      cache.delete(key); // refresh LRU position
      cache.set(key, p);
      return p;
    }
    // No signal: the read is shared, so one tile's abort must not fail the others.
    const selection = new Array(n).fill(null);
    nonSpatial.forEach((d, k) => (selection[d] = indices[k]));
    p = limited(() => {
      stats.reads++;
      return get(array, selection);
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return p;
  }

  /**
   * zarr.get-compatible read of `view`, with the selection in the view's dim order (the
   * facade object is ignored; `array` is read). Numbers drop their dim, slices and null
   * keep it, as in zarrita.
   *
   * @param {unknown} _view
   * @param {DimSel[]} selection
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ data: any, shape: number[], stride: number[] }>}
   */
  async function read(_view, selection, opts = {}) {
    const { signal } = opts;
    signal?.throwIfAborted();
    if (selection.length !== n) throw new Error(`selection has ${selection.length} dims, array has ${n}`);
    const lead = selection.slice(0, -2).map((sel, k) => expand(sel, array.shape[nonSpatial[k]]));
    const rows = expand(selection[n - 2], H);
    const cols = expand(selection[n - 1], W);
    if (!Array.isArray(rows) || !Array.isArray(cols)) throw new Error("tile facade: spatial dims must be slices");
    const keptShape = lead.filter(Array.isArray).map((a) => a.length);
    // Cartesian product of the non-spatial indices, in C order.
    /** @type {number[][]} */
    let combos = [[]];
    for (const l of lead) combos = combos.flatMap((c) => (Array.isArray(l) ? l : [l]).map((i) => [...c, i]));
    const grids = await Promise.all(combos.map((c) => fullGrid(c)));
    if (signal?.aborted) throw abortError();
    const h = rows.length, w = cols.length;
    const Ctor = grids[0]?.data.constructor ?? Float64Array;
    const out = new Ctor(combos.length * h * w);
    grids.forEach((g, k) => {
      if (g.shape.at(-2) !== H || g.shape.at(-1) !== W) {
        throw new Error(`tile facade: chunk read returned shape [${g.shape}], expected [..., ${H}, ${W}]`);
      }
      const base = k * h * w;
      for (let r = 0; r < h; r++) {
        const src = rows[r] * W;
        for (let c = 0; c < w; c++) out[base + r * w + c] = g.data[src + cols[c]];
      }
    });
    const shape = [...keptShape, h, w];
    const stride = new Array(shape.length);
    for (let i = shape.length - 1, acc = 1; i >= 0; i--) {
      stride[i] = acc;
      acc *= shape[i];
    }
    return { data: out, shape, stride };
  }

  return {
    view,
    get: read,
    stats,
    /** Drop cached grids, e.g. on variable switch or destroy. */
    clear: () => cache.clear(),
  };
}
