// Non-spatial dimensions: which one the slider drives, which are pinned, which
// get a select; the slider's texture blocks; and the latest-run probe that
// reads only a shard index. Pure: the probe takes its range reader as an
// argument so tests can feed it bytes.

/** "temperature_2m", "/temperature_2m" or "//a/b/" → "/temperature_2m", "/a/b". */
export function absolutePath(path) {
  return `/${String(path).replace(/^\/+|\/+$/g, "")}`;
}

const Y_NAMES = new Set(["latitude", "lat", "y"]);
const X_NAMES = new Set(["longitude", "lon", "x"]);

/**
 * The spatial dims are the last two, (y, x), which is also what ZarrLayer
 * requires.
 * @param {string[]} dimNames
 * @returns {[string, string]}
 */
export function spatialDims(dimNames) {
  const [y, x] = dimNames.slice(-2);
  if (dimNames.length < 2 || !Y_NAMES.has(String(y).toLowerCase()) || !X_NAMES.has(String(x).toLowerCase())) {
    throw new Error(`No (latitude, longitude) or (y, x) as the last two dimensions (got ${JSON.stringify(dimNames)})`);
  }
  return [y, x];
}

/**
 * Classify a variable's non-spatial dims.
 * - init_time: pinned to the latest usable run (see probeLatest)
 * - lead_time, else time: the slider
 * - ensemble_member: pinned (index 0 by default)
 * - anything else: its own select
 * @param {string[]} dimNames
 * @returns {{ init: string|null, step: string|null, stepKind: "lead"|"time"|null, member: string|null, extras: string[], spatial: [string, string] }}
 */
export function classifyDims(dimNames) {
  const spatial = spatialDims(dimNames);
  const rest = dimNames.slice(0, -2);
  const out = { init: null, step: null, stepKind: null, member: null, extras: [], spatial };
  for (const d of rest) {
    if (d === "init_time") out.init = d;
    else if (d === "lead_time") {
      out.step = d;
      out.stepKind = "lead";
    } else if (d === "ensemble_member") out.member = d;
    else out.extras.push(d);
  }
  if (!out.step && out.extras.includes("time")) {
    out.extras = out.extras.filter((d) => d !== "time");
    out.step = "time";
    out.stepKind = "time";
  }
  return out;
}

/** A pinned or selected dim's label from its coordinate value, e.g. "member 0", "500 hPa". */
export function dimLabel(dim, value, units) {
  if (dim === "ensemble_member") return `member ${value}`;
  const u = units && units !== "1" ? ` ${units}` : "";
  return `${value}${u}`;
}

/**
 * The block of slider steps uploaded as one texture array: never more than the
 * texture window, never across an inner-chunk boundary (a block that straddled
 * two chunks would decode both).
 * @param {number} index selected step
 * @param {number} chunkLen inner-chunk extent along the slider dim
 * @param {number} window max texture layers
 * @param {number} n dim length
 * @returns {{ start: number, stop: number }}
 */
export function blockRange(index, chunkLen, window, n) {
  const w = Math.max(1, Math.min(chunkLen, window));
  const c0 = Math.floor(index / chunkLen) * chunkLen;
  const cEnd = Math.min(c0 + chunkLen, n);
  const start = c0 + Math.floor((index - c0) / w) * w;
  return { start, stop: Math.min(start + w, cEnd) };
}

/**
 * The first (or last) step of a decoded block, laid out step-major, with any
 * finite value; -1 when the whole block is missing.
 * @param {ArrayLike<number>} data
 * @param {number} depth steps in the block
 * @param {"first" | "last"} prefer
 */
export function stepWithData(data, depth, prefer) {
  const size = data.length / depth;
  for (let n = 0; n < depth; n++) {
    const k = prefer === "first" ? n : depth - 1 - n;
    for (let i = k * size; i < (k + 1) * size; i++) if (Number.isFinite(data[i])) return k;
  }
  return -1;
}

/**
 * Newest-first candidate indices for the latest-data probe: the last index,
 * then the last index of each earlier inner chunk, at most `max` of them.
 */
export function probeCandidates(n, chunkLen, max = 4) {
  const out = [];
  for (let i = n - 1; i >= 0 && out.length < max; i = Math.floor(i / chunkLen) * chunkLen - 1) out.push(i);
  return out;
}

/**
 * Validate a zarr v3 array's sharding layout for the shard-index probe and
 * return what the probe needs. Returns null for unsharded arrays (nothing to
 * probe cheaply). Throws on any layout the probe can't read correctly.
 * @param {Record<string, any>} meta zarr.json of the array
 */
export function shardLayout(meta) {
  const codecs = meta.codecs ?? [];
  const sharding = codecs.find((c) => c.name === "sharding_indexed");
  if (!sharding) return null;
  if (codecs.length !== 1) {
    throw new Error(`Shard probe: expected sharding_indexed as the only codec, got ${codecs.map((c) => c.name).join(", ")}`);
  }
  const cfg = sharding.configuration;
  const idx = cfg.index_codecs ?? [];
  const bytesOk = idx[0]?.name === "bytes" && (idx[0].configuration?.endian ?? "little") === "little";
  const rest = idx.slice(1).map((c) => c.name);
  if (!bytesOk || !(rest.length === 0 || (rest.length === 1 && rest[0] === "crc32c"))) {
    throw new Error(`Shard probe: unsupported shard index codecs ${JSON.stringify(idx.map((c) => c.name))}`);
  }
  const location = cfg.index_location ?? "end";
  if (location !== "end" && location !== "start") throw new Error(`Shard probe: unknown index_location "${location}"`);
  const enc = meta.chunk_key_encoding ?? { name: "default" };
  if (enc.name !== "default") throw new Error(`Shard probe: unsupported chunk key encoding "${enc.name}"`);
  const shardShape = meta.chunk_grid.configuration.chunk_shape;
  const innerShape = cfg.chunk_shape;
  if (shardShape.length !== innerShape.length || shardShape.some((s, i) => s % innerShape[i] !== 0)) {
    throw new Error(`Shard probe: shard ${JSON.stringify(shardShape)} is not a multiple of inner ${JSON.stringify(innerShape)}`);
  }
  const perShard = shardShape.map((s, i) => s / innerShape[i]);
  const nInner = perShard.reduce((a, b) => a * b, 1);
  return {
    shardShape,
    innerShape,
    perShard,
    nInner,
    location,
    separator: enc.configuration?.separator ?? "/",
    indexBytes: nInner * 16 + (rest.length ? 4 : 0),
  };
}

/**
 * The shard key and the index entry (C-order over the inner grid) holding the
 * inner chunk that contains `coords`.
 * @param {string} path array path, e.g. "/temperature_2m"
 * @param {number[]} coords one array index per dim
 * @param {ReturnType<typeof shardLayout> & {}} layout
 */
export function locateInner(path, coords, layout) {
  const shard = coords.map((c, i) => Math.floor(c / layout.shardShape[i]));
  const inner = coords.map((c, i) => Math.floor((c % layout.shardShape[i]) / layout.innerShape[i]));
  let entry = 0;
  for (let i = 0; i < inner.length; i++) entry = entry * layout.perShard[i] + inner[i];
  const sep = layout.separator;
  // Stores take absolute keys: icechunk-js returns nothing for "temperature_2m/c/…".
  return { key: `${absolutePath(path)}/c${sep}${shard.join(sep)}`, entry };
}

const EMPTY = 0xffffffffffffffffn;

/**
 * Read one entry of a shard index. An inner chunk that was never written has
 * offset = nbytes = 2^64-1.
 * @param {Uint8Array} bytes the index (with its crc32c, if any)
 * @param {number} entry
 * @param {{ indexBytes: number, nInner: number }} layout
 */
export function decodeIndexEntry(bytes, entry, layout) {
  if (bytes.byteLength !== layout.indexBytes) {
    throw new Error(`Shard probe: index is ${bytes.byteLength} B, expected ${layout.indexBytes} B`);
  }
  if (entry < 0 || entry >= layout.nInner) throw new Error(`Shard probe: entry ${entry} out of range`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = dv.getBigUint64(entry * 16, true);
  const nbytes = dv.getBigUint64(entry * 16 + 8, true);
  const present = !(offset === EMPTY && nbytes === EMPTY);
  return { present, offset: present ? Number(offset) : null, nbytes: present ? Number(nbytes) : null };
}

/**
 * Find the newest index along `probeDim` whose inner chunk at `at` is written,
 * reading only shard indexes (a few KB each, at most `max` of them).
 *
 * "Present" means that chunk exists, not that the run or time step is complete.
 *
 * @param {{
 *   getRange: (key: string, range: { suffixLength: number } | { offset: number, length: number }) => Promise<Uint8Array | undefined>,
 *   path: string,
 *   meta: Record<string, any>,
 *   dimNames: string[],
 *   probeDim: string,
 *   at: Record<string, number>,
 *   max?: number,
 * }} args `at` gives the index of every other dim (spatial included)
 * @returns {Promise<{ index: number | null, probed: boolean, log: string[] }>}
 */
export async function probeLatest({ getRange, path, meta, dimNames, probeDim, at, max = 4 }) {
  const d = dimNames.indexOf(probeDim);
  const n = meta.shape[d];
  const layout = shardLayout(meta);
  if (!layout) return { index: n - 1, probed: false, log: [`${path}: not sharded, using the last ${probeDim} unprobed`] };
  const log = [];
  for (const i of probeCandidates(n, layout.innerShape[d], max)) {
    const coords = dimNames.map((name) => (name === probeDim ? i : (at[name] ?? 0)));
    const { key, entry } = locateInner(path, coords, layout);
    const range =
      layout.location === "end" ? { suffixLength: layout.indexBytes } : { offset: 0, length: layout.indexBytes };
    const bytes = await getRange(key, range);
    if (!bytes) {
      log.push(`${probeDim}[${i}]: shard ${key} missing`);
      continue;
    }
    const e = decodeIndexEntry(bytes, entry, layout);
    log.push(`${probeDim}[${i}]: ${e.present ? `chunk present (${e.nbytes} B)` : "chunk empty"}`);
    if (e.present) return { index: i, probed: true, log };
  }
  return { index: null, probed: true, log };
}
