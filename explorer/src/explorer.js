// mount(el, options): a map of one variable read straight from an Icechunk
// store, with a control strip under it. Nothing is fetched until mount() runs.
import { Deck, MapView, WebMercatorViewport } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import {
  COLORMAP_INDEX,
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import { mesh } from "topojson-client";
import * as zarr from "zarrita";
import { defineWebMercatorOver, lonLatToCell, makeResolver } from "./crs.js";
import css from "./explorer.css?inline";
import { CELSIUS_RANGE, formatValue, isCelsius, sampleRange } from "./lib/colour.js";
import { absolutePath, blockRange, stepWithData } from "./lib/dims.js";
import { shiftAttrs } from "./lib/grid.js";
import { formatLead, formatUtc } from "./lib/time.js";
import { makeSource, unsupportedReason } from "./source.js";
import { openStore } from "./store.js";
import { StaleTileError, makeGetTileData, makeRenderTile, readTileBlock } from "./tile.js";

const BORDERS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";
const COLORMAP = COLORMAP_INDEX.turbo;
/** Default cap on slider steps held in one texture array (amendment: bounded window). */
const DEFAULT_TEXTURE_LAYERS = 128;
/** Default GPU-memory budget for the tiles in view; `maxTextureBytes` overrides it. */
const DEFAULT_TEXTURE_BYTES = 2e9;
/** Concurrent tile requests per layer: each decodes a whole inner chunk on the main thread. */
const MAX_REQUESTS = 4;
/** Cached tiles per layer (eviction only: tiles in view always load). */
const MAX_CACHE_TILES = 64;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.dataset.explorer = "";
  style.textContent = css;
  document.head.append(style);
}

const isAbort = (e) =>
  e instanceof StaleTileError || (e instanceof Error && e.name === "AbortError") || e?.name === "AbortError";
const errText = (e) => (e instanceof Error ? e.message : String(e));

/** @param {string} tag @param {Record<string, any>} [props] @param {(Node|string)[]} [children] */
function h(tag, props = {}, children = []) {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

/**
 * @param {HTMLElement} el
 * @param {{
 *   id: string, href: string,
 *   variables: { path?: string, name: string, long_name?: string, units?: string, dims?: string[] }[],
 *   defaultVariable?: string,
 *   initialView?: { bounds: [number, number, number, number] } | { longitude: number, latitude: number, zoom: number },
 *   proj4?: string | null,
 *   maxTextureLayers?: number,
 *   maxTextureBytes?: number,
 * }} options
 */
export function mount(el, options) {
  injectStyle();
  defineWebMercatorOver();
  const opts = { ...options };
  // Paths are store keys, which are absolute ("/pressure_level/temperature").
  const variables = opts.variables.map((v) => ({ ...v, path: absolutePath(v.path ?? v.name) }));

  // ---- DOM ------------------------------------------------------------------
  const mapEl = h("div", { className: "explorer-map" });
  // aria-labels give each control an exact accessible name; a wrapping <label>
  // would fold the selected option's text into it.
  const varSelect = h("select", { disabled: true, ariaLabel: "Variable" });
  const extrasEl = h("span", { className: "explorer-extras" });
  const unloadBtn = h("button", { type: "button", textContent: "Unload", disabled: true });
  const retryBtn = h("button", { type: "button", textContent: "Retry", hidden: true });
  const sliderLabelText = h("span", { textContent: "Lead time" });
  const slider = h("input", { type: "range", min: "0", max: "0", value: "0", step: "1", disabled: true, ariaLabel: "Lead time" });
  const sliderRow = h("label", { className: "explorer-slider" }, [sliderLabelText, slider]);
  const timesEl = h("span", { className: "explorer-times" });
  const legendCanvas = h("canvas", { width: 256, height: 1 });
  const legendMin = h("span");
  const legendMax = h("span");
  const legendNote = h("span", { className: "explorer-note" });
  const statusEl = h("span", { className: "explorer-status", role: "status" });
  const strip = h("div", { className: "explorer-strip" }, [
    h("div", {}, [h("label", {}, [h("span", { textContent: "Variable" }), varSelect]), extrasEl, unloadBtn, retryBtn]),
    sliderRow,
    h("div", {}, [
      timesEl,
      h("span", { className: "explorer-legend" }, [legendMin, legendCanvas, legendMax, legendNote]),
    ]),
    h("div", {}, [statusEl]),
  ]);
  el.classList.add("explorer");
  el.replaceChildren(mapEl, strip);

  // ---- state ----------------------------------------------------------------
  const s = {
    destroyed: false,
    /** Bumped by every async selection; stale results check it and drop out. */
    gen: 0,
    /** Bumped to force fresh layers (retry, reload). */
    retry: 0,
    store: /** @type {import("./store.js").Store | null} */ (null),
    source: /** @type {ReturnType<typeof makeSource> | null} */ (null),
    device: /** @type {import("@luma.gl/core").Device | null} */ (null),
    colormap: /** @type {import("@luma.gl/core").Texture | null} */ (null),
    window: DEFAULT_TEXTURE_LAYERS,
    info: /** @type {import("./source.js").VariableInfo | null} */ (null),
    pinnedIdx: /** @type {number[]} */ ([]),
    stepIndex: 0,
    range: /** @type {{ min: number, max: number, kind: "fixed" | "sample", status?: string } | null} */ (null),
    ranges: new Map(),
    prefetch: /** @type {{ base: string, r0: number, c0: number, data: Float32Array } | null} */ (null),
    unloaded: false,
    abort: new AbortController(),
    borders: null,
    lineColor: [0, 0, 0, 200],
    liveIds: new Set(),
    loadedIds: new Set(),
    textures: new Map(),
    retiring: /** @type {string[]} */ ([]),
    layerCallbacks: new Map(),
    resolvers: new Map(),
    error: false,
    /** Cap on the data layer's GPU memory for one view (a device limit, not a zoom limit). */
    textureBudget: opts.maxTextureBytes ?? DEFAULT_TEXTURE_BYTES,
    overBudget: false,
    /** First-time phase marks (ms since mount) for the harness. */
    marks: /** @type {Record<string, number>} */ ({}),
  };
  const t0 = performance.now();
  const mark = (k) => {
    if (!(k in s.marks)) s.marks[k] = Math.round(performance.now() - t0);
  };

  function setState(state, msg) {
    if (s.destroyed) return;
    el.dataset.state = state;
    s.error = state === "error";
    statusEl.textContent = msg;
    retryBtn.hidden = state !== "error";
  }

  // ---- deck -----------------------------------------------------------------
  const center = viewCenter(opts.initialView);
  // Tracked here because deck has no viewport until its first draw.
  let viewState = initialViewState(opts.initialView, mapEl);
  let resolveDevice;
  const deviceReady = new Promise((r) => (resolveDevice = r));
  const deck = new Deck({
    parent: mapEl,
    views: new MapView({ repeat: false }),
    initialViewState: viewState,
    controller: { dragRotate: false, touchRotate: false },
    onViewStateChange: ({ viewState: vs }) => {
      viewState = vs;
      scheduleBudgetCheck();
    },
    layers: [],
    onDeviceInitialized: (device) => {
      s.device = device;
      resolveDevice(device);
    },
    onAfterRender,
    onError: (e) => {
      console.error("[explorer]", e);
      setState("error", `Map error: ${errText(e)}`);
    },
  });

  function onAfterRender() {
    // Destroy the textures of layers that left the layer list (deck's tileset
    // aborts their requests on finalize but never calls onTileUnload).
    for (const id of s.retiring.splice(0)) {
      for (const t of s.textures.get(id) ?? []) t.destroy();
      s.textures.delete(id);
      s.layerCallbacks.delete(id);
      s.loadedIds.delete(id);
    }
    if (el.dataset.state === "loading" && s.info && !s.error && !s.unloaded && s.liveIds.size > 0) {
      if ([...s.liveIds].every((id) => s.loadedIds.has(id))) {
        mark("ready");
        setState("ready", "Ready");
      }
    }
  }

  // ---- layers ---------------------------------------------------------------
  function selectionFor(info, pinnedIdx, stepIndex) {
    const sel = {};
    if (info.init) sel[info.init.name] = info.init.index;
    info.pinned.forEach((p, i) => (sel[p.name] = pinnedIdx[i]));
    let block = { start: 0, stop: 1 };
    if (info.step) {
      block = blockRange(stepIndex, info.step.chunk, s.window, info.step.n);
      sel[info.step.name] = zarr.slice(block.start, block.stop);
    }
    return { sel, block };
  }

  const pinnedKey = (idx) => idx.join(",");
  const baseKey = (info, pinnedIdx, block) =>
    `${info.path}|i${info.init?.index ?? "-"}|p${pinnedKey(pinnedIdx)}|b${block.start}`;

  function callbacksFor(id, info) {
    if (!s.layerCallbacks.has(id)) {
      const live = () => s.liveIds.has(id);
      const set = new Set();
      s.textures.set(id, set);
      s.layerCallbacks.set(id, {
        getTileData: makeGetTileData({
          info,
          live,
          track: (t) => set.add(t),
          take: (r0, c0) => {
            const p = s.prefetch;
            if (p && id.startsWith(`${p.base}|`) && p.r0 === r0 && p.c0 === c0) {
              s.prefetch = null;
              return p.data;
            }
            return undefined;
          },
          onStart: () => {
            if (!live()) return;
            mark("firstTileRequested");
            s.loadedIds.delete(id);
            if (el.dataset.state === "ready") setState("loading", "Loading tiles…");
          },
        }),
        onTileUnload: (tile) => {
          const t = tile.content?.texture;
          if (t) {
            t.destroy();
            set.delete(t);
          }
        },
        onTileError: (e) => {
          if (!live() || isAbort(e)) return;
          console.error("[explorer] tile", e);
          setState("error", `Some tiles failed to load (${errText(e)}). Areas shown blank have no data drawn.`);
        },
        onViewportLoad: () => {
          if (!live()) return;
          s.loadedIds.add(id);
          mark("viewportLoaded");
          deck.redraw();
        },
      });
    }
    return s.layerCallbacks.get(id);
  }

  function resolverFor(grid) {
    if (!s.resolvers.has(grid)) s.resolvers.set(grid, makeResolver(grid.def));
    return s.resolvers.get(grid);
  }

  /**
   * GPU memory the data layer would need for the current view: tiles in view ×
   * steps in the block × tile cells × 4 bytes. The view's corners and edge
   * midpoints are mapped to grid cells (clamped to the grid).
   */
  function viewTextureBytes(info, block) {
    const vp = new WebMercatorViewport({
      ...viewState,
      width: mapEl.clientWidth || 800,
      height: mapEl.clientHeight || 450,
    });
    const rows = [];
    const cols = [];
    for (const fx of [0, 0.5, 1]) {
      for (const fy of [0, 0.5, 1]) {
        const [r, c] = lonLatToCell(info.grid, vp.unproject([fx * vp.width, fy * vp.height]));
        rows.push(r);
        cols.push(c);
      }
    }
    const { h, w } = info.tile;
    const span = (v, size) => Math.floor(Math.max(...v) / size) - Math.floor(Math.min(...v) / size) + 1;
    return span(rows, h) * span(cols, w) * (block.stop - block.start) * h * w * 4;
  }

  let budgetFrame = 0;
  function scheduleBudgetCheck() {
    if (budgetFrame || !s.info) return;
    budgetFrame = requestAnimationFrame(() => {
      budgetFrame = 0;
      render();
    });
  }

  function render() {
    if (s.destroyed) return;
    const layers = [];
    const ids = new Set();
    const { info, range } = s;
    let overBudget = false;
    if (info && range && s.colormap && !s.unloaded) {
      const { block } = selectionFor(info, s.pinnedIdx, s.stepIndex);
      const need = viewTextureBytes(info, block);
      s.textureNeed = need;
      overBudget = need > s.textureBudget;
      if (overBudget) {
        setState(
          "error",
          `GPU memory: this view needs about ${(need / 1e9).toFixed(1)} GB for ${info.path.slice(1)} (budget ${(s.textureBudget / 1e9).toFixed(1)} GB), so no data is loaded. Zoom in to load it.`,
        );
      } else if (s.overBudget) {
        setState("loading", "Loading tiles…");
      }
    }
    s.overBudget = overBudget;
    if (info && range && s.colormap && !s.unloaded && !overBudget) {
      const { sel, block } = selectionFor(info, s.pinnedIdx, s.stepIndex);
      const base = baseKey(info, s.pinnedIdx, block);
      const layerIndex = s.stepIndex - block.start;
      for (const offset of info.grid.wrapOffsets) {
        const id = `${base}|r${s.retry}|w${offset}`;
        ids.add(id);
        const cb = callbacksFor(id, info);
        layers.push(
          new ZarrLayer({
            // One layer per (variable, run, pinned indices, block): leaving a
            // block drops its tiles, so an old field never sits under new labels.
            id,
            node: info.arr,
            metadata: shiftAttrs(info.grid.attrs, offset),
            selection: sel,
            epsgResolver: resolverFor(info.grid),
            getTileData: cb.getTileData,
            renderTile: makeRenderTile({
              layerIndex,
              colormapTexture: s.colormap,
              colormapIndex: COLORMAP,
              min: range.min,
              max: range.max,
            }),
            updateTriggers: { renderTile: [layerIndex, range.min, range.max] },
            signal: s.abort.signal,
            maxRequests: MAX_REQUESTS,
            maxCacheSize: MAX_CACHE_TILES,
            debounceTime: 50,
            onTileUnload: cb.onTileUnload,
            onTileError: cb.onTileError,
            onViewportLoad: cb.onViewportLoad,
          }),
        );
      }
    }
    if (s.borders) {
      layers.push(
        new GeoJsonLayer({
          id: "borders",
          data: s.borders,
          stroked: true,
          getLineColor: s.lineColor,
          lineWidthUnits: "pixels",
          getLineWidth: 1,
          // Chukotka, Fiji and Antarctica borders cross the antimeridian.
          wrapLongitude: true,
          updateTriggers: { getLineColor: s.lineColor.join(",") },
        }),
      );
    }
    for (const id of s.liveIds) if (!ids.has(id)) s.retiring.push(id);
    s.liveIds = ids;
    deck.setProps({ layers });
  }

  // ---- labels, legend, controls --------------------------------------------
  function label(name, text) {
    return h("span", {}, [h("span", { className: "explorer-k", textContent: `${name} ` }), h("span", { textContent: text, dataset: { label: name.toLowerCase() } })]);
  }

  function updateLabels() {
    const { info } = s;
    const parts = [];
    if (!info) {
      timesEl.replaceChildren();
      return;
    }
    const init = info.init ? info.init.times[info.init.index] : null;
    if (init !== null) parts.push(label("Init", formatUtc(init)));
    if (info.step?.kind === "lead") {
      const lead = info.step.ms[s.stepIndex];
      parts.push(label("Lead", formatLead(lead)));
      if (init !== null) parts.push(label("Valid", formatUtc(init + lead)));
    } else if (info.step?.kind === "time") {
      parts.push(label("Time", formatUtc(info.step.ms[s.stepIndex])));
    }
    const member = info.pinned.find((p) => !p.select);
    if (member) parts.push(h("span", { textContent: member.labels[s.pinnedIdx[info.pinned.indexOf(member)]], dataset: { label: "member" } }));
    timesEl.replaceChildren(...parts);
  }

  function updateLegend() {
    const { info, range } = s;
    if (!info || !range) {
      legendMin.textContent = legendMax.textContent = legendNote.textContent = "";
      legendCanvas.hidden = true;
      return;
    }
    legendCanvas.hidden = false;
    legendMin.textContent = formatValue(range.min);
    const units = isCelsius(info.units) ? "°C" : info.units;
    legendMax.textContent = `${formatValue(range.max)}${units ? ` ${units}` : ""}`;
    legendNote.textContent =
      range.kind === "fixed"
        ? "fixed range"
        : range.status === "empty"
          ? "no values in the sample"
          : range.status === "flat"
            ? "sample is one value"
            : "2–98% of a sample";
  }

  function buildControls() {
    const { info } = s;
    extrasEl.replaceChildren();
    if (!info) {
      slider.disabled = true;
      return;
    }
    info.pinned.forEach((p, i) => {
      if (!p.select) return;
      const sel = h(
        "select",
        { ariaLabel: p.name },
        p.labels.map((text, j) => h("option", { value: String(j), textContent: text, selected: j === s.pinnedIdx[i] })),
      );
      sel.addEventListener("change", () => void setPinned(i, Number(sel.value)));
      extrasEl.append(h("label", {}, [h("span", { textContent: p.name }), sel]));
    });
    sliderRow.hidden = !info.step;
    if (info.step) {
      sliderLabelText.textContent = slider.ariaLabel = info.step.kind === "time" ? "Time" : "Lead time";
      slider.max = String(info.step.n - 1);
      slider.value = String(s.stepIndex);
      slider.disabled = false;
    }
  }

  // ---- actions --------------------------------------------------------------
  /**
   * The reference read: the block and chunk at the initial view's centre.
   * Deterministic (not whichever tile arrives first), and handed to the tile
   * that needs the same chunk, so it is not fetched twice.
   */
  async function reference(info, pinnedIdx, stepIndex, signal) {
    const { sel, block } = selectionFor(info, pinnedIdx, stepIndex);
    const [row, col] = info.centerCell;
    return { ...(await readTileBlock(info, sel, row, col, signal)), block };
  }

  function rangeFor(info, pinnedIdx, ref) {
    const key = `${opts.id}|${info.path}|${pinnedKey(pinnedIdx)}`;
    if (!s.ranges.has(key)) {
      s.ranges.set(
        key,
        isCelsius(info.units)
          ? { min: CELSIUS_RANGE[0], max: CELSIUS_RANGE[1], kind: "fixed" }
          : { ...sampleRange(ref.data), kind: "sample" },
      );
    }
    return s.ranges.get(key);
  }

  /** Commit a new (variable, pinned, step) atomically, or show why it failed. */
  async function apply(path, pinnedIdx, busyMsg) {
    const g = ++s.gen;
    setState("loading", busyMsg);
    unloadBtn.disabled = true;
    try {
      const info = path === s.info?.path ? s.info : await s.source.describe(path, { center });
      if (g !== s.gen) return;
      mark("described");
      const maxDim = s.device.limits.maxTextureDimension2D;
      if (info.tile.w > maxDim || info.tile.h > maxDim) {
        throw new Error(`this device's GPU can't hold a ${info.tile.w}×${info.tile.h} tile (max texture size ${maxDim})`);
      }
      const idx = pinnedIdx ?? info.pinned.map(() => 0);
      let stepIndex = info === s.info ? s.stepIndex : (info.step?.index ?? 0);
      const ref = await reference(info, idx, stepIndex, s.abort.signal);
      if (g !== s.gen) return;
      if (info !== s.info && info.step) {
        // Open on a step that has data: 24 h means and accumulations are NaN at
        // +0 h, and an analysis's newest time can still be unwritten.
        const k = stepWithData(ref.data, ref.block.stop - ref.block.start, info.step.kind === "time" ? "last" : "first");
        if (k >= 0) stepIndex = ref.block.start + k;
      }
      const range = rangeFor(info, idx, ref);
      s.prefetch = { base: baseKey(info, idx, ref.block), r0: ref.r0, c0: ref.c0, data: ref.data };
      mark("rangeReady");
      Object.assign(s, { info, pinnedIdx: idx, stepIndex, range });
      s.retry++;
      buildControls();
      updateLabels();
      updateLegend();
      unloadBtn.disabled = false;
      if (info.step?.noData) {
        setState("error", `No data found for the latest ${info.step.name} (${info.step.log.join("; ")})`);
      } else {
        setState("loading", "Loading tiles…");
      }
      render();
    } catch (e) {
      if (g !== s.gen || s.destroyed) return;
      console.error("[explorer]", e);
      // Never leave the previous variable's field or colours under the new choice.
      Object.assign(s, { info: null, range: null });
      buildControls();
      updateLabels();
      updateLegend();
      render();
      const v = variables.find((x) => x.path === path);
      setState("error", `Could not load ${v?.name ?? path}: ${errText(e)}`);
      s.failed = { path, pinnedIdx };
    }
  }

  function setPinned(i, j) {
    const idx = s.pinnedIdx.slice();
    idx[i] = j;
    return apply(s.info.path, idx, "Loading…");
  }

  function setStep(i) {
    if (!s.info?.step) return;
    const { chunk, n } = s.info.step;
    const newBlock = blockRange(i, chunk, s.window, n).start !== blockRange(s.stepIndex, chunk, s.window, n).start;
    s.stepIndex = i;
    slider.value = String(i);
    updateLabels();
    // A new block is a fresh layer, so it also retries after an error.
    if (newBlock || !s.error) setState("loading", newBlock ? "Loading tiles…" : "Loading…");
    render();
  }

  varSelect.addEventListener("change", () => void apply(varSelect.value, null, "Opening variable…"));
  slider.addEventListener("input", () => setStep(Number(slider.value)));
  retryBtn.addEventListener("click", () => {
    if (!s.store) return void start();
    if (!s.info) return void apply(s.failed?.path ?? varSelect.value, s.failed?.pinnedIdx ?? null, "Retrying…");
    s.retry++;
    setState("loading", "Retrying…");
    render();
  });
  unloadBtn.addEventListener("click", () => {
    if (!s.unloaded) {
      // Cancel in-flight requests and release every texture.
      s.unloaded = true;
      s.gen++;
      s.abort.abort();
      render();
      unloadBtn.textContent = "Load";
      setState("ready", "Unloaded. Weather data released; borders only.");
    } else {
      s.unloaded = false;
      s.abort = new AbortController();
      s.retry++;
      unloadBtn.textContent = "Unload";
      if (s.info && s.info.path === varSelect.value) {
        setState("loading", "Loading tiles…");
        render();
      } else void apply(varSelect.value, null, "Opening variable…");
    }
  });

  // ---- startup --------------------------------------------------------------
  async function initColormap(device) {
    const bytes = await (await fetch(colormapsPngUrl)).arrayBuffer();
    const image = await decodeColormapSprite(bytes);
    s.colormap = createColormapTexture(device, image);
    const ctx = legendCanvas.getContext("2d");
    const row = new ImageData(image.width, 1);
    row.data.set(image.data.subarray(COLORMAP * image.width * 4, (COLORMAP + 1) * image.width * 4));
    legendCanvas.width = image.width;
    ctx.putImageData(row, 0, 0);
  }

  function readLineColor() {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).color);
    const [r, g, b] = m ? m[1].split(",").map(Number) : [0, 0, 0];
    s.lineColor = [r, g, b, 200];
  }
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    readLineColor();
    render();
  };
  scheme.addEventListener("change", onScheme);

  async function loadBorders() {
    try {
      const topo = await (await fetch(BORDERS_URL)).json();
      s.borders = mesh(topo, topo.objects.countries);
      readLineColor();
      render();
    } catch (e) {
      console.warn("[explorer] borders failed to load", e);
    }
  }

  async function start() {
    const g = ++s.gen;
    setState("loading", "Opening the data store…");
    try {
      const device = await deviceReady;
      s.window = Math.max(1, Math.min(opts.maxTextureLayers ?? DEFAULT_TEXTURE_LAYERS, device.limits.maxTextureArrayLayers));
      const [store] = await Promise.all([openStore(opts.href, { signal: s.abort.signal }), s.colormap ? null : initColormap(device)]);
      if (g !== s.gen) return;
      s.store = store;
      mark("storeOpen");
      s.source = makeSource(store, opts);
      const reasons = await Promise.all(variables.map(async (v) => unsupportedReason(await store.getMeta(v.path))));
      varSelect.replaceChildren(
        ...variables.map((v, i) =>
          h("option", {
            value: v.path,
            textContent: reasons[i] ? `${v.name} (${reasons[i]})` : v.name,
            title: v.long_name ?? "",
            disabled: Boolean(reasons[i]),
          }),
        ),
      );
      const usable = variables.filter((_, i) => !reasons[i]);
      if (!usable.length) throw new Error("none of this dataset's variables can be drawn in the browser");
      const first =
        usable.find((v) => v.name === opts.defaultVariable || v.path === absolutePath(opts.defaultVariable ?? "")) ??
        usable[0];
      varSelect.value = first.path;
      varSelect.disabled = false;
      await apply(first.path, null, "Opening variable…");
    } catch (e) {
      if (g !== s.gen || s.destroyed) return;
      console.error("[explorer]", e);
      setState("error", `Could not open the data store: ${errText(e)}`);
    }
  }

  void loadBorders();
  void start();

  return {
    destroy() {
      s.destroyed = true;
      s.gen++;
      cancelAnimationFrame(budgetFrame);
      s.abort.abort();
      scheme.removeEventListener("change", onScheme);
      deck.finalize();
      for (const set of s.textures.values()) for (const t of set) t.destroy();
      s.textures.clear();
      s.colormap?.destroy();
      el.replaceChildren();
      el.classList.remove("explorer");
      delete el.dataset.state;
    },
    /** [lon, lat] → [x, y] CSS px relative to the map canvas. */
    project(lonLat) {
      const vp = deck.getViewports()[0];
      return vp ? vp.project(lonLat) : null;
    },
    /** Internal state for tests and the verification harness. */
    debug() {
      const { info } = s;
      return {
        snapshotId: s.store?.snapshotId ?? null,
        variable: info?.path ?? null,
        init: info?.init ? { index: info.init.index, log: info.init.log } : null,
        step: info?.step ? { name: info.step.name, index: s.stepIndex, n: info.step.n, chunk: info.step.chunk, log: info.step.log } : null,
        window: s.window,
        textureNeed: s.textureNeed ?? null,
        textureBudget: s.textureBudget,
        marks: s.marks,
        range: s.range,
        layers: [...s.liveIds],
        textures: [...s.textures.values()].reduce((n, set) => n + set.size, 0),
        grid: info ? { attrs: info.grid.attrs, crs: info.grid.crs, wrapOffsets: info.grid.wrapOffsets } : null,
      };
    },
    setStep,
    deck,
  };
}

function viewCenter(view) {
  if (view && "bounds" in view) {
    const [w, s, e, n] = view.bounds;
    return [(w + e) / 2, (s + n) / 2];
  }
  if (view) return [view.longitude, view.latitude];
  return [0, 20];
}

function initialViewState(view, container) {
  const base = { pitch: 0, bearing: 0, minZoom: 0, maxPitch: 0 };
  if (view && "bounds" in view) {
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 450;
    const [w, s, e, n] = view.bounds;
    const fit = new WebMercatorViewport({ width, height }).fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: Math.min(20, width / 10, height / 10) },
    );
    return { ...base, longitude: fit.longitude, latitude: fit.latitude, zoom: Math.max(0, fit.zoom) };
  }
  if (view) return { ...base, longitude: view.longitude, latitude: view.latitude, zoom: Math.max(0, view.zoom) };
  return { ...base, longitude: 0, latitude: 20, zoom: 0 };
}
