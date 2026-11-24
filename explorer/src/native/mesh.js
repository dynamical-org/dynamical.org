// Native face chunks need a tighter spatial filter than their bounding boxes:
// ICON's chunk order interleaves long strips of faces. Each half-degree bin
// records the chunks with a face touching it, a conservative cover that keeps
// the index small without skipping a face crossing a bin edge.
const BINS_PER_DEGREE = 2;
const lonBin = (lon) => Math.floor((lon + 180) * BINS_PER_DEGREE);
const latBin = (lat) => Math.floor((lat + 90) * BINS_PER_DEGREE);
const ROW = 360 * BINS_PER_DEGREE + 1;

/**
 * @param {ArrayLike<number>} lon
 * @param {ArrayLike<number>} lat
 * @param {ArrayLike<number>} faces Three node indices per face, in cell order.
 * @param {number} chunkLength
 * @param {number} [startIndex] UGRID node index origin.
 */
export function makeMesh(lon, lat, faces, chunkLength, startIndex = 0) {
  const count = faces.length / 3;
  const chunks = Math.ceil(count / chunkLength);
  /** @type {Map<number, Set<number>>} */
  const bins = new Map();
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] - startIndex, b = faces[i + 1] - startIndex, c = faces[i + 2] - startIndex;
    const w = lonBin(Math.min(lon[a], lon[b], lon[c])), e = lonBin(Math.max(lon[a], lon[b], lon[c]));
    const s = latBin(Math.min(lat[a], lat[b], lat[c])), n = latBin(Math.max(lat[a], lat[b], lat[c]));
    if (!(w >= 0 && e < ROW && s >= 0 && n <= 360 && e - w < ROW / 2)) {
      throw new Error("Native mesh has invalid nodes or faces crossing the antimeridian");
    }
    west = Math.min(west, w); east = Math.max(east, e);
    south = Math.min(south, s); north = Math.max(north, n);
    const chunk = Math.floor(i / (3 * chunkLength));
    for (let y = s; y <= n; y++) for (let x = w; x <= e; x++) {
      const key = y * ROW + x;
      let bin = bins.get(key);
      if (!bin) bins.set(key, bin = new Set());
      bin.add(chunk);
    }
  }

  return {
    count,
    chunks,
    /** @param {number[]} bounds west, south, east, north */
    visible(bounds) {
      const [w, s, e, n] = bounds;
      const ids = new Set();
      for (let y = Math.max(south, latBin(s)); y <= Math.min(north, latBin(n)); y++) {
        for (let x = Math.max(west, lonBin(w)); x <= Math.min(east, lonBin(e)); x++) {
          for (const id of bins.get(y * ROW + x) ?? []) ids.add(id);
        }
      }
      return [...ids].sort((a, b) => a - b);
    },
    /** @param {number} chunk */
    positions(chunk) {
      const start = chunk * chunkLength * 3;
      const end = Math.min(faces.length, start + chunkLength * 3);
      const positions = new Float32Array((end - start) * 2);
      for (let i = start, j = 0; i < end; i++, j += 2) {
        const node = faces[i] - startIndex;
        positions[j] = lon[node];
        positions[j + 1] = lat[node];
      }
      return positions;
    },
    /** @param {[number, number]} center */
    nearestChunk([x, y]) {
      const cos = Math.cos(y * Math.PI / 180);
      let best = Infinity, face = 0;
      for (let i = 0; i < faces.length; i += 3) {
        const a = faces[i] - startIndex, b = faces[i + 1] - startIndex, c = faces[i + 2] - startIndex;
        const dx = ((lon[a] + lon[b] + lon[c]) / 3 - x) * cos;
        const dy = (lat[a] + lat[b] + lat[c]) / 3 - y;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; face = i / 3; }
      }
      return Math.floor(face / chunkLength);
    },
  };
}
