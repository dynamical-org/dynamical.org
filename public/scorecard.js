// Client-side scorecard charts: DuckDB-WASM for parquet queries, Observable Plot for rendering.

const STATS_URL = "https://assets.dynamical.org/scorecard/statistics.parquet";
const ASOS_BASE = "https://data.source.coop/dynamical/asos-parquet";

// Color for each known model. Order here is the preferred display order.
const MODEL_STYLE = new Map([
  ["ECMWF IFS ENS", "#029E73"],
  ["NOAA GEFS", "#0173B2"],
  ["NOAA GFS", "#56B4E9"],
  ["NOAA HRRR", "#DE8F05"],
]);
const FALLBACK_COLORS = ["#CC79A7", "#D55E00", "#F0E442", "#999999"];
const OBS_COLORS = { temperature_2m: "#591e71", precipitation_surface: "#253494" };
const VAR_LABELS = { temperature_2m: "Temperature", precipitation_surface: "Precipitation" };
const CHART_MARGINS = { marginLeft: 60, marginBottom: 30, marginRight: 20 };
const METRIC_HEIGHT = 360;
const OBS_HEIGHT = 300;

// Durations in statistics.parquet are integers, but the columns don't share a
// precision: lead_time is nanoseconds and "window" is microseconds.
const LEAD_TIME_PER_DAY = 86_400_000_000_000;
const WINDOW_PER_DAY = 86_400_000_000;

// Per-metric display configuration.
export const METRIC_CONFIG = {
  RMSE:          { label: "RMSE",                    unitType: "standard", refValue: 0 },
  RMSE_bc:       { label: "RMSE (bias-corrected)",   unitType: "standard", refValue: 0 },
  MAE:           { label: "MAE",                     unitType: "standard", refValue: 0 },
  MAE_bc:        { label: "MAE (bias-corrected)",    unitType: "standard", refValue: 0 },
  Bias:          { label: "Bias",                    unitType: "standard", refValue: 0 },
  CRPS:          { label: "CRPS",                    unitType: "standard", refValue: 0 },
  CRPS_bc:       { label: "CRPS (bias-corrected)",   unitType: "standard", refValue: 0 },
  ETS:           { label: "ETS",                     unitType: "unitless", refValue: 0 },
  FrequencyBias: { label: "Frequency Bias",          unitType: "unitless", refValue: 1 },
  HSS:           { label: "HSS",                     unitType: "unitless", refValue: 0 },
  FSS:           { label: "FSS",                     unitType: "unitless", refValue: 0 },
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
  console.error(error);
  window.Sentry?.captureException?.(error, {
    tags: { feature: "scorecard" },
    extra: context,
  });
}

let _dbReady = null;

function initDB() {
  if (_dbReady) return _dbReady;
  _dbReady = (async () => {
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
let _windowDaysInFile = null;
const _reportedWindows = new Set();

async function reportUnknownWindow(context) {
  if (_reportedWindows.has(context.windowDays)) return;
  try {
    _windowDaysInFile ??= query(
      `SELECT DISTINCT "window" / ${WINDOW_PER_DAY} AS days FROM '${STATS_URL}'`
    );
    const available = (await _windowDaysInFile).map((row) => row.days);
    if (available.includes(context.windowDays)) return;

    // Re-check after the await. Every chart on the page probes concurrently and
    // they all pass the check above before any of them resolves, so claiming the
    // window here is what keeps one drifted file to one report.
    if (_reportedWindows.has(context.windowDays)) return;
    _reportedWindows.add(context.windowDays);
    captureError(
      new Error(
        `scorecard: statistics.parquet holds no ${context.windowDays}-day window`
      ),
      { ...context, windowDaysInFile: available.join(", ") }
    );
  } catch (e) {
    // Diagnostics must not become the visible failure: the chart has already
    // shown its own message by the time this runs.
    captureError(e, { ...context, probe: "window inventory" });
  }
}

export async function renderMetric(
  container,
  { variable, metric, stationIds, windowDays }
) {
  const resolvedMetric = metric || DEFAULT_METRIC[variable] || "RMSE";
  const cfg = METRIC_CONFIG[resolvedMetric] || METRIC_CONFIG.RMSE;

  showStatus(container, METRIC_HEIGHT, "Loading…");
  try {
    const Plot = await getPlot();

    let stationFilter = "";
    if (stationIds && stationIds.length > 0) {
      const ids = stationIds.map((id) => `'${id}'`).join(",");
      stationFilter = `AND station_id IN (${ids})`;
    }

    const data = await query(`
      SELECT
        CAST(lead_time / ${LEAD_TIME_PER_DAY} AS INTEGER) AS lead_time_days,
        model,
        AVG(value) AS value
      FROM '${STATS_URL}'
      WHERE variable = '${variable}'
        AND metric = '${resolvedMetric}'
        AND "window" / ${WINDOW_PER_DAY} = ${windowDays}
        ${stationFilter}
      GROUP BY lead_time_days, model
      ORDER BY lead_time_days, model
    `);

    if (data.length === 0) {
      showStatus(
        container,
        METRIC_HEIGHT,
        `No ${cfg.label} data for the last ${windowDays} days.`
      );
      await reportUnknownWindow({
        variable,
        metric: resolvedMetric,
        windowDays,
        // A count, not the ids: a state page passes fifty of them and Sentry
        // already records the URL that names the page.
        stations: stationIds?.length ?? "all",
      });
      return;
    }

    // Derive available models from the data rather than a hardcoded list.
    const knownOrder = [...MODEL_STYLE.keys()];
    const modelsInData = [...new Set(data.map((d) => d.model))].sort(
      (a, b) => {
        const ai = knownOrder.indexOf(a);
        const bi = knownOrder.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
    );
    let fallbackIdx = 0;
    const colorRange = modelsInData.map((m) => {
      if (MODEL_STYLE.has(m)) return MODEL_STYLE.get(m);
      return FALLBACK_COLORS[fallbackIdx++ % FALLBACK_COLORS.length];
    });

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
      color: { legend: true, domain: modelsInData, range: colorRange },
      marks: [
        Plot.barY(data, {
          fx: "lead_time_days",
          x: "model",
          y: "value",
          fill: "model",
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
      stations: stationIds?.length ?? "all",
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
