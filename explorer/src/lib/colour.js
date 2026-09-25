// Values → Float32 for r32float textures, and the colour range. Pure.

/** Fixed range for recognisably Celsius units. */
export const CELSIUS_RANGE = [-40, 50];

export function isCelsius(units) {
  return /^(degree_?C|degrees?_Celsius|degC|°C|celsius)$/i.test(String(units ?? "").trim());
}

/**
 * Decode an xarray `_FillValue` attribute: a number, or base64 of a
 * little-endian float64 (how xarray writes NaN/inf fill values to zarr v3).
 * @returns {number | null}
 */
export function decodeFillAttr(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  if (v === "NaN") return NaN;
  try {
    const bin = atob(v);
    if (bin.length !== 8) return null;
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = bin.charCodeAt(i);
    return new DataView(b.buffer).getFloat64(0, true);
  } catch {
    return null;
  }
}

/**
 * The finite sentinels that mean "missing" for a variable: `_FillValue` and
 * `missing_value` attributes, else the zarr `fill_value` when it is finite.
 * NaN is always missing and needs no entry.
 * @param {Record<string, any>} attrs
 * @param {unknown} zarrFill
 * @returns {number[]}
 */
export function missingSentinels(attrs, zarrFill) {
  const out = [];
  const add = (v) => {
    const n = decodeFillAttr(v);
    if (n !== null && Number.isFinite(n) && !out.includes(n)) out.push(n);
  };
  if ("_FillValue" in attrs) add(attrs._FillValue);
  else add(typeof zarrFill === "string" ? zarrFill : Number(zarrFill));
  for (const v of [].concat(attrs.missing_value ?? [])) add(v);
  return out;
}

/**
 * Convert decoded zarr data of any numeric dtype to Float32, turning missing
 * sentinels into NaN and applying CF scale_factor/add_offset.
 * @param {ArrayLike<number | bigint>} data
 * @param {{ missing?: number[], scale?: number, offset?: number }} [opts]
 * @returns {Float32Array}
 */
export function toFloat32(data, { missing = [], scale = 1, offset = 0 } = {}) {
  const plain = data instanceof Float32Array && missing.length === 0 && scale === 1 && offset === 0;
  if (plain) return data;
  const out = new Float32Array(data.length);
  const one = missing.length === 1 ? missing[0] : undefined;
  for (let i = 0; i < data.length; i++) {
    const raw = typeof data[i] === "bigint" ? Number(data[i]) : /** @type {number} */ (data[i]);
    const miss = one !== undefined ? raw === one : missing.length > 0 && missing.includes(raw);
    out[i] = miss ? NaN : raw * scale + offset;
  }
  return out;
}

/**
 * 2nd–98th percentile of the finite values in `data`, from at most
 * `maxSamples` values taken at a fixed stride (deterministic, no full sort).
 * @param {ArrayLike<number>} data
 * @returns {{ min: number, max: number, status: "ok" | "flat" | "empty", samples: number }}
 */
export function sampleRange(data, { maxSamples = 100_000, lo = 0.02, hi = 0.98 } = {}) {
  const stride = Math.max(1, Math.ceil(data.length / maxSamples));
  const s = [];
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (Number.isFinite(v)) s.push(v);
  }
  if (s.length === 0) return { min: 0, max: 1, status: "empty", samples: 0 };
  const sorted = Float64Array.from(s).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  let min = q(lo);
  let max = q(hi);
  if (!(max > min)) {
    // All equal (e.g. all-zero precipitation): widen around the value so the
    // legend still reads sensibly and the one value maps to the colormap's low end.
    const pad = Math.abs(min) * 0.1 || 1;
    return { min, max: min + pad, status: "flat", samples: s.length };
  }
  return { min, max, status: "ok", samples: s.length };
}

/** Round legend tick values to a few significant figures. */
export function formatValue(v) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2);
  return String(Number(v.toPrecision(3)));
}

/**
 * The colour range for a variable from its first sample. Celsius gets the fixed range.
 * A sample that is empty or one value (e.g. all-zero precipitation) gives a provisional
 * range: shown, but not frozen, so a later sample can replace it (see settleRange).
 * @param {string} units
 * @param {ArrayLike<number>} data
 * @returns {{ min: number, max: number, kind: "fixed" | "sample", status?: string, provisional?: boolean }}
 */
export function initialRange(units, data) {
  if (isCelsius(units)) return { min: CELSIUS_RANGE[0], max: CELSIUS_RANGE[1], kind: "fixed" };
  const r = sampleRange(data);
  return r.status === "ok" ? { ...r, kind: "sample" } : { ...r, kind: "sample", provisional: true };
}

/**
 * A provisional range replaced by the first sample that varies, else null (keep the
 * current range). Frozen ranges are never replaced.
 * @param {{ provisional?: boolean } | null} current
 * @param {ArrayLike<number>} data a newly loaded tile block
 */
export function settleRange(current, data) {
  if (!current?.provisional) return null;
  const r = sampleRange(data);
  return r.status === "ok" ? { ...r, kind: "sample" } : null;
}
