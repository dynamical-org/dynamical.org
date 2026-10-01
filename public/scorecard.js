// Client-side scorecard charts: DuckDB-WASM for parquet queries, Observable Plot for rendering.

const STATS_URL = "https://assets.dynamical.org/scorecard/statistics.parquet";
const ASOS_BASE = "https://data.source.coop/dynamical/asos-parquet";

// Color for each published model, and the legend and bar order. Color is what
// ties a bar to its legend entry, so it must not depend on which other models a
// chart happens to hold. Every model in statistics.parquet is pinned here. AIFS
// ENS, AIFS Single and WeatherNext keep the colors the country page gave them
// back when the rest were colored from the fallback list by position, which
// shifted them on state and station pages whenever HRDPS was present; HRDPS,
// which the country page never shows, takes an unused color.
//
// The order is curated: producer groups NOAA, ECMWF, then the rest
// alphabetically (ECCC, Google); within a producer, a family stays together,
// deterministic before ensemble — GFS, GEFS, then the regional HRRR; IFS, then
// AIFS. A model added here goes beside its family. One that is published before
// it is listed falls after every listed model, alphabetically.
export const MODEL_STYLE = new Map([
  ["NOAA GFS", "#56B4E9"],
  ["NOAA GEFS", "#0173B2"],
  ["NOAA HRRR", "#DE8F05"],
  ["ECMWF IFS ENS", "#029E73"],
  ["ECMWF AIFS Single", "#D55E00"],
  ["ECMWF AIFS ENS", "#CC79A7"],
  ["ECCC HRDPS", "#CA9161"],
  ["Google WeatherNext 2, virtual", "#F0E442"],
]);
// A model published before it is pinned above still gets a color, but one taken
// by position among the unpinned models in the chart, so it can differ between
// charts until it is added to MODEL_STYLE.
const FALLBACK_COLORS = ["#999999", "#FBAFE4"];
const OBS_COLORS = { temperature_2m: "#591e71", precipitation_surface: "#253494" };
const VAR_LABELS = { temperature_2m: "Temperature", precipitation_surface: "Precipitation" };
const CHART_MARGINS = { marginLeft: 60, marginBottom: 30, marginRight: 20 };
const METRIC_HEIGHT = 360;
const OBS_HEIGHT = 300;

// Whole state boundaries, not station counts: us-atlas@3 states-10m checked
// against the HRDPS rotated grid on 2026-09-21, without an edge tolerance.
const HRDPS_STATES = new Set([
  "CT", "DC", "DE", "IA", "ID", "IN", "MA", "MD", "ME", "MI", "MN", "MT",
  "ND", "NH", "NJ", "NY", "OH", "OR", "PA", "RI", "SD", "VA", "VT", "WA",
  "WI", "WV",
]);

export function modelCoversRegion(model, { scope = "country", stateAbbr } = {}) {
  if (model !== "ECCC HRDPS" && model !== "ECCC HRDPS (bc)") return true;
  return scope === "station" || (scope === "state" && HRDPS_STATES.has(stateAbbr));
}

// The parquet names a model after its dataset, so a virtual product arrives as
// "Google WeatherNext 2, virtual". The legend drops the access pattern; the
// color domain keeps the full name so series stay distinct.
export function legendLabel(model) {
  return model.replace(/, virtual(?=( \(bc\))?$)/, "");
}

// DuckDB exposes parquet durations as their encoded integers. The writer now
// pins both durations to nanoseconds; accept the prior microsecond window
// encoding as well so publishing the new file and deploying this query can
// happen in either order.
const MICROSECONDS_PER_DAY = 86_400_000_000n;
const NANOSECONDS_PER_DAY = 86_400_000_000_000n;

export function encodedWindowValues(windowDays) {
  const window = BigInt(windowDays);
  return [
    window * MICROSECONDS_PER_DAY,
    window * NANOSECONDS_PER_DAY,
  ];
}

// Per-metric display configuration.
//
// `better` is the direction a metric improves in, and it decides how models rank
// within each lead time:
//   "lower"  — errors: smaller is better.
//   "higher" — skill scores: larger is better, negative values included.
//   "target" — closest to `refValue` is best (Bias at 0, Frequency Bias at 1),
//              measured as plain |value − refValue|, so a Frequency Bias of 0.5
//              beats 2.
// `refValue` is where the chart draws its reference rule. It is the optimum only
// for "target" metrics; for the skill scores it marks no skill, not perfection.
export const METRIC_CONFIG = {
  RMSE:          { label: "RMSE",                    unitType: "standard", refValue: 0, better: "lower" },
  RMSE_bc:       { label: "RMSE (bias-corrected)",   unitType: "standard", refValue: 0, better: "lower" },
  MAE:           { label: "MAE",                     unitType: "standard", refValue: 0, better: "lower" },
  MAE_bc:        { label: "MAE (bias-corrected)",    unitType: "standard", refValue: 0, better: "lower" },
  Bias:          { label: "Bias",                    unitType: "standard", refValue: 0, better: "target" },
  CRPS:          { label: "CRPS",                    unitType: "standard", refValue: 0, better: "lower" },
  CRPS_bc:       { label: "CRPS (bias-corrected)",   unitType: "standard", refValue: 0, better: "lower" },
  ETS:           { label: "ETS",                     unitType: "unitless", refValue: 0, better: "higher" },
  FrequencyBias: { label: "Frequency Bias",          unitType: "unitless", refValue: 1, better: "target" },
  HSS:           { label: "HSS",                     unitType: "unitless", refValue: 0, better: "higher" },
  FSS:           { label: "FSS",                     unitType: "unitless", refValue: 0, better: "higher" },
};

// Which metrics are available for each variable, and which is the default.
export const VARIABLE_METRICS = {
  temperature_2m:       ["RMSE", "RMSE_bc", "MAE", "MAE_bc", "Bias", "CRPS", "CRPS_bc"],
  precipitation_surface: ["MAE", "Bias", "CRPS", "ETS", "FrequencyBias", "HSS", "FSS"],
};

export const DEFAULT_METRIC = {
  temperature_2m:       "RMSE",
  precipitation_surface: "MAE",
};

// Stable model order: pinned models in MODEL_STYLE order, then the rest
// alphabetically. It orders the legend, assigns fallback colors, and places the
// bars in every lead time, so a model keeps its slot whichever model ranks first.
export function compareModels(a, b) {
  const knownOrder = [...MODEL_STYLE.keys()];
  const ai = knownOrder.indexOf(a);
  const bi = knownOrder.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

// The color scale for the models a chart holds: `domain` in stable order (which
// is also the legend order) and `range` the matching colors.
export function modelColors(models) {
  const domain = [...new Set(models)].sort(compareModels);
  let fallbackIdx = 0;
  const range = domain.map((m) => {
    if (MODEL_STYLE.has(m)) return MODEL_STYLE.get(m);
    return FALLBACK_COLORS[fallbackIdx++ % FALLBACK_COLORS.length];
  });
  return { domain, range };
}

// How far a value is from the best possible score, in the metric's direction:
// smaller is better. A missing or non-finite value (null from an all-null AVG,
// NaN) is Infinity, so it loses to every real score instead of coercing to 0
// — which would read as a perfect error — or winning a higher-is-better metric.
export function scoreDistance(value, cfg) {
  if (typeof value !== "number" || !Number.isFinite(value)) return Infinity;
  switch (cfg.better) {
    case "lower": return value;
    case "higher": return -value;
    case "target": return Math.abs(value - cfg.refValue);
    default: throw new Error(`unknown metric direction: ${cfg.better}`);
  }
}

// Give each row its `rank` among the rows that share its lead time: 1 is best,
// and every lead is ranked on its own, since which model is best changes with
// lead time. Tied scores share a rank and the next rank skips past them (1, 1,
// 3) — Bias of equal size and opposite sign is a tie. A missing value has no
// rank, so a lead with no real scores ranks nothing.
export function rankWithinLead(rows, cfg) {
  const distances = new Map();
  for (const { lead_time_days: lead, value } of rows) {
    const distance = scoreDistance(value, cfg);
    if (distance === Infinity) continue;
    if (!distances.has(lead)) distances.set(lead, []);
    distances.get(lead).push(distance);
  }
  return rows.map((row) => {
    const distance = scoreDistance(row.value, cfg);
    const rank =
      distance === Infinity
        ? null
        : 1 + distances.get(row.lead_time_days).filter((d) => d < distance).length;
    return { ...row, rank };
  });
}

// The chart caption: how to rank a lead time, or which lead the legend ranks.
export function rankNote(cfg, lead = null) {
  const best =
    cfg.better === "target"
      ? `closest to ${cfg.refValue}`
      : cfg.better === "lower"
        ? "lowest"
        : "highest";
  return lead === null
    ? `Hover or tap a lead time to rank it in the legend; ${best} is best.`
    : `The legend ranks day ${lead}'s top three; ${best} is best.`;
}

// Loading, empty, and error states all render as a message sized to the chart's
// own footprint (styled by `.scorecard-chart p` in main.css) so a chart that
// never arrives leaves a labelled gap instead of a single line of text.
function showStatus(container, height, message) {
  container.style.setProperty("--chart-height", `${height}px`);
  const p = document.createElement("p");
  p.textContent = message;
  container.replaceChildren(p);
}

// Chart failures happen inside try/catch, and Sentry's global handlers only see
// uncaught exceptions and unhandled rejections — a caught error that reaches
// `console.error` is invisible in the dashboard. Every failure here needs an
// explicit capture or nobody finds out.
//
// The layout injects Sentry only on the production host and the loader buffers
// calls made before the SDK arrives, so this is a no-op in dev and on previews.
function captureError(error, context) {
  // Log the context too, not just the error: Sentry is deliberately absent in dev
  // and on previews, so the console is the only place this information exists
  // there — and a bare stack trace does not say which chart produced it.
  console.error(error, context);
  window.Sentry?.captureException?.(error, {
    tags: { feature: "scorecard" },
    extra: context,
  });
}

let _dbReady = null;

export function initDB() {
  if (_dbReady) return _dbReady;
  _dbReady = (async () => {
    // duckdb-wasm's bundle selection references the global WebAssembly object
    // unconditionally (via wasm-feature-detect's exceptions() check), which
    // throws an uncaught ReferenceError rather than reporting "unsupported"
    // on a browser context where WebAssembly is absent entirely (e.g. Safari
    // Lockdown Mode). Fail fast with a catchable error instead.
    if (typeof WebAssembly === "undefined") {
      throw new Error("WebAssembly is not available in this browser");
    }
    const duckdb = await import(
      "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm"
    );
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], {
        type: "text/javascript",
      })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    return db;
  })();
  return _dbReady;
}

async function query(sql) {
  const db = await initDB();
  const conn = await db.connect();
  try {
    const table = await conn.query(sql);
    return table.toArray().map((row) => {
      const obj = {};
      for (const field of table.schema.fields) {
        let v = row[field.name];
        if (typeof v === "bigint") v = Number(v);
        obj[field.name] = v;
      }
      return obj;
    });
  } finally {
    await conn.close();
  }
}

let _Plot = null;
async function getPlot() {
  if (!_Plot)
    _Plot = await import(
      "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm"
    );
  return _Plot;
}

// ── Metric bar chart ────────────────────────────────────────────────────────

// An empty result is ordinary: a station that was offline for the whole lookback
// has no rows for it. What is not ordinary is the requested window being absent
// from the file altogether, because the WHERE clause reaches it by dividing a
// duration column by a fixed constant (see WINDOW_PER_DAY). When the publishing
// side changes that column's precision every query still succeeds and every
// chart quietly empties — which is exactly what shipped on 2026-07-19 and went
// unnoticed for nine days.
//
// So the probe asks which windows the file actually holds rather than re-running
// the query without its station filter. Testing for the window value globally is
// what keeps it quiet: a stale station legitimately has rows for the long windows
// and none for the short ones, and re-querying per station would report that as
// drift on every visit.
// The inventory is memoized, so asking on every empty result costs one query per
// page rather than one per chart.
let _windowDaysInFile = null;
const _reportedWindows = new Set();
let _probeFailureReported = false;

async function windowIsPublished(windowDays, context) {
  try {
    // Memoize the promise, but never the rejection: caching a failed probe would
    // leave every later empty chart answering from it, which both disables drift
    // detection for the rest of the page's life and re-reports the same transient
    // failure once per chart and per selector change.
    let inventory = _windowDaysInFile;
    if (!inventory) {
      inventory = query(
        `SELECT DISTINCT CASE
          WHEN "window" > ${365n * MICROSECONDS_PER_DAY}
            THEN "window" / ${NANOSECONDS_PER_DAY}
          ELSE "window" / ${MICROSECONDS_PER_DAY}
        END AS days FROM '${STATS_URL}'`
      );
      inventory.catch(() => {
        if (_windowDaysInFile === inventory) _windowDaysInFile = null;
      });
      _windowDaysInFile = inventory;
    }
    const available = (await inventory).map((row) => row.days);
    // Coerce: the SQL above tolerates a string window, `includes` does not, and a
    // caller passing "180" would otherwise be reported as drift.
    if (available.includes(Number(windowDays))) return true;

    // Claim the window after the await, not before it. Every chart on the page
    // probes concurrently and they all reach this point before any one of them
    // resolves, so checking here is what keeps a drifted file to one report per
    // window rather than one per chart.
    if (!_reportedWindows.has(windowDays)) {
      _reportedWindows.add(windowDays);
      captureError(
        new Error(
          `scorecard: statistics.parquet holds no ${windowDays}-day window`
        ),
        { ...context, windowDays, windowDaysInFile: available.join(", ") }
      );
    }
    return false;
  } catch (e) {
    // The probe is diagnostics. When it cannot answer, claim nothing about our
    // own data and leave the ordinary empty-result message in place. Report it
    // once: a broken probe is one fact, not one per chart.
    if (!_probeFailureReported) {
      _probeFailureReported = true;
      captureError(e, { ...context, windowDays, probe: "window inventory" });
    }
    return true;
  }
}

// One metric's bars: a facet per lead time, every model in the same slot at every
// lead, and each lead's ranking ready to show on the legend. Kept apart from the
// query so a spec can draw rows it chose — ties, gaps, missing values — that the
// live file may not hold on any given day.
export function metricChart(Plot, rows, { cfg, yLabel, width }) {
  // Derive available models from the data rather than a hardcoded list.
  const colors = modelColors(rows.map((d) => d.model));

  const bars = rankWithinLead(rows, cfg);
  const chart = Plot.plot({
    width,
    height: METRIC_HEIGHT,
    ...CHART_MARGINS,
    fx: { label: "Forecast lead time (days)", padding: 0.2 },
    // The x domain is the legend order, shared by every facet, so each model
    // keeps its slot at every lead and a lead it lacks leaves that slot empty.
    x: { axis: null, padding: 0.1, domain: colors.domain },
    y: { label: yLabel, grid: true, labelArrow: "none" },
    color: {
      legend: true,
      domain: colors.domain,
      range: colors.range,
      tickFormat: legendLabel,
    },
    caption: rankNote(cfg),
    marks: [
      Plot.barY(bars, {
        fx: "lead_time_days",
        x: "model",
        y: "value",
        fill: "model",
        title: (d) =>
          `${legendLabel(d.model)}: ${d.value?.toPrecision(3)}${d.rank ? ` (rank ${d.rank})` : ""}`,
        tip: false,
      }),
      Plot.ruleY([cfg.refValue]),
    ],
  });
  rankLegendByLead(chart, bars, colors, cfg);
  return chart;
}

const SVG_NS = "http://www.w3.org/2000/svg";
// Badges go to every model ranked this high or better, so a tie at the cutoff
// badges all of its models: ranks 1, 1, 3, 3 badge four.
const LEGEND_RANKS = 3;

// Turn a legend swatch into a circle of the same color with the model's rank on
// it, or back into its square. Drawn inside the swatch's own 15px <svg>, so the
// legend never reflows: a badge added beside the swatch wrapped legend rows at
// phone width and shifted entries by up to 266px as the pointer crossed leads.
// The numeral is white outlined in near-black on every color, so it reads the
// same way on WeatherNext's yellow as on GEFS's dark blue.
function setRankBadge(swatch, rank, color) {
  swatch.querySelector("g")?.remove();
  swatch.querySelector("rect").style.visibility = rank == null ? "" : "hidden";
  if (rank == null) return;
  const badge = document.createElementNS(SVG_NS, "g");
  badge.innerHTML =
    `<circle cx="7.5" cy="7.5" r="8" fill="${color}"/>` +
    `<text x="7.5" y="7.5" fill="#ffffff" stroke="#111111" stroke-width="2.5" ` +
    `stroke-linejoin="round" paint-order="stroke" text-anchor="middle" ` +
    `dominant-baseline="central" font-size="11" font-weight="700">${rank}</text>`;
  swatch.append(badge);
}

// Selecting a lead time ranks its top three models on the legend, shades the
// lead's group, bolds its label, and names it in the caption; nothing is
// selected until the reader asks. A mouse selects whatever group it is over and
// keeps it while it moves on to read the legend, clearing once it leaves the
// figure. A touch has no hover, so a completed tap selects (a scroll does not)
// and tapping the selected group again clears it. From the keyboard the plot is
// one tab stop: arrows, Home and End move between leads, Escape clears, and so
// does tabbing away, with each choice announced, since the badges alone are not
// read out.
function rankLegendByLead(chart, bars, colors, cfg) {
  const svg = chart.querySelector(":scope > svg");
  const swatches = [...chart.querySelectorAll(":scope > div > span > svg")];
  // The caption holds both its texts in one grid cell and shows one, so it keeps
  // the taller one's height and swapping them never moves the page below.
  const hint = document.createElement("span");
  const named = document.createElement("span");
  chart.querySelector("figcaption").replaceChildren(hint, named);
  const fx = chart.scale("fx");
  const [yBottom, yTop] = chart.scale("y").range;
  const leads = fx.domain;
  const tickLabels = [...svg.querySelectorAll('[aria-label="fx-axis tick label"] text')];
  const ranks = new Map(leads.map((lead) => [lead, new Map()]));
  for (const { lead_time_days: lead, model, rank } of bars) {
    if (rank) ranks.get(lead).set(model, rank);
  }

  const band = document.createElementNS(SVG_NS, "rect");
  band.setAttribute("y", yTop);
  band.setAttribute("height", yBottom - yTop);
  band.setAttribute("width", fx.step);
  band.setAttribute("fill", "currentColor");
  band.setAttribute("fill-opacity", "0.07");
  band.setAttribute("aria-hidden", "true");
  svg.insertBefore(band, svg.querySelector('[aria-label="bar"]'));

  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  chart.append(live);

  // Which input made the current selection decides what ends it: the mouse's
  // ends when it leaves the figure, the keyboard's when focus leaves the plot,
  // and a tap's only on another tap. Whichever input selects last takes over.
  let selected;
  let owner = null;
  const select = (lead, by = owner) => {
    owner = lead === null ? null : by;
    if (lead === selected) return;
    selected = lead;
    band.style.display = lead === null ? "none" : "";
    if (lead !== null) band.setAttribute("x", fx.apply(lead) - (fx.step - fx.bandwidth) / 2);
    tickLabels.forEach((t, i) => (t.style.fontWeight = leads[i] === lead ? "700" : ""));
    hint.textContent = rankNote(cfg);
    named.textContent = rankNote(cfg, lead ?? leads.at(-1));
    (lead === null ? named : hint).style.visibility = "hidden";
    (lead === null ? hint : named).style.visibility = "";
    const badged = [];
    colors.domain.forEach((model, i) => {
      const rank = lead === null ? undefined : ranks.get(lead).get(model);
      const shown = rank <= LEGEND_RANKS;
      setRankBadge(swatches[i], shown ? rank : null, colors.range[i]);
      if (shown) badged.push([rank, legendLabel(model)]);
    });
    const order = badged
      .sort(([a], [b]) => a - b)
      .map(([rank, name]) => `rank ${rank} ${name}`)
      .join(", ");
    live.textContent = lead === null ? "" : `${cfg.label}, day ${lead}: ${order || "no scores"}`;
  };

  // The group whose slot holds the pointer, gaps and lead label included.
  const leadAt = (event) => {
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) * svg.width.baseVal.value) / box.width;
    return leads.find((lead) => Math.abs(fx.apply(lead) + fx.bandwidth / 2 - x) <= fx.step / 2);
  };
  // A pointer focuses the plot on its way to a click; that focus selects
  // nothing, so a tap on the first lead is not undone by focus selecting it.
  let pointerType;
  let pointerFocus = false;
  svg.addEventListener("pointerdown", (e) => {
    pointerType = e.pointerType;
    pointerFocus = true;
  });
  svg.addEventListener("pointercancel", () => (pointerFocus = false));
  svg.addEventListener("pointermove", (e) => {
    const lead = leadAt(e);
    if (e.pointerType === "mouse" && lead !== undefined) select(lead, "mouse");
  });
  chart.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && owner === "mouse") select(null);
  });
  svg.addEventListener("click", (e) => {
    pointerFocus = false;
    if (pointerType === "mouse") return;
    const lead = leadAt(e);
    if (lead !== undefined) select(lead === selected ? null : lead, "touch");
  });
  svg.tabIndex = 0;
  svg.setAttribute(
    "aria-label",
    `${cfg.label} by forecast lead time. Use the arrow keys, Home and End to rank ` +
      "a lead time's models in the legend, and Escape to clear it."
  );
  svg.addEventListener("focus", () => {
    if (!pointerFocus) select(selected ?? leads[0], "keys");
    pointerFocus = false;
  });
  svg.addEventListener("blur", () => {
    // A press dragged off the plot never clicks; don't let it mark the next
    // keyboard focus as the pointer's.
    pointerFocus = false;
    if (owner === "keys") select(null);
  });
  svg.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return select(null);
    const at = leads.indexOf(selected);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: leads.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(leads[Math.max(0, Math.min(leads.length - 1, next))], "keys");
  });
  select(null);
}

export async function renderMetric(
  container,
  { variable, metric, stationIds, windowDays, scope = "country", stateAbbr }
) {
  const resolvedMetric = metric || DEFAULT_METRIC[variable] || "RMSE";
  const cfg = METRIC_CONFIG[resolvedMetric] || METRIC_CONFIG.RMSE;

  showStatus(container, METRIC_HEIGHT, "Loading…");
  try {
    const Plot = await getPlot();
    const encodedWindows = encodedWindowValues(windowDays).join(",");

    let stationFilter = "";
    if (stationIds && stationIds.length > 0) {
      const ids = stationIds.map((id) => `'${id}'`).join(",");
      stationFilter = `AND station_id IN (${ids})`;
    }

    const rows = await query(`
      SELECT
        CAST(lead_time / ${NANOSECONDS_PER_DAY} AS INTEGER) AS lead_time_days,
        model,
        AVG(value) AS value
      FROM '${STATS_URL}'
      WHERE variable = '${variable}'
        AND metric = '${resolvedMetric}'
        AND "window" IN (${encodedWindows})
        ${stationFilter}
      GROUP BY lead_time_days, model
      ORDER BY lead_time_days, model
    `);
    const data = rows.filter(({ model }) => modelCoversRegion(model, { scope, stateAbbr }));

    if (data.length === 0) {
      // Ask before showing anything: a window the file does not hold is our bug,
      // not an empty dataset, and saying "no data" for it tells the reader the
      // opposite of what happened. The container is still showing "Loading…"
      // here, so the answer arrives without a flicker.
      const published = await windowIsPublished(windowDays, {
        variable,
        metric: resolvedMetric,
        // A count, not the ids: a state page passes fifty of them and Sentry
        // already records the URL that names the page. `||`, not `??`: an empty
        // array builds no station filter, so zero ids means every station.
        stations: stationIds?.length || "all",
      });
      showStatus(
        container,
        METRIC_HEIGHT,
        published
          ? `No ${cfg.label} data for the last ${windowDays} days.`
          : "There was an error loading this plot."
      );
      return;
    }

    const varUnits = variable === "temperature_2m" ? "°C" : "mm/s";
    const yLabel =
      cfg.unitType === "unitless"
        ? cfg.label
        : `${cfg.label} [${varUnits}]`;

    container.replaceChildren(
      metricChart(Plot, data, { cfg, yLabel, width: container.clientWidth || 600 })
    );
  } catch (e) {
    captureError(e, {
      chart: "metric",
      variable,
      metric: resolvedMetric,
      windowDays,
      // `||`, not `??`: an empty array builds no station filter, so zero ids
      // means the query covered every station.
      stations: stationIds?.length || "all",
    });
    showStatus(
      container,
      METRIC_HEIGHT,
      `Error loading the ${cfg.label} plot. Try reloading the page.`
    );
  }
}

// ── Observation timeseries ──────────────────────────────────────────────────

export async function renderObs(
  container,
  { station, variable, windowDays }
) {
  const varLabel = VAR_LABELS[variable] || variable;

  showStatus(container, OBS_HEIGHT, "Loading…");
  try {
    const Plot = await getPlot();
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - windowDays);
    const urls = [];
    for (let y = startDate.getFullYear(); y <= now.getFullYear(); y++) {
      urls.push(`'${ASOS_BASE}/year=${y}/data.parquet'`);
    }
    const col = variable === "temperature_2m" ? "tmpc" : "p01m";
    const data = await query(`
      SELECT valid AS t, station, ${col} AS value
      FROM read_parquet([${urls.join(", ")}])
      WHERE station = '${station}'
        AND valid >= '${startDate.toISOString()}'
      ORDER BY valid
    `);

    if (data.length === 0) {
      showStatus(
        container,
        OBS_HEIGHT,
        `No ${varLabel.toLowerCase()} observations for the last ${windowDays} days.`
      );
      return;
    }

    data.forEach((d) => {
      d.t = new Date(d.t);
    });

    const color = OBS_COLORS[variable] || "#333";
    let marks;
    let yLabel;

    if (variable === "temperature_2m") {
      yLabel = "Temperature [°C]";
      marks = [
        Plot.line(data, { x: "t", y: "value", stroke: color, strokeWidth: 1 }),
      ];
    } else {
      yLabel = "Precipitation [mm]";
      const wet = data.filter((d) => d.value > 0);
      marks = [
        Plot.ruleX(wet, { x: "t", y: "value", stroke: color }),
        Plot.ruleY([0]),
      ];
    }

    const chart = Plot.plot({
      width: container.clientWidth || 600,
      height: OBS_HEIGHT,
      ...CHART_MARGINS,
      x: { label: null },
      y: { label: yLabel, grid: true, labelArrow: "none" },
      marks,
    });

    container.replaceChildren(chart);
  } catch (e) {
    captureError(e, { chart: "observations", variable, station, windowDays });
    showStatus(
      container,
      OBS_HEIGHT,
      `Error loading the ${varLabel.toLowerCase()} observation plot. Try reloading the page.`
    );
  }
}
