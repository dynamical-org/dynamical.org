import assert from "node:assert/strict";
import test from "node:test";
import { makeMesh } from "../src/native/mesh.js";
import { paddedReader } from "../src/native/read.js";

// Chunks span the small query box when reduced to a bbox, but only the
// middle chunk's faces enter it. One face also straddles a bin boundary.
const origin = [[-2, 0], [2, 0], [-0.2, 0.2], [0.6, 0.1], [-2, 1], [2, 1], [0.5, -1]];
const triangles = origin.map(([x, y]) => [[x, y], [x + 0.35, y + 0.02], [x + 0.03, y + 0.25]]);
const coords = triangles.flat();
const nodes = Int32Array.from(coords, (_, i) => i + 1);
const mesh = makeMesh(coords.map(([x]) => x), coords.map(([, y]) => y), nodes, 2, 1);

test("interleaved native chunks are selected by their faces, including across bin edges", () => {
  for (const bounds of [[-0.5, 0, 0.49, 0.49], [0, 0, 0.49, 0.49],
    [-2.5, 0, -1.51, 1.49], [0.5, -1, 0.99, -0.51], [-0.5, 2, 1.49, 3.49]]) {
    const [w, s, e, n] = bounds;
    const expected = new Set();
    triangles.forEach((triangle, face) => {
      const [xs, ys] = [triangle.map(([x]) => x), triangle.map(([, y]) => y)];
      if (Math.min(...xs) <= e && Math.max(...xs) >= w && Math.min(...ys) <= n && Math.max(...ys) >= s) {
        expected.add(Math.floor(face / 2));
      }
    });
    assert.deepEqual(mesh.visible(bounds), [...expected], `visible for ${bounds}`);
  }
});

test("the last partial chunk places its face vertices in connectivity order", () => {
  const reversed = Int32Array.from(nodes.slice(0, 9)).reverse();
  const short = makeMesh(coords.map(([x]) => x), coords.map(([, y]) => y), reversed, 2, 1);
  assert.deepEqual(short.positions(0), Float32Array.from(coords.slice(3, 9).reverse().flat()));
  assert.deepEqual(short.positions(1), Float32Array.from(coords.slice(0, 3).reverse().flat()));
});

test("native values respect cell and lead order and pad the partial chunk with NaN", async () => {
  const array = { shape: [2, 3, 7] };
  const read = paddedReader(async (_array, [run, lead, cell]) => {
    const values = [];
    for (let t = lead.start; t < lead.stop; t++) for (let c = cell.start; c < cell.stop; c++) {
      values.push(100 * run + 10 * t + c);
    }
    return { data: Uint16Array.from(values), shape: [lead.stop - lead.start, cell.stop - cell.start] };
  }, 7, 5, { scale: 2, offset: 0, missing: [116] });
  const { data } = await read(array, [1, { start: 1, stop: 3 }, { start: 3, stop: 6 }, { start: 0, stop: 3 }]);
  assert.deepEqual(data, Float32Array.of(230, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN,
    250, 252, NaN, NaN, NaN, NaN, NaN, NaN, NaN));
});
