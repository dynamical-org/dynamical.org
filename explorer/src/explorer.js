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
import { formatValue, initialRange, isCelsius, settleRange } from "./lib/colour.js";
import { absolutePath, blockRange, findFirstData, findLatestData, initOptions, stepWithData, viewData } from "./lib/dims.js";
import { shiftAttrs } from "./lib/grid.js";
import { changeSelection, stepAccepted } from "./lib/pending.js";
import { formatLead, formatUtc } from "./lib/time.js";
import { makeSource, unsupportedReason } from "./source.js";
import { openStore } from "./store.js";
import { StaleTileError, makeGetTileData, makeRenderTile, readTileBlock } from "./tile.js";

const BORDERS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";
const COLORMAP = COLORMAP_INDEX.turbo;
/** Default cap on slider steps held in one texture array (amendment: bounded window). */
const DEFAULT_TEXTURE_LAYERS = 128;
/**
 * Estimated GPU memory for the tiles in view above which the status warns (it never stops
 * loading); `maxTextureBytes` overrides it. An application heuristic, not a device limit.
 */
const DEFAULT_TEXTURE_BYTES = 2e9;
/**
 * Concurrent tile requests per layer (each decodes a whole inner chunk on the main thread);
 * `maxRequests` overrides it (tests set it low).
 */
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
 *   maxRequests?: number,
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
  // Shown only while loading: aborts the reads in flight and keeps what is drawn.
  const stopBtn = h("button", { type: "button", textContent: "Stop loading", hidden: true });
  const retryBtn = h("button", { type: "button", textContent: "Retry", hidden: true });
  // Advisory only: the view keeps loading while this is shown.
  const gpuWarning = h("span", { className: "explorer-note", hidden: true, dataset: { warning: "gpu" } });
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
    h("div", {}, [h("label", {}, [h("span", { textContent: "Variable" }), varSelect]), extrasEl, stopBtn, retryBtn]),
    sliderRow,
    h("div", {}, [
      timesEl,
      h("span", { className: "explorer-legend" }, [legendMin, legendCanvas, legendMax, legendNote]),
    ]),
    h("div", {}, [statusEl, gpuWarning]),
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
    /** Aborted by Stop loading (replaced on resume), and by destroy. */
    abort: new AbortController(),
    /** Stop loading was pressed: no tile reads or uploads until Retry or a new selection. */
    stopped: false,
    /** Startup (device, store, variable metadata) completed; until then Retry restarts it. */
    started: false,
    borders: null,
    lineColor: [0, 0, 0, 200],
    liveIds: new Set(),
    loadedIds: new Set(),
    /** Per layer id: the tile textures it owns (destroyed on unload and retirement). */
    textures: new Map(),
    /** Per layer id: the stepFlags of the tiles its viewport selected, at its last load. */
    viewTiles: new Map(),
    retiring: /** @type {string[]} */ ([]),
    layerCallbacks: new Map(),
    resolvers: new Map(),
    error: false,
    /** Estimated texture bytes for one view above which the status warns (advisory). */
    textureWarnBytes: opts.maxTextureBytes ?? DEFAULT_TEXTURE_BYTES,
    /**
     * The selection being loaded right now (a variable switch, or an init, member or level
     * change in flight), tracked apart from `info`, which stays the committed one until the
     * change lands. Init, level and step controls act on this, not on `info`.
     */
    requested: /** @type {import("./lib/pending.js").Selection | null} */ (null),
    /** The selection Retry applies: one that failed or was stopped while loading. */
    failed: /** @type {import("./lib/pending.js").Selection | null} */ (null),
    /** The init time (ms) the user chose, kept across variable switches; null: latest usable. */
    explicitInit: /** @type {number | null} */ (null),
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
    retryBtn.hidden = state !== "error" && state !== "stopped";
    stopBtn.hidden = state !== "loading";
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
      // Back in the layer list before any frame went without it (e.g. two slider moves in
      // one frame, away from a block and back): deck kept that layer, tiles and all.
      if (s.liveIds.has(id)) continue;
      for (const t of s.textures.get(id) ?? []) t.destroy();
      s.textures.delete(id);
      s.viewTiles.delete(id);
      s.layerCallbacks.delete(id);
      s.loadedIds.delete(id);
    }
    if (el.dataset.state === "loading") judgeView();
  }

  /**
   * Once every live layer's viewport has loaded: `ready`, or `empty` when none of the
   * tiles in view holds a value at the chosen step. Loaded is not the same as drawn: a run
   * still being written has chunks that hold only missing values past the lead it has
   * reached. Not while a selection is being applied: the layers on screen are the
   * previous one's.
   */
  function judgeView() {
    if (!s.info || s.error || s.requested || s.liveIds.size === 0) return;
    if (![...s.liveIds].every((id) => s.loadedIds.has(id))) return;
    mark("ready");
    const { block } = selectionFor(s.info, s.pinnedIdx, s.stepIndex);
    const tiles = [...s.liveIds].flatMap((id) => s.viewTiles.get(id) ?? []);
    const v = viewData(tiles, s.stepIndex - block.start);
    if (v.state === "empty") setState("empty", emptyMessage(block, v.last));
    else setState("ready", "Ready");
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
          onData: (data) => {
            if (live()) settle(info, data);
          },
          stop: () => s.abort.signal,
          stopped: () => s.stopped,
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
            if (el.dataset.state === "ready" || el.dataset.state === "empty") setState("loading", "Loading tiles…");
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
          s.failed = null; // the error on screen is now this one; Retry retries tiles
          setState("error", `Some tiles failed to load (${errText(e)}). Areas shown blank have no data drawn.`);
        },
        // Called with the tiles the viewport selected, each time that set changes and has
        // loaded, pans served from the cache included.
        onViewportLoad: (tiles) => {
          if (!live()) return;
          s.loadedIds.add(id);
          s.viewTiles.set(id, (tiles ?? []).map((t) => t.content?.flags).filter(Boolean));
          mark("viewportLoaded");
          // A pan within the cache doesn't pass through loading: judge the new view here.
          if (el.dataset.state === "ready" || el.dataset.state === "empty") judgeView();
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
    // GPU-memory estimate: a warning beside the status, never a reason to stop loading.
    let warn = false;
    if (info && range && s.colormap) {
      const { block } = selectionFor(info, s.pinnedIdx, s.stepIndex);
      const need = viewTextureBytes(info, block);
      s.textureNeed = need;
      warn = need > s.textureWarnBytes;
      if (warn) {
        gpuWarning.textContent = `GPU memory: this view needs about ${(need / 1e9).toFixed(1)} GB for ${info.path.slice(1)}, which may be more than this device can hold. Loading anyway; zoom in if the page slows or the map goes blank.`;
      }
    }
    gpuWarning.hidden = !warn;
    if (info && range && s.colormap) {
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
            // The tile facade's view for whole-grid chunks (virtual stores), else the array.
            node: info.node,
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
            maxRequests: opts.maxRequests ?? MAX_REQUESTS,
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
    const m = info.pinned.findIndex((p) => p.name === info.cls.member);
    if (m >= 0) parts.push(h("span", { textContent: info.pinned[m].labels[s.pinnedIdx[m]], dataset: { label: "member" } }));
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
          ? "no values in the sample; updates when the view shows more"
          : range.status === "flat"
            ? "sample is one value; updates when the view shows more"
            : "2–98% of a sample";
  }

  /** A select in the controls row, labelled like the other controls. */
  function selectControl(name, options, onChange) {
    const sel = h("select", { ariaLabel: name }, options.map(([value, text, selected]) => h("option", { value: String(value), textContent: text, selected })));
    sel.addEventListener("change", () => onChange(Number(sel.value)));
    extrasEl.append(h("label", {}, [h("span", { textContent: name }), sel]));
  }

  /** The init, member and level selects and the slider, for what is drawn. */
  function buildControls() {
    const { info } = s;
    extrasEl.replaceChildren();
    if (!info) {
      slider.disabled = true;
      return;
    }
    const path = info.path;
    if (info.init) {
      const { times, index } = info.init;
      const options = initOptions(times.length, info.init.default).map((j) => [j, formatUtc(times[j]), j === index]);
      selectControl("Init time", options, (j) => void change({ type: "init", path, index: j }));
    }
    info.pinned.forEach((p, i) => {
      const options = p.labels.map((text, j) => [j, text, j === s.pinnedIdx[i]]);
      selectControl(p.name, options, (j) => void change({ type: "pinned", path, i, j }));
    });
    sliderRow.hidden = !info.step;
    if (info.step) {
      sliderLabelText.textContent = slider.ariaLabel = info.step.kind === "time" ? "Time" : "Lead time";
      slider.max = String(info.step.n - 1);
      slider.value = String(s.stepIndex);
      slider.disabled = false;
    }
  }

  /** The drawn selection in words, e.g. "temperature_2m, init 2026-09-25 00:00 UTC, member 0, lead +480 h". */
  function selectionText() {
    const { info } = s;
    const v = variables.find((x) => x.path === info.path);
    const parts = [v?.name ?? info.path.slice(1)];
    if (info.init) parts.push(`init ${formatUtc(info.init.times[info.init.index])}`);
    info.pinned.forEach((p, i) => parts.push(p.labels[s.pinnedIdx[i]]));
    if (info.step) parts.push(stepText(s.stepIndex));
    return parts.join(", ");
  }

  const stepText = (i) => (s.info.step.kind === "lead" ? `lead ${formatLead(s.info.step.ms[i])}` : `time ${formatUtc(s.info.step.ms[i])}`);

  /**
   * Every tile in view loaded, and none holds a value at the chosen step. `last` is the
   * block's last step with values in view (-1 if none), for a hint when the data stops
   * part way through, as it does in a run that is still being written.
   */
  function emptyMessage(block, last) {
    const { info } = s;
    let msg = `No data for ${selectionText()}: nothing in view has values at this step.`;
    if (info.step && last >= 0 && block.start + last < s.stepIndex) msg += ` Values in view end at ${stepText(block.start + last)}.`;
    if (info.init && info.step?.kind === "lead") msg += " This run may not be written this far yet; an earlier init time may have it.";
    return msg;
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

  const rangeKey = (info, pinnedIdx) => `${opts.id}|${info.path}|${pinnedKey(pinnedIdx)}`;

  /**
   * Frozen per dataset + variable + pinned indices once the sample varies. A constant or
   * empty sample (e.g. no rain at the initial view) is provisional and not frozen:
   * settle() replaces it from the first varying tile after a pan, zoom or step.
   */
  function rangeFor(info, pinnedIdx, ref) {
    const key = rangeKey(info, pinnedIdx);
    if (s.ranges.has(key)) return s.ranges.get(key);
    const r = initialRange(info.units, ref.data);
    if (!r.provisional) s.ranges.set(key, r);
    return r;
  }

  /** A loaded tile block for the current selection: settle a provisional range from it. */
  function settle(info, data) {
    if (info !== s.info) return;
    const r = settleRange(s.range, data);
    if (!r) return;
    s.ranges.set(rangeKey(info, s.pinnedIdx), r);
    s.range = r;
    updateLegend();
    render();
  }

  /** What is drawn, as a selection (null if nothing is). */
  function committed() {
    return s.info ? { path: s.info.path, initIndex: s.info.init?.index ?? null, pinnedIdx: s.pinnedIdx, stepIndex: s.stepIndex } : null;
  }

  /** A variable switch: its defaults, and the init the user chose if it has that run. */
  const openVariable = (path) => ({ path, initIndex: null, pinnedIdx: null, stepIndex: null });

  /**
   * Commit a selection atomically, or show why it failed. Null fields take their defaults:
   * the probed latest usable init (or the init time the user chose, if this variable has
   * it), each dim's default index, and for a new variable an opening step with data.
   * @param {import("./lib/pending.js").Selection} req
   * @param {string} busyMsg
   */
  async function apply(req, busyMsg) {
    resume();
    // The dropdown always shows the selection being applied (Retry after a failed switch
    // re-applies a choice the dropdown had been restored away from).
    varSelect.value = req.path;
    const g = ++s.gen;
    s.requested = req;
    const newVar = req.path !== s.info?.path;
    if (newVar) {
      // Switching variable: the old variable's selects and slider go at once, so they
      // can't change a selection that is no longer the requested one.
      extrasEl.replaceChildren();
      slider.disabled = true;
    }
    setState("loading", busyMsg);
    try {
      let info = newVar ? await s.source.describe(req.path, { center }) : s.info;
      if (g !== s.gen) return;
      mark("described");
      const maxDim = s.device.limits.maxTextureDimension2D;
      if (info.tile.w > maxDim || info.tile.h > maxDim) {
        throw new Error(`this device's GPU can't hold a ${info.tile.w}×${info.tile.h} tile (max texture size ${maxDim})`);
      }
      let initIndex = req.initIndex;
      if (initIndex === null && info.init && s.explicitInit !== null) {
        const j = info.init.times.indexOf(s.explicitInit);
        if (j >= 0) initIndex = j;
      }
      if (info.init && initIndex !== null && initIndex !== info.init.index) info = { ...info, init: { ...info.init, index: initIndex } };
      const idx = req.pinnedIdx ?? info.pinned.map((p) => p.default);
      // A new variable, init, member or level drops the decoded whole-grid chunks of the
      // old one (virtual stores); slider steps of the same selection stay cached.
      const sameSlice = !newVar && info.init?.index === s.info.init?.index && pinnedKey(idx) === pinnedKey(s.pinnedIdx);
      if (s.info?.facade && !sameSlice) s.info.facade.clear();
      // A chosen step (same variable: the step shown) is kept; a new variable opens at its default.
      let stepIndex = req.stepIndex ?? (newVar ? (info.step?.index ?? 0) : s.stepIndex);
      if (info.step) stepIndex = Math.min(stepIndex, info.step.n - 1);
      const signal = s.abort.signal;
      let ref = await reference(info, idx, stepIndex, signal);
      if (g !== s.gen) return;
      let noData = info.step?.noData ? `No data found for the latest ${info.step.name} (${info.step.log.join("; ")})` : null;
      if (newVar && info.step && req.stepIndex === null) {
        // Open on a step that has data: 24 h means and accumulations are NaN at
        // +0 h, and an analysis's newest time can still be unwritten. Only when opening a
        // variable: an init, member or level the user chose keeps the step they are on.
        const k = stepWithData(ref.data, ref.block.stop - ref.block.start, info.step.kind === "time" ? "last" : "first");
        const [row, col] = info.centerCell;
        const readSteps = async (start, stop) => {
          const { sel } = selectionFor(info, idx, start);
          sel[info.step.name] = zarr.slice(start, stop);
          return (await readTileBlock(info, sel, row, col, signal)).data;
        };
        let found = null;
        if (k >= 0) stepIndex = ref.block.start + k;
        else if (info.step.kind === "time" && !noData) {
          // The probed chunk exists but this window is empty: search the rest of the
          // chunk, then earlier chunks, and say so rather than draw a blank field.
          found =
            ref.block.start > 0
              ? await findLatestData({ index: ref.block.start - 1, chunkLen: info.step.chunk, readSteps })
              : { index: null, log: [] };
          if (found.index === null) {
            noData = `No data found in the latest ${info.step.name} values (steps ${ref.block.start}..${ref.block.stop - 1} are empty${found.log.length ? `; ${found.log.join("; ")}` : ""})`;
          }
        } else if (info.step.kind === "lead" && !noData) {
          // The opening block is empty (e.g. an accumulation at +0 h; a virtual store's
          // block is that one step): a bounded search of the following steps.
          found = await findFirstData({ from: ref.block.stop, n: info.step.n, blockLen: Math.min(info.step.chunk, s.window), readSteps });
          if (found.index === null) {
            noData = `No usable data in the first ${info.step.name} steps (steps ${ref.block.start}..${ref.block.stop - 1} are empty${found.log.length ? `; ${found.log.join("; ")}` : ""})`;
          }
        }
        if (g !== s.gen) return;
        if (found?.index != null) {
          // Labels, reference (prefetch) and colour range all follow the new step.
          stepIndex = found.index;
          ref = await reference(info, idx, stepIndex, signal);
          if (g !== s.gen) return;
        }
      }
      const range = rangeFor(info, idx, ref);
      s.prefetch = { base: baseKey(info, idx, ref.block), r0: ref.r0, c0: ref.c0, data: ref.data };
      mark("rangeReady");
      Object.assign(s, { info, pinnedIdx: idx, stepIndex, range, requested: null, failed: null });
      if (req.explicitInit && info.init) s.explicitInit = info.init.times[info.init.index];
      s.retry++;
      buildControls();
      updateLabels();
      updateLegend();
      if (noData) {
        setState("empty", noData);
      } else {
        setState("loading", "Loading tiles…");
      }
      render();
    } catch (e) {
      if (g !== s.gen || s.destroyed) return;
      console.error("[explorer]", e);
      const v = variables.find((x) => x.path === req.path);
      s.requested = null;
      s.failed = req;
      if (s.info) {
        // Something is drawn: it stays, and the dropdown, selects, slider, labels and
        // legend all go back to it, so they describe what is drawn. Retry retries the
        // failed choice.
        restoreControls();
        setState("error", `Could not load ${v?.name ?? req.path}: ${errText(e)}. Still showing the previous selection.`);
        return;
      }
      // Nothing loaded (first load): no field, no colours, and the error names the choice.
      Object.assign(s, { info: null, range: null });
      restoreControls();
      setState("error", `Could not load ${v?.name ?? req.path}: ${errText(e)}`);
    }
  }

  /** Controls, labels, legend and layers back to what is drawn (after a failure or Stop). */
  function restoreControls() {
    if (s.info) varSelect.value = s.info.path;
    buildControls();
    updateLabels();
    updateLegend();
    render();
  }

  /** An init, member or level choice: applied to the selection being loaded, if any. */
  function change(c) {
    const next = changeSelection(s.requested, committed(), c);
    if (!next) return;
    return apply(next, "Loading…");
  }

  function setStep(i) {
    if (!s.info?.step) return;
    if (!stepAccepted(s.requested, committed())) return; // another variable is being loaded
    slider.value = String(i);
    if (s.requested) {
      // An init, member or level change of this variable is loading: the step becomes part
      // of it, and it starts again, so its reference read, the step it commits and a Retry
      // all follow this move.
      const next = changeSelection(s.requested, committed(), { type: "step", path: s.info.path, index: i });
      if (next) void apply(next, "Loading…");
      return;
    }
    s.failed = null; // moving on from a failed change: Retry no longer means "retry that change"
    const { chunk, n } = s.info.step;
    const newBlock = blockRange(i, chunk, s.window, n).start !== blockRange(s.stepIndex, chunk, s.window, n).start;
    const wasStopped = s.stopped;
    resume(); // a new step is a new selection
    s.stepIndex = i;
    updateLabels();
    // A new block is a fresh layer, as is every layer after a resume, so either retries
    // after an error or Stop.
    if (newBlock || wasStopped) setState("loading", "Loading tiles…");
    else if (!s.error) setState("loading", "Loading…");
    render();
  }

  /**
   * Leave the stopped state: a fresh abort controller, and fresh layers (a new retry
   * count), so tiles that Stop aborted or refused load again. Completed textures stay drawn
   * until their replacements load.
   */
  function resume() {
    if (!s.stopped) return;
    s.stopped = false;
    s.abort = new AbortController();
    s.retry++;
  }

  varSelect.addEventListener("change", () => void apply(openVariable(varSelect.value), "Opening variable…"));
  slider.addEventListener("input", () => setStep(Number(slider.value)));
  retryBtn.addEventListener("click", () => {
    resume();
    if (!s.started) return void start();
    if (s.failed) return void apply(s.failed, "Retrying…");
    if (!s.info) return void apply(openVariable(varSelect.value), "Retrying…");
    s.retry++;
    setState("loading", "Retrying…");
    render();
  });
  stopBtn.addEventListener("click", () => {
    // Abort every read in flight (tiles, the reference read, probes' results are dropped
    // by the generation bump) and keep what is drawn. Retry, or any new choice, resumes.
    const req = s.requested;
    s.gen++;
    s.stopped = true;
    s.abort.abort();
    // Running whole-grid reads abort now, and queued ones never start.
    s.info?.facade?.clear();
    s.requested = null;
    if (req) s.failed = req;
    restoreControls();
    setState(
      "stopped",
      s.info ? "Stopped. What had loaded stays; Retry loads the rest." : "Stopped before anything was drawn. Retry to load the map.",
    );
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

  /** A virtual chunk read failed upstream and is being retried (the cause may be hidden by CORS). */
  function onUpstreamRetry({ url, attempt }) {
    if (s.destroyed || el.dataset.state !== "loading") return;
    statusEl.textContent = `Upstream request failed (${new URL(url).host}), retrying (attempt ${attempt + 1})…`;
  }

  async function start() {
    const g = ++s.gen;
    setState("loading", "Opening the data store…");
    try {
      const device = await deviceReady;
      if (g !== s.gen || s.destroyed) return;
      s.window = Math.max(1, Math.min(opts.maxTextureLayers ?? DEFAULT_TEXTURE_LAYERS, device.limits.maxTextureArrayLayers));
      const [store] = await Promise.all([
        openStore(opts.href, { signal: s.abort.signal, onRetry: onUpstreamRetry }),
        s.colormap ? null : initColormap(device),
      ]);
      if (g !== s.gen || s.destroyed) return;
      s.store = store;
      mark("storeOpen");
      s.source = makeSource(store, opts);
      const reasons = await Promise.all(variables.map(async (v) => unsupportedReason(await store.getMeta(v.path))));
      // Stop (or destroy) while the metadata was read: stay stopped; Retry starts again.
      if (g !== s.gen || s.destroyed) return;
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
      s.started = true;
      await apply(openVariable(first.path), "Opening variable…");
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
      s.info?.facade?.clear();
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
        init: info?.init ? { index: info.init.index, default: info.init.default, log: info.init.log } : null,
        pinnedIdx: info ? s.pinnedIdx : null,
        requested: s.requested,
        step: info?.step ? { name: info.step.name, index: s.stepIndex, n: info.step.n, chunk: info.step.chunk, log: info.step.log } : null,
        window: s.window,
        textureNeed: s.textureNeed ?? null,
        textureWarnBytes: s.textureWarnBytes,
        gpuWarning: gpuWarning.hidden ? null : gpuWarning.textContent,
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
