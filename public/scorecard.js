// Client-side scorecard charts: DuckDB-WASM for parquet queries, Observable Plot for rendering.

const STATS_URL = "https://sa.dynamical.org/statistics.parquet";
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

// Per-metric display configuration.
const METRIC_CONFIG = {
  RMSE:          { label: "RMSE",           unitType: "standard", refValue: 0 },
  MAE:           { label: "MAE",            unitType: "standard", refValue: 0 },
  Bias:          { label: "Bias",           unitType: "standard", refValue: 0 },
  CRPS:          { label: "CRPS",           unitType: "standard", refValue: 0 },
  ETS:           { label: "ETS",            unitType: "unitless", refValue: 0 },
  FrequencyBias: { label: "Frequency Bias", unitType: "unitless", refValue: 1 },
  HSS:           { label: "HSS",            unitType: "unitless", refValue: 0 },
  FSS:           { label: "FSS",            unitType: "unitless", refValue: 0 },
};

// Which metrics are available for each variable, and which is the default.
export const VARIABLE_METRICS = {
  temperature_2m:       ["RMSE", "MAE", "Bias", "CRPS"],
  precipitation_surface: ["MAE", "Bias", "CRPS", "ETS", "FrequencyBias", "HSS", "FSS"],
};

export const DEFAULT_METRIC = {
  temperature_2m:       "RMSE",
  precipitation_surface: "MAE",
};

function showLoading(container, height) {
  container.replaceChildren();
  Object.assign(container.style, {
    height: `${height}px`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--muted-text-2, #999)",
    backgroundColor: "var(--popup-bg, #fafafa)",
  });
  container.textContent = "Loading\u2026";
}

function clearLoading(container) {
  container.style.cssText = "";
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

export async function renderMetric(
  container,
  { variable, metric, stationIds, windowDays }
) {
  const resolvedMetric = metric || DEFAULT_METRIC[variable] || "RMSE";
  const cfg = METRIC_CONFIG[resolvedMetric] || METRIC_CONFIG.RMSE;

  showLoading(container, METRIC_HEIGHT);
  try {
    const Plot = await getPlot();

    let stationFilter = "";
    if (stationIds && stationIds.length > 0) {
      const ids = stationIds.map((id) => `'${id}'`).join(",");
      stationFilter = `AND station_id IN (${ids})`;
    }

    const data = await query(`
      SELECT
        CAST(lead_time / 86400000000000 AS INTEGER) AS lead_time_days,
        model,
        AVG(value) AS value
      FROM '${STATS_URL}'
      WHERE variable = '${variable}'
        AND metric = '${resolvedMetric}'
        AND "window" / 86400000000000 = ${windowDays}
        ${stationFilter}
      GROUP BY lead_time_days, model
      ORDER BY lead_time_days, model
    `);

    if (data.length === 0) {
      clearLoading(container);
      container.textContent = "No data available";
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

    clearLoading(container);
    container.replaceChildren(chart);
  } catch (e) {
    console.error("renderMetric failed:", e);
    clearLoading(container);
    container.textContent = "Failed to load chart";
  }
}

// ── Observation timeseries ──────────────────────────────────────────────────

export async function renderObs(
  container,
  { station, variable, windowDays }
) {
  showLoading(container, OBS_HEIGHT);
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
    const q = `
      SELECT valid AS t, station, ${col} AS value
      FROM read_parquet([${urls.join(", ")}])
      WHERE station = '${station}'
        AND valid >= '${startDate.toISOString()}'
      ORDER BY valid
    `;
    console.log(q);
    const data = await query(q);

    if (data.length === 0) {
      clearLoading(container);
      container.textContent = "No observation data available";
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

    clearLoading(container);
    container.replaceChildren(chart);
  } catch (e) {
    console.error("renderObs failed:", e);
    clearLoading(container);
    container.textContent = "Failed to load observation data";
  }
}
