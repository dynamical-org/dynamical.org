// Everything the explorer knows about one variable, read from the store:
// dims, grid, coordinates, the latest usable run or time, and missing-value
// handling. Each variable is described from scratch (nothing carries over from
// the previously selected one).
import * as zarr from "zarrita";
import { canDecode } from "./codecs.js";
import { lonLatToCell, projectionDef } from "./crs.js";
import { createTileFacade } from "./grib/tile-facade.js";
import { cachedPromise } from "./lib/cache.js";
import { missingSentinels } from "./lib/colour.js";
import { absolutePath, dimLabel, latestWithChunk, layoutOf, probeLatest } from "./lib/dims.js";
import { buildGrid } from "./lib/grid.js";
import { decodeCf } from "./lib/time.js";

const NUMERIC = /^(u?int(8|16|32|64)|float(16|32|64))$/;

/** Parent group path of an array path: "/a/b" → "/a", "/b" → "". */
const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));

/**
 * Tile edge for whole-grid chunks (the virtual stores; see grib/tile-facade.js), in
 * cells: 121, and for lat/lon grids no more than ~30° of latitude. deck.gl-raster's
 * reprojection mesh stops refining after 10,000 iterations, and a tile reaching the pole
 * then leaves error far from it: a 0.5° grid's 121-row tile spans 90N–29.5N.
 */
function facadeTile(g) {
  if (g.crs.kind !== "geographic") return 121;
  const dy = Math.abs(g.attrs["spatial:transform"][4]);
  return Math.max(16, Math.min(121, Math.round(30.25 / dy)));
}

/** True for the virtual (GRIB-referencing) stores' arrays. */
const isVirtual = (meta) => (meta.codecs ?? []).some((c) => c.name === "gribberish");

/**
 * Why a variable can't be drawn, from metadata alone, or null.
 * @param {Record<string, any> | null} meta
 */
export function unsupportedReason(meta) {
  if (!meta || meta.node_type !== "array") return "not found in the store";
  if (!NUMERIC.test(meta.data_type)) return `unsupported data type ${meta.data_type}`;
  try {
    layoutOf(meta);
  } catch (e) {
    return /not the last two/.test(e.message) ? "map dimensions are not the last two" : "no map dimensions";
  }
  const names = [];
  const walk = (codecs) => {
    for (const c of codecs ?? []) {
      names.push(c.name);
      if (c.name === "sharding_indexed") walk(c.configuration?.codecs);
    }
  };
  walk(meta.codecs);
  const missing = names.filter((n) => !canDecode(n));
  if (missing.length) return `no browser decoder for ${missing.join(", ")}`;
  return null;
}

/**
 * Per-product reader with caches shared across variables (coordinates and
 * grids are the same for every variable in a group).
 * @param {import("./store.js").Store} store
 * @param {{ proj4?: string | null }} config
 */
export function makeSource(store, config) {
  const coords = new Map();
  const grids = new Map();

  /** A 1-D coordinate array next to the variable, else at the root. */
  async function coord(group, name) {
    for (const path of [`${group}/${name}`, `/${name}`]) {
      if (coords.has(path)) return coords.get(path);
      const meta = await store.getMeta(path);
      if (!meta || meta.node_type !== "array") continue;
      // A failed read is not cached, so Retry fetches it again.
      return cachedPromise(coords, path, () =>
        store.open(path).then(async (arr) => ({
          values: Array.from((await zarr.get(arr)).data, Number),
          attrs: /** @type {Record<string, any>} */ (arr.attrs),
        })),
      );
    }
    return null;
  }

  async function gridMapping(group, attrs) {
    const name = typeof attrs.grid_mapping === "string" ? attrs.grid_mapping.split(/\s|:/)[0] : "spatial_ref";
    for (const path of [`${group}/${name}`, `/${name}`]) {
      const meta = await store.getMeta(path);
      if (meta) return meta.attributes ?? {};
    }
    return null;
  }

  async function grid(group, attrs, [yName, xName]) {
    const key = `${group}|${yName}|${xName}`;
    return cachedPromise(grids, key, async () => {
      const [y, x, gm] = await Promise.all([coord(group, yName), coord(group, xName), gridMapping(group, attrs)]);
      if (!y || !x) throw new Error(`Missing ${!y ? yName : xName} coordinate`);
      const g = buildGrid({ yName, xName, y: y.values, x: x.values, gridMapping: gm, proj4: config.proj4 ?? null });
      return { ...g, def: projectionDef(g.crs) };
    });
  }

  /** Pinned and selectable dims, each with labels from its coordinate (metadata only). */
  async function pinnedDims(group, meta, cls) {
    const dimNames = meta.dimension_names;
    const out = [];
    for (const name of [cls.member, ...cls.extras].filter(Boolean)) {
      const c = (await coord(group, name)) ?? { values: Array.from({ length: meta.shape[dimNames.indexOf(name)] }, (_, i) => i), attrs: {} };
      out.push({
        name,
        select: name !== cls.member,
        values: c.values,
        labels: c.values.map((v) => dimLabel(name, v, c.attrs.units)),
      });
    }
    return out;
  }

  const controlsCache = new Map();
  /**
   * What a variable's controls need (its level selects and slider) from metadata and
   * coordinates alone: no probe, no weather data. Used while the map is unloaded.
   * @param {string} path
   */
  function controls(path) {
    return cachedPromise(controlsCache, path, async () => {
      const meta = await store.getMeta(path);
      const reason = unsupportedReason(meta);
      if (reason) throw new Error(reason);
      const { cls } = layoutOf(meta);
      const pinned = await pinnedDims(parentOf(path), meta, cls);
      const step = cls.step ? { name: cls.step, kind: cls.stepKind, n: meta.shape[meta.dimension_names.indexOf(cls.step)] } : null;
      return { path, pinned, step };
    });
  }

  /**
   * @param {string} path
   * @param {{ center: [number, number], signal?: AbortSignal }} opts
   */
  async function describe(path, { center }) {
    const meta = await store.getMeta(path);
    const reason = unsupportedReason(meta);
    if (reason) throw new Error(reason);
    const dimNames = /** @type {string[]} */ (meta.dimension_names);
    const attrs = meta.attributes ?? {};
    const group = parentOf(path);
    const { cls, spatialIdx, wholeGrid } = layoutOf(meta);
    const [g, arr] = await Promise.all([grid(group, attrs, cls.spatial), store.open(path)]);
    const [cy, cx] = [Math.floor(g.y.n / 2), Math.floor(g.x.n / 2)];
    const d = (name) => dimNames.indexOf(name);
    const virtual = isVirtual(meta);

    // What ZarrLayer and the tile code read. Whole-grid chunks go through the tile
    // facade: small tiles (facadeTile), (y, x) last, and each real chunk read once
    // through its LRU. Everything else reads the array as stored.
    const reorder = spatialIdx[0] !== dimNames.length - 2;
    const tileSize = facadeTile(g);
    const facade =
      wholeGrid && (reorder || g.y.n > tileSize || g.x.n > tileSize)
        ? createTileFacade({ array: arr, get: zarr.get, spatial: spatialIdx, tileSize, keyPrefix: `${store.snapshotId}|${path}` })
        : null;
    const node = facade ? facade.view : arr;
    const nodeDims = facade ? facade.view.dimensionNames : dimNames;

    // Virtual stores: a chunk exists when a 1-byte read of its GRIB message returns a
    // byte (an unwritten chunk has no reference, so icechunk-js returns nothing). A read
    // that fails throws: that's a failed probe, not a missing chunk (see latestWithChunk).
    const sep = meta.chunk_key_encoding?.configuration?.separator ?? "/";
    const hasChunk = async (at) => {
      const coords = dimNames.map((name, i) => (i === spatialIdx[0] || i === spatialIdx[1] ? 0 : (at[name] ?? 0)));
      const key = `${absolutePath(path)}/c${sep}${coords.join(sep)}`;
      const b = await store.store.getRange(/** @type {any} */ (key), { offset: 0, length: 1 });
      return Boolean(b && b.length === 1);
    };
    const probeFailed = (dim, r) =>
      new Error(`Could not check for the latest ${dim}: the upstream probe failed (${r.log.join("; ")})`);

    const pinned = await pinnedDims(group, meta, cls);

    const probe = (probeDim, at) =>
      probeLatest({
        getRange: (key, range) => store.store.getRange(/** @type {any} */ (key), range),
        path,
        meta,
        dimNames,
        probeDim,
        at: { [cls.spatial[0]]: cy, [cls.spatial[1]]: cx, ...at },
      });

    let init = null;
    if (cls.init) {
      const c = await coord(group, cls.init);
      if (!c) throw new Error(`Missing ${cls.init} coordinate`);
      // Virtual: the newest run whose final lead exists (so the whole slider has data),
      // walking back at most 8 runs. Materialized: the shard-index probe at lead 0.
      const lastLead = cls.step ? { [cls.step]: meta.shape[d(cls.step)] - 1 } : {};
      const r = virtual
        ? await latestWithChunk({ n: meta.shape[d(cls.init)], label: cls.init, has: (i) => hasChunk({ ...lastLead, [cls.init]: i }) })
        : await probe(cls.init, cls.step ? { [cls.step]: 0 } : {});
      if (r.index === null && r.failed) throw probeFailed(cls.init, r);
      if (r.index === null) throw new Error(`No run with data in the last ${r.log.length} ${cls.init} values (${r.log.join("; ")})`);
      init = { name: cls.init, times: decodeCf(c.values, c.attrs.units), index: r.index, log: r.log };
    }

    let step = null;
    if (cls.step) {
      const c = await coord(group, cls.step);
      if (!c) throw new Error(`Missing ${cls.step} coordinate`);
      const ms = decodeCf(c.values, c.attrs.units);
      let index = 0;
      let log = [];
      let noData = false;
      if (cls.stepKind === "time") {
        const r = virtual
          ? await latestWithChunk({ n: ms.length, label: cls.step, has: (i) => hasChunk({ [cls.step]: i }) })
          : await probe(cls.step, {});
        log = r.log;
        if (r.index === null && r.failed) throw probeFailed(cls.step, r);
        if (r.index === null) noData = true;
        index = r.index ?? ms.length - 1;
      }
      step = { name: cls.step, kind: cls.stepKind, ms, n: ms.length, chunk: arr.chunks[d(cls.step)], index, log, noData };
    }

    const scale = Number(attrs.scale_factor ?? 1);
    const offset = Number(attrs.add_offset ?? 0);
    return {
      path,
      arr,
      dimNames,
      /** ZarrLayer's `node`, its dim order, and a zarr.get-compatible reader for it. */
      node,
      nodeDims,
      read: facade ? facade.get : zarr.get,
      facade,
      virtual,
      cls,
      grid: g,
      attrs,
      units: attrs.units ?? "",
      missing: missingSentinels(attrs, meta.fill_value),
      scale,
      offset,
      init,
      step,
      pinned,
      tile: { h: node.chunks[node.chunks.length - 2], w: node.chunks[node.chunks.length - 1] },
      centerCell: lonLatToCell(g, center),
    };
  }

  return { describe, controls };
}

/** @typedef {Awaited<ReturnType<ReturnType<typeof makeSource>["describe"]>>} VariableInfo */
