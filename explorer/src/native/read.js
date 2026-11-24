import { toFloat32 } from "../lib/colour.js";

/** Pad the last (cell) dimension of a contiguous chunk into float texture planes.
 * @param {Function} get zarrita's get, injected for offline tests.
 * @param {number} count Total native faces.
 * @param {number} length Cells in one inner chunk.
 * @param {Parameters<typeof toFloat32>[1]} encoding
 */
export function paddedReader(get, count, length, encoding) {
  const edge = Math.ceil(Math.sqrt(length));
  const plane = edge * edge;
  return async (array, spec, options) => {
    // Tile callbacks key their prefetch by row/column. Each chunk gets its
    // own row interval; only its cell interval goes to the underlying store.
    const start = Math.floor(spec.at(-2).start / edge) * length;
    const stop = Math.min(start + length, count);
    const result = await get(array, [...spec.slice(0, -2), { start, stop, step: 1 }], options);
    const cells = stop - start;
    const native = toFloat32(result.data, encoding);
    const depth = native.length / cells;
    const data = new Float32Array(depth * plane).fill(NaN);
    for (let k = 0; k < depth; k++) data.set(native.subarray(k * cells, (k + 1) * cells), k * plane);
    return { data, shape: [...result.shape.slice(0, -1), edge, edge] };
  };
}
