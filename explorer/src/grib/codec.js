// zarrita codec for dynamical.org's "gribberish" array->bytes codec, used by the virtual
// Icechunk stores: every chunk is one complete GRIB2 message (a byte range of a NOAA or
// ECMWF file). Decoding runs gribberish (Rust, MIT) compiled to wasm32-unknown-unknown with
// wasm-bindgen (see explorer/gribwasm/): single-threaded, no SharedArrayBuffer, so the page
// needs no COOP/COEP headers. It covers GRIB2 data representation templates 5.0, 5.2, 5.3,
// 5.41 and 5.42 (CCSDS, pure Rust); 5.40 (JPEG 2000) is not built in and no store uses it.
//
// It mirrors gribberish's Python codec (gribberish/zarr/codec.py):
// parse_grib_array(bytes, 0, adjust_longitude_range, north_up), cast to the array's dtype,
// reshape to the chunk shape. "scale_offset", which the stores chain in front of it, needs
// no registration: zarrita ships it (decode = value / scale + offset).
//
// The module has no zarrita import, so offline tests can load it; the caller passes the
// registry in. The wasm-bindgen glue is imported dynamically: Vite's library mode inlines the
// wasm into the glue's chunk as base64 (as it does numcodecs' blosc/zstd), so the decoder
// stays out of the entry chunk and is fetched only when a virtual array is first read.

/**
 * @typedef {object} GribberishConfig
 * @property {string} [var] GRIB variable abbreviation, e.g. "TMP". Informational only;
 *   "latitude"/"longitude" (the Python codec's coordinate mode) are not supported.
 * @property {boolean} [adjust_longitude_range] Roll global 0..360 grids to -180..180.
 * @property {boolean} [north_up] Put the northern-most row first.
 */

/**
 * @typedef {object} ChunkMeta
 * @property {string} dataType zarr data type of the array ("float64" or "float32").
 * @property {number[]} shape Chunk shape.
 */

/** @typedef {{ data: Float64Array | Float32Array, shape: number[], stride: number[] }} Chunk */

/** @type {Promise<unknown> | null} */
let ready = null;
/** @type {typeof import("./gribwasm.js") | null} The glue, once initialised. */
let glue = null;

/** Running totals, for status lines and benchmarks. */
export const gribStats = { decodes: 0, decodeMs: 0, initMs: 0 };

/**
 * Load the decoder once. Later calls return the first call's promise, whatever they pass.
 *
 * @param {URL | string | BufferSource | Response | WebAssembly.Module} [source]
 *   Where the wasm comes from. Omitted, the glue's own default is used: gribwasm_bg.wasm
 *   beside it, which the bundle inlines. Tests under Node pass the file's bytes instead.
 * @returns {Promise<unknown>}
 */
export function initGrib(source) {
  if (!ready) {
    const t0 = performance.now();
    ready = import("./gribwasm.js")
      .then(async (m) => {
        await m.default(source === undefined ? undefined : { module_or_path: source });
        glue = m;
        gribStats.initMs = performance.now() - t0;
      })
      .catch((e) => {
        ready = null; // let a later call retry, e.g. after a network error
        throw e;
      });
  }
  return ready;
}

/** @param {number[]} shape */
function cStrides(shape) {
  const out = new Array(shape.length);
  for (let i = shape.length - 1, acc = 1; i >= 0; i--) {
    out[i] = acc;
    acc *= shape[i];
  }
  return out;
}

/**
 * GRIB2 data representation template number (section 5) of a message, e.g. 3 or 42.
 * Requires initGrib() to have resolved.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function drsTemplate(bytes) {
  if (!glue) throw new Error("gribberish codec: call initGrib() first");
  return glue.drs_template(bytes);
}

export class GribberishCodec {
  kind = "array_to_bytes";

  /**
   * @param {GribberishConfig} config
   * @param {ChunkMeta} meta
   */
  constructor(config, meta) {
    if (meta.dataType !== "float64" && meta.dataType !== "float32") {
      throw new Error(`gribberish codec: unsupported data type ${meta.dataType}`);
    }
    if (config.var === "latitude" || config.var === "longitude") {
      throw new Error(`gribberish codec: var=${config.var} (coordinate decoding) is not supported`);
    }
    this.adjustLongitudeRange = Boolean(config.adjust_longitude_range);
    this.northUp = Boolean(config.north_up);
    this.meta = meta;
  }

  /**
   * zarrita's codec factory hook.
   *
   * @param {GribberishConfig | undefined} config
   * @param {ChunkMeta} meta
   */
  static fromConfig(config, meta) {
    return new GribberishCodec(config ?? {}, meta);
  }

  /**
   * @param {Uint8Array} bytes One GRIB2 message.
   * @returns {Promise<Chunk>}
   */
  async decode(bytes) {
    await initGrib();
    const t0 = performance.now();
    const values = glue.decode(bytes, this.adjustLongitudeRange, this.northUp);
    gribStats.decodes++;
    gribStats.decodeMs += performance.now() - t0;
    const shape = this.meta.shape;
    const n = shape.reduce((a, b) => a * b, 1);
    if (values.length !== n) {
      throw new Error(`gribberish codec: message has ${values.length} points, chunk shape [${shape}] needs ${n}`);
    }
    const data = this.meta.dataType === "float64" ? values : Float32Array.from(values);
    return { data, shape: shape.slice(), stride: cStrides(shape) };
  }

  encode() {
    throw new Error("gribberish codec is read-only");
  }
}

/**
 * Register "gribberish" in a zarrita codec registry (`import { registry } from "zarrita"`).
 * The wasm loads on first use, i.e. when the first virtual array is opened for reading.
 *
 * @param {Map<string, () => unknown>} registry
 * @param {{ wasm?: URL | string | BufferSource | Response | WebAssembly.Module }} [options]
 */
export function registerGribberish(registry, { wasm } = {}) {
  registry.set("gribberish", async () => {
    await initGrib(wasm);
    return GribberishCodec;
  });
}
