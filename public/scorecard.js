// Client-side scorecard charts: DuckDB-WASM for parquet queries, Observable Plot for rendering.

const STATS_URL = "https://assets.dynamical.org/scorecard/statistics.parquet";
const ASOS_BASE = "https://data.source.coop/dynamical/asos-parquet";

// Color for each published model, and the legend order. Bars reorder by score
// within every lead time, so color is what identifies a model; it must not depend
// on which other models a chart happens to hold. Every model in
// statistics.parquet is pinned here. AIFS ENS, AIFS Single and WeatherNext keep
// the colors the country page gave them back when the rest were colored from the
// fallback list by position, which shifted them on state and station pages
// whenever HRDPS was present; HRDPS, which the country page never shows, takes
// an unused color.
export const MODEL_STYLE = new Map([
  ["ECMWF IFS ENS", "#029E73"],
  ["NOAA GEFS", "#0173B2"],
  ["NOAA GFS", "#56B4E9"],
  ["NOAA HRRR", "#DE8F05"],
  ["ECMWF AIFS ENS", "#CC79A7"],
  ["ECMWF AIFS Single", "#D55E00"],
  ["Google WeatherNext 2, virtual", "#F0E442"],
  ["ECCC HRDPS", "#CA9161"],
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
// `better` is the direction a metric improves in, and it decides the order bars
// are drawn in (best first within each lead time):
//   "lower"  — errors: smaller is better.
//   "higher" — skill scores: larger is better, negative values included.
//   "target" — closest to `refValue` is best (Bias at 0, Frequency Bias at 1),
//              measured as plain |value − refValue|, so a Frequency Bias of 0.5
//              ranks ahead of 2.
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
// alphabetically. It orders the legend, assigns fallback colors, and breaks ties
// between equal scores, so none of those move when the ranking does.
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
// NaN) is Infinity, so it ranks after every real score instead of coercing to 0
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

// Give each row a `slot`, its 0-based position best-first among the rows that
// share its lead time. Every lead is ranked on its own, since which model is
// best changes with lead time. Slots are unique even for tied scores, so tied
// bars sit side by side rather than on top of each other.
export function rankWithinLead(rows, cfg) {
  const byLead = new Map();
  for (const row of rows) {
    if (!byLead.has(row.lead_time_days)) byLead.set(row.lead_time_days, []);
    byLead.get(row.lead_time_days).push(row);
  }
  const ranked = [];
  for (const leadRows of byLead.values()) {
    leadRows
      .map((row) => ({ row, distance: scoreDistance(row.value, cfg) }))
      .sort(
        (a, b) =>
          // Infinity − Infinity is NaN, so compare missing values explicitly.
          (a.distance === b.distance ? 0 : a.distance < b.distance ? -1 : 1) ||
          compareModels(a.row.model, b.row.model)
      )
      .forEach(({ row }, slot) => ranked.push({ ...row, slot }));
  }
  return ranked;
}

export function orderNote(cfg) {
  const best =
    cfg.better === "target"
      ? `closest to ${cfg.refValue} is best`
      : `${cfg.better} is better`;
  return `Bars run best to worst within each lead time; ${best}.`;
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

    // Derive available models from the data rather than a hardcoded list.
    const colors = modelColors(data.map((d) => d.model));

    const varUnits = variable === "temperature_2m" ? "°C" : "mm/s";
    const yLabel =
      cfg.unitType === "unitless"
        ? cfg.label
        : `${cfg.label} [${varUnits}]`;

    const chart = Plot.plot({
      width: container.clientWidth || 600,
      height: METRIC_HEIGHT,
      ...CHART_MARGINS,
      fx: { label: "Forecast lead time (days)", padding: 0.2 },
      x: { axis: null, padding: 0.1 },
      y: { label: yLabel, grid: true, labelArrow: "none" },
      color: {
        legend: true,
        domain: colors.domain,
        range: colors.range,
        tickFormat: legendLabel,
      },
      caption: orderNote(cfg),
      marks: [
        // x is the rank within the lead, not the model: the x scale is shared
        // across facets, so ordering by model could only give every lead the
        // same order. A lead with fewer models leaves its trailing slots empty.
        Plot.barY(rankWithinLead(data, cfg), {
          fx: "lead_time_days",
          x: "slot",
          y: "value",
          fill: "model",
          title: (d) => `${legendLabel(d.model)}: ${d.value?.toPrecision(3)}`,
          tip: false,
        }),
        Plot.ruleY([cfg.refValue]),
      ],
    });

    container.replaceChildren(chart);
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
