// Tile fetch and GPU pipeline, ported from the spike (itself from the
// deck.gl-raster ECMWF example): every slider step of a block goes into one
// r32float 2D-array texture, and the step shown is a uniform, so scrubbing
// inside a block costs no requests.
import { Colormap, LinearRescale } from "@developmentseed/deck.gl-raster/gpu-modules";
import * as zarr from "zarrita";
import { toFloat32 } from "./lib/colour.js";

const SampleTexture2DArray = {
  name: "sampleTexture2DArray",
  fs: `uniform sampleTexture2DArrayUniforms {\n  float layerIndex;\n} sampleTexture2DArray;\n`,
  inject: {
    "fs:#decl": `precision highp sampler2DArray;\nuniform sampler2DArray dataTex;\n`,
    "fs:DECKGL_FILTER_COLOR": `
      float v = texture(dataTex, vec3(geometry.uv, sampleTexture2DArray.layerIndex)).r;
      if (isnan(v)) discard;
      color = vec4(v, v, v, 1.0);
    `,
  },
  uniformTypes: { layerIndex: "f32" },
  getUniforms: (props) => ({ layerIndex: props.layerIndex ?? 0, dataTex: props.dataTex }),
};

export class StaleTileError extends Error {
  name = "AbortError";
}

/**
 * Fetch one tile's block and upload it. `live()` is checked after the await:
 * a tile that finishes for a layer that has since been replaced creates no
 * texture (and so can't leak or draw under newer labels).
 * @param {{
 *   info: import("./source.js").VariableInfo,
 *   live: () => boolean,
 *   track: (texture: import("@luma.gl/core").Texture) => void,
 *   take: (row: number, col: number) => Float32Array | undefined,
 *   onStart?: () => void,
 * }} ctx
 */
export function makeGetTileData(ctx) {
  return async (arr, { device, sliceSpec, width, height, signal }) => {
    ctx.onStart?.();
    const [rows, cols] = sliceSpec.slice(-2);
    let data = ctx.take(rows.start ?? 0, cols.start ?? 0);
    if (!data) {
      const chunk = await zarr.get(arr, sliceSpec, { signal });
      if (chunk.shape.at(-2) !== height || chunk.shape.at(-1) !== width) {
        throw new Error(`Unexpected tile shape [${chunk.shape.join(", ")}]`);
      }
      data = toFloat32(chunk.data, ctx.info);
    }
    if (signal?.aborted || !ctx.live()) throw new StaleTileError("Tile belongs to a replaced layer");
    const depth = data.length / (width * height);
    const texture = device.createTexture({
      dimension: "2d-array",
      format: "r32float",
      width,
      height,
      depth,
      mipLevels: 1,
      data,
      sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
    });
    ctx.track(texture);
    return { texture, depth, width, height, byteLength: data.byteLength };
  };
}

/** Read the same block + spatial chunk a tile would, as Float32 (for the colour range). */
export async function readTileBlock(info, selection, row, col, signal) {
  const { h, w } = info.tile;
  const r0 = Math.floor(row / h) * h;
  const c0 = Math.floor(col / w) * w;
  const spec = info.dimNames.map((name, i) => {
    if (i === info.dimNames.length - 2) return zarr.slice(r0, Math.min(r0 + h, info.grid.y.n));
    if (i === info.dimNames.length - 1) return zarr.slice(c0, Math.min(c0 + w, info.grid.x.n));
    return selection[name];
  });
  const chunk = await zarr.get(info.arr, spec, { signal });
  return { r0, c0, data: toFloat32(chunk.data, info) };
}

export function makeRenderTile({ layerIndex, colormapTexture, colormapIndex, min, max }) {
  return (data) => ({
    renderPipeline: [
      { module: SampleTexture2DArray, props: { dataTex: data.texture, layerIndex } },
      { module: LinearRescale, props: { rescaleMin: min, rescaleMax: max } },
      { module: Colormap, props: { colormapTexture, colormapIndex, reversed: false } },
    ],
  });
}
