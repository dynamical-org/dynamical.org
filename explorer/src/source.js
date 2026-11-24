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
import { absolutePath, coordinateValues, defaultIndex, dimLabel, latestWithChunk, layoutOf, probeLatest } from "./lib/dims.js";
import { buildGrid } from "./lib/grid.js";
import { decodeCf } from "./lib/time.js";
import { makeMesh } from "./native/mesh.js";
import { paddedReader } from "./native/read.js";

const NUMERIC = /^(u?int(8|16|32|64)|float(16|32|64))$/;

/** Parent group path of an array path: "/a/b" → "/a", "/b" → "". */
const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));
const relativeTo = (path, ref) => ref.startsWith("/") ? ref : `${parentOf(path)}/${ref}`;

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
  const topologies = new Map();
  const meshes = new Map();

  async function topology(path) {
    return cachedPromise(topologies, path, async () => {
      const attrs = (await store.getMeta(path))?.attributes;
      const nodes = attrs?.node_coordinates?.trim().split(/\s+/) ?? [];
      if (attrs?.cf_role !== "mesh_topology" || attrs.topology_dimension !== 2 ||
          (attrs.face_dimension ?? "cell") !== "cell" || nodes.length !== 2 || !attrs.face_node_connectivity) {
        throw new Error("Expected a UGRID face mesh with geographic node coordinates");
      }
      const arrays = await Promise.all([...nodes, attrs.face_node_connectivity].map((name) => store.open(relativeTo(path, name))));
      const [a, b, faces] = arrays;
      const lat = [a, b].find((x) => x.attrs.standard_name === "latitude");
      const lon = [a, b].find((x) => x.attrs.standard_name === "longitude");
      if (!lat || !lon || lat.shape.length !== 1 || lon.shape[0] !== lat.shape[0] ||
          lon.shape.length !== 1 || faces.shape.length !== 2 || faces.shape[1] !== 3) {
        throw new Error("Expected triangles with one-dimensional longitude and latitude nodes");
      }
      const values = await Promise.all([lon, lat, faces].map(async (arr) => (await zarr.get(arr)).data));
      return { values, startIndex: Number(faces.attrs.start_index ?? 0) };
    });
  }

  async function nativeMesh(path, length, center) {
    return cachedPromise(meshes, `${path}|${length}|${center.join(",")}`, async () => {
      const { values: [lon, lat, faces], startIndex } = await topology(path);
      const mesh = makeMesh(lon, lat, faces, length, startIndex);
      return { mesh, centerChunk: mesh.nearestChunk(center) };
    });
  }

  /** A 1-D coordinate array next to the variable, else at the root. */
  async function coord(group, name) {
    for (const path of [`${group}/${name}`, `/${name}`]) {
      if (coords.has(path)) return coords.get(path);
      const meta = await store.getMeta(path);
      if (!meta || meta.node_type !== "array") continue;
      // A failed read is not cached, so Retry fetches it again.
      return cachedPromise(coords, path, () =>
        store.open(path).then(async (arr) => ({
          values: coordinateValues((await zarr.get(arr)).data),
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

  /**
   * The selected dims (ensemble member, levels), each with labels from its coordinate
   * values and the index it opens at (metadata only).
   */
  async function pinnedDims(group, meta, cls) {
    const dimNames = meta.dimension_names;
    const out = [];
    for (const name of [cls.member, ...cls.extras].filter(Boolean)) {
      const c = (await coord(group, name)) ?? { values: Array.from({ length: meta.shape[dimNames.indexOf(name)] }, (_, i) => i), attrs: {} };
      out.push({
        name,
        values: c.values,
        labels: c.values.map((v) => dimLabel(name, v, c.attrs.units)),
        default: defaultIndex(name, c.values),
      });
    }
    return out;
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
    const { cls, spatialIdx, wholeGrid, native } = layoutOf(meta);
    const [g, arr] = await Promise.all([native ? null : grid(group, attrs, cls.spatial), store.open(path)]);
    const cellLength = arr.chunks.at(-1);
    const cell = native ? await nativeMesh(relativeTo(path, attrs.mesh), cellLength, center) : null;
    if (cell && cell.mesh.count !== arr.shape.at(-1)) throw new Error("Native mesh face count differs from the cell dimension");
    const d = (name) => dimNames.indexOf(name);
    const virtual = isVirtual(meta);

    // What ZarrLayer and the tile code read. Whole-grid chunks go through the tile
    // facade: small tiles (facadeTile), (y, x) last, and each real chunk read once
    // through its LRU. Everything else reads the array as stored.
    const reorder = spatialIdx[0] !== dimNames.length - 2;
    const tileSize = g ? facadeTile(g) : 0;
    const facade =
      wholeGrid && (reorder || g.y.n > tileSize || g.x.n > tileSize)
        ? createTileFacade({ array: arr, get: zarr.get, spatial: spatialIdx, tileSize, keyPrefix: `${store.snapshotId}|${path}` })
        : null;
    const node = facade ? facade.view : arr;
    const nodeDims = facade ? facade.view.dimensionNames : cell ? [...dimNames.slice(0, -1), ...cls.spatial] : dimNames;

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
    const probeAt = cell ? { cell: 0 } : { [cls.spatial[0]]: Math.floor(g.y.n / 2), [cls.spatial[1]]: Math.floor(g.x.n / 2) };

    const probe = (probeDim, at) =>
      probeLatest({
        getRange: (key, range) => store.store.getRange(/** @type {any} */ (key), range),
        path,
        meta,
        dimNames,
        probeDim,
        at: { ...probeAt, ...at },
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
      // `index` is the run drawn; `default` stays the probed one (the init select always lists it).
      init = { name: cls.init, times: decodeCf(c.values, c.attrs.units), index: r.index, default: r.index, log: r.log };
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
    const missing = missingSentinels(attrs, meta.fill_value);
    const edge = cell ? Math.ceil(Math.sqrt(cellLength)) : 0;
    return {
      path,
      arr,
      dimNames,
      /** ZarrLayer's `node`, its dim order, and a zarr.get-compatible reader for it. */
      node,
      nodeDims,
      read: cell ? paddedReader(zarr.get, cell.mesh.count, cellLength, { missing, scale, offset }) : facade ? facade.get : zarr.get,
      facade,
      native: cell?.mesh,
      virtual,
      cls,
      grid: g,
      attrs,
      units: attrs.units ?? "",
      missing: cell ? [] : missing,
      scale: cell ? 1 : scale,
      offset: cell ? 0 : offset,
      init,
      step,
      pinned,
      tile: cell ? { h: edge, w: edge } : { h: node.chunks.at(-2), w: node.chunks.at(-1) },
      centerCell: cell ? [cell.centerChunk * edge, 0] : lonLatToCell(g, center),
    };
  }

  return { describe };
}

/** @typedef {Awaited<ReturnType<ReturnType<typeof makeSource>["describe"]>>} VariableInfo */
