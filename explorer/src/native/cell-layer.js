import { CompositeLayer } from "@deck.gl/core";
import { Buffer } from "@luma.gl/core";
import { tileSlice } from "../tile.js";
import { CellChunkLayer } from "./cell-chunk-layer.js";

/** @typedef {ReturnType<import("./mesh.js").makeMesh>} Mesh */

/** Geometry belongs to the mesh for the life of the explorer, independent of
 * the variable, run or block that owns the data textures. */
export function nativeGeometry() {
  /** @type {Map<Mesh, Map<number, { buffer: Buffer, vertexCount: number }>>} */
  const meshes = new Map();
  return {
    /** @param {import("@luma.gl/core").Device} device @param {Mesh} mesh @param {number} id */
    get(device, mesh, id) {
      if (!meshes.has(mesh)) meshes.set(mesh, new Map());
      const buffers = meshes.get(mesh);
      if (!buffers.has(id)) {
        const positions = mesh.positions(id);
        const buffer = device.createBuffer({ data: positions, usage: Buffer.VERTEX });
        buffers.set(id, { buffer, vertexCount: positions.length / 2 });
      }
      return buffers.get(id);
    },
    destroy() {
      for (const buffers of meshes.values()) for (const { buffer } of buffers.values()) buffer.destroy();
      meshes.clear();
    },
  };
}

/** A native chunk plays the same role as a raster tile. Retain textures only
 * while visible, and leave disposal and viewport status to the tile callbacks. */
export class NativeCellLayer extends CompositeLayer {
  static layerName = "NativeCellLayer";

  initializeState() {
    this.setState({ selected: null, tiles: new Map(), reads: new Map(), failed: new Set() });
  }

  shouldUpdateState({ changeFlags }) {
    return changeFlags.somethingChanged;
  }

  updateState() {
    const { info, onTileUnload } = this.props;
    const ids = info.native.visible(this.context.viewport.getBounds());
    const { selected, reads, tiles, failed } = this.state;
    if (selected?.join(",") === ids.join(",")) return;
    this.state.selected = ids;
    for (const [id, controller] of reads) if (!ids.includes(id)) {
      reads.delete(id);
      controller.abort();
    }
    for (const [id, tile] of tiles) if (!ids.includes(id)) {
      tiles.delete(id);
      onTileUnload(tile);
    }
    for (const id of failed) if (!ids.includes(id)) failed.delete(id);
    this.pump();
  }

  pump() {
    const { maxRequests, onViewportLoad, signal } = this.props;
    const state = this.state;
    const { selected, reads, tiles, failed } = state;
    if (!selected || signal.aborted) return;
    if (selected.every((id) => tiles.has(id))) {
      if (state.reported === selected) return;
      state.reported = selected;
      queueMicrotask(() => {
        if (state.selected === selected && !signal.aborted) onViewportLoad(selected.map((id) => tiles.get(id)));
      });
      return;
    }
    for (const id of selected) {
      if (reads.size >= maxRequests) break;
      if (!reads.has(id) && !tiles.has(id) && !failed.has(id)) void this.load(id);
    }
  }

  /** @param {number} id */
  async load(id) {
    const { info, selection, signal, getTileData, onTileUnload, onTileError } = this.props;
    const { reads, tiles, failed } = this.state;
    const controller = new AbortController();
    reads.set(id, controller);
    const { w, h } = info.tile;
    try {
      const content = await getTileData(info.node, {
        device: this.context.device, sliceSpec: tileSlice(info, selection, id * h, 0),
        width: w, height: h, signal: controller.signal,
      });
      // A completed read may have uploaded just before this tile was retired.
      if (controller.signal.aborted || signal.aborted) onTileUnload({ content });
      else {
        tiles.set(id, { content });
        this.getCurrentLayer()?.setNeedsUpdate();
      }
    } catch (error) {
      if (!controller.signal.aborted && !signal.aborted) {
        failed.add(id);
        onTileError(error);
      }
    } finally {
      if (reads.get(id) === controller) {
        reads.delete(id);
        this.getCurrentLayer()?.pump();
      }
    }
  }

  renderLayers() {
    const { info, geometry, paint } = this.props;
    return [...this.state.tiles].map(([id, { content }]) => new CellChunkLayer(this.getSubLayerProps({
      id: String(id),
      ...geometry.get(this.context.device, info.native, id),
      ...paint,
      texture: content.texture,
      pickable: false,
      parameters: { cullMode: "none", depthWriteEnabled: false },
    })));
  }

  finalizeState() {
    this.state.selected = null;
    for (const controller of this.state.reads.values()) controller.abort();
    this.state.reads.clear();
    for (const tile of this.state.tiles.values()) this.props.onTileUnload(tile);
    this.state.tiles.clear();
  }
}
