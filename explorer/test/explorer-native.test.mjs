import assert from "node:assert/strict";
import test from "node:test";
import * as zarr from "zarrita";
import { makeMesh } from "../src/native/mesh.js";
import { paddedReader } from "../src/native/read.js";
import { makeSource } from "../src/source.js";
import { readTileBlock } from "../src/tile.js";

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

test("a native tile applies scale, offset and missing values only once", async () => {
  const bytes = new Map();
  const root = zarr.root(bytes);
  async function array(path, dtype, dimensionNames, shape, data, attributes, fillValue) {
    const arr = await zarr.create(root.resolve(path), {
      dtype, dimensionNames, shape, chunkShape: shape, attributes, fillValue,
    });
    if (data) await zarr.set(arr, null, { data, shape, stride: shape.length === 2 ? [shape[1], 1] : [1] });
  }
  await array("/mesh", "int32", [], [], null, {
    cf_role: "mesh_topology", topology_dimension: 2, node_coordinates: "lon lat",
    face_node_connectivity: "faces",
  });
  const points = coords.slice(0, 9);
  await array("/lon", "float32", ["node"], [9], Float32Array.from(points, ([x]) => x), { standard_name: "longitude" });
  await array("/lat", "float32", ["node"], [9], Float32Array.from(points, ([, y]) => y), { standard_name: "latitude" });
  await array("/faces", "int32", ["cell", "corner"], [3, 3], nodes.slice(0, 9), { start_index: 1 });
  // The valid raw value 2 decodes to 3, which was a missing sentinel before decoding.
  await array("/scaled", "int16", ["cell"], [3], Int16Array.of(2, 3, -9999), {
    location: "face", mesh: "/mesh", scale_factor: 2, add_offset: -1, missing_value: 3,
  }, -9999);

  const source = makeSource({
    getMeta: async (path) => JSON.parse(new TextDecoder().decode(bytes.get(path + "/zarr.json"))),
    open: (path) => zarr.open(root.resolve(path), { kind: "array" }),
  });
  const info = await source.describe("/scaled", { center: [-2, 0] });
  const { data } = await readTileBlock(info, {}, 0, 0);
  assert.deepEqual(data, Float32Array.of(3, NaN, NaN, NaN));
});
