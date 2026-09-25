// Everything the explorer knows about one variable, read from the store:
// dims, grid, coordinates, the latest usable run or time, and missing-value
// handling. Each variable is described from scratch (nothing carries over from
// the previously selected one).
import * as zarr from "zarrita";
import { canDecode } from "./codecs.js";
import { lonLatToCell, projectionDef } from "./crs.js";
import { missingSentinels } from "./lib/colour.js";
import { classifyDims, dimLabel, probeLatest } from "./lib/dims.js";
import { buildGrid } from "./lib/grid.js";
import { decodeCf } from "./lib/time.js";

const NUMERIC = /^(u?int(8|16|32|64)|float(16|32|64))$/;

/** Parent group path of an array path: "/a/b" → "/a", "/b" → "". */
const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));

/**
 * Why a variable can't be drawn, from metadata alone, or null.
 * @param {Record<string, any> | null} meta
 */
export function unsupportedReason(meta) {
  if (!meta || meta.node_type !== "array") return "not found in the store";
  if (!NUMERIC.test(meta.data_type)) return `unsupported data type ${meta.data_type}`;
  try {
    classifyDims(meta.dimension_names ?? []);
  } catch {
    return "no map dimensions";
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
      const p = store.open(path).then(async (arr) => ({
        values: Array.from((await zarr.get(arr)).data, Number),
        attrs: /** @type {Record<string, any>} */ (arr.attrs),
      }));
      coords.set(path, p);
      return p;
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
    if (!grids.has(key)) {
      grids.set(
        key,
        (async () => {
          const [y, x, gm] = await Promise.all([coord(group, yName), coord(group, xName), gridMapping(group, attrs)]);
          if (!y || !x) throw new Error(`Missing ${!y ? yName : xName} coordinate`);
          const g = buildGrid({ yName, xName, y: y.values, x: x.values, gridMapping: gm, proj4: config.proj4 ?? null });
          return { ...g, def: projectionDef(g.crs) };
        })(),
      );
    }
    return grids.get(key);
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
    const cls = classifyDims(dimNames);
    const [g, arr] = await Promise.all([grid(group, attrs, cls.spatial), store.open(path)]);
    const [cy, cx] = [Math.floor(g.y.n / 2), Math.floor(g.x.n / 2)];
    const d = (name) => dimNames.indexOf(name);

    const coordOf = async (name) => {
      const c = await coord(group, name);
      return c ?? { values: Array.from({ length: meta.shape[d(name)] }, (_, i) => i), attrs: {} };
    };

    // Pinned and selectable dims, each with labels from its coordinate.
    const pinned = [];
    for (const name of [cls.member, ...cls.extras].filter(Boolean)) {
      const c = await coordOf(name);
      pinned.push({
        name,
        select: name !== cls.member,
        values: c.values,
        labels: c.values.map((v) => dimLabel(name, v, c.attrs.units)),
      });
    }

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
      const r = await probe(cls.init, cls.step ? { [cls.step]: 0 } : {});
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
        const r = await probe(cls.step, {});
        log = r.log;
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
      tile: { h: arr.chunks[arr.chunks.length - 2], w: arr.chunks[arr.chunks.length - 1] },
      centerCell: lonLatToCell(g, center),
    };
  }

  return { describe };
}

/** @typedef {Awaited<ReturnType<ReturnType<typeof makeSource>["describe"]>>} VariableInfo */
