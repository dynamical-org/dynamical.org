import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Fast, offline companions to test/e2e/scorecard.spec.mjs. The e2e specs render
// real charts and are the only thing that can catch the published parquet drifting
// out from under the queries, but they need a browser and minutes of network, so
// they run on demand. These checks cover the mistakes that are pure bookkeeping —
// a metric named in one table and not the other, or lookback windows that differ
// between pages — and they run in milliseconds on every `npm test`.

const SCORECARD_JS = new URL("../public/scorecard.js", import.meta.url);

// scorecard.js is browser ESM served as a static asset, so it is not reachable by
// a bare `import` from a CommonJS package. Its module scope is only constants and
// function declarations — the CDN imports live inside the render functions — so
// evaluating it as a data URL is side-effect free and gives us the real exports
// instead of a copy of them.
const {
  METRIC_CONFIG,
  VARIABLE_METRICS,
  DEFAULT_METRIC,
  encodedWindowValues,
  initDB,
  legendLabel,
  modelColors,
  modelCoversRegion,
  orderNote,
  rankWithinLead,
  scoreDistance,
} = await import(
  `data:text/javascript,${encodeURIComponent(readFileSync(SCORECARD_JS, "utf8"))}`
);

test("HRDPS and its bias correction are excluded from country plots", () => {
  for (const model of ["ECCC HRDPS", "ECCC HRDPS (bc)"]) {
    assert.equal(modelCoversRegion(model), false);
    assert.equal(modelCoversRegion(model, { scope: "country" }), false);
    assert.equal(modelCoversRegion(model, { scope: "station" }), true);
  }
  assert.equal(modelCoversRegion("NOAA GFS"), true);
});

test("HRDPS state coverage requires the whole state, not just some stations", () => {
  for (const model of ["ECCC HRDPS", "ECCC HRDPS (bc)"]) {
    for (const stateAbbr of ["IN", "OR", "VA", "NY", "DC"]) {
      assert.equal(modelCoversRegion(model, { scope: "state", stateAbbr }), true);
    }
    for (const stateAbbr of ["IL", "AK", "WY", "NC", "CA", undefined]) {
      assert.equal(modelCoversRegion(model, { scope: "state", stateAbbr }), false);
    }
    assert.equal(modelCoversRegion(model, { scope: "country", stateAbbr: "NY" }), false);
  }
  assert.equal(modelCoversRegion("NOAA GFS", { scope: "state", stateAbbr: "IL" }), true);
});

test("legend labels drop the virtual suffix and leave other names alone", () => {
  assert.equal(legendLabel("Google WeatherNext 2, virtual"), "Google WeatherNext 2");
  assert.equal(legendLabel("ECMWF AIFS Single, virtual (bc)"), "ECMWF AIFS Single (bc)");
  for (const model of ["NOAA GFS", "ECCC HRDPS (bc)", "Example, virtual-analysis"]) {
    assert.equal(legendLabel(model), model);
  }
});

test("every offered metric has display configuration", () => {
  for (const [variable, metrics] of Object.entries(VARIABLE_METRICS)) {
    for (const metric of metrics) {
      assert.ok(
        METRIC_CONFIG[metric],
        `${variable} offers ${metric}, which has no METRIC_CONFIG entry; the ` +
          "dropdown would fall back to the raw key and the chart would be " +
          "labelled and scaled as RMSE",
      );
    }
  }
});

// Spelled out in full rather than checked for a valid value: a metric filed
// under the wrong direction is a valid value too, and it would silently put the
// worst model first. Adding a metric means adding it here.
const EXPECTED_DIRECTION = {
  RMSE: "lower",
  RMSE_bc: "lower",
  MAE: "lower",
  MAE_bc: "lower",
  CRPS: "lower",
  CRPS_bc: "lower",
  ETS: "higher",
  HSS: "higher",
  FSS: "higher",
  Bias: "target",
  FrequencyBias: "target",
};

test("every metric declares which direction is better", () => {
  for (const [metric, cfg] of Object.entries(METRIC_CONFIG)) {
    assert.ok(
      ["lower", "higher", "target"].includes(cfg.better),
      `${metric} has no valid \`better\` direction, so its bars cannot be ordered`,
    );
    assert.equal(
      cfg.better,
      EXPECTED_DIRECTION[metric],
      `${metric} is ordered as ${cfg.better}-is-better, but EXPECTED_DIRECTION ` +
        `says ${EXPECTED_DIRECTION[metric] ?? "nothing: add it once its direction is confirmed"}`,
    );
  }
  assert.deepEqual(
    Object.keys(METRIC_CONFIG).sort(),
    Object.keys(EXPECTED_DIRECTION).sort(),
  );
});

test("target metrics aim at their optimum", () => {
  assert.equal(METRIC_CONFIG.Bias.refValue, 0);
  assert.equal(METRIC_CONFIG.FrequencyBias.refValue, 1);
});

const rows = (lead, values) =>
  Object.entries(values).map(([model, value]) => ({
    lead_time_days: lead,
    model,
    value,
  }));

// Model order within one lead, best first.
const order = (ranked, lead) =>
  ranked
    .filter((r) => r.lead_time_days === lead)
    .sort((a, b) => a.slot - b.slot)
    .map((r) => r.model);

test("errors rank lowest first", () => {
  const ranked = rankWithinLead(
    rows(0, { "NOAA GFS": 2.4, "NOAA HRRR": 1.8, "ECMWF IFS ENS": 2.0 }),
    METRIC_CONFIG.RMSE,
  );
  assert.deepEqual(order(ranked, 0), ["NOAA HRRR", "ECMWF IFS ENS", "NOAA GFS"]);
});

test("skill scores rank highest first, negative scores included", () => {
  const ranked = rankWithinLead(
    rows(0, { "NOAA GFS": -0.05, "NOAA HRRR": 0.3, "ECMWF IFS ENS": 0.01 }),
    METRIC_CONFIG.ETS,
  );
  assert.deepEqual(order(ranked, 0), ["NOAA HRRR", "ECMWF IFS ENS", "NOAA GFS"]);
});

test("bias ranks closest to zero first, whatever its sign", () => {
  const ranked = rankWithinLead(
    rows(0, { "NOAA GFS": -0.5, "NOAA HRRR": 0.3, "ECMWF IFS ENS": -0.1, "NOAA GEFS": 0.8 }),
    METRIC_CONFIG.Bias,
  );
  assert.deepEqual(order(ranked, 0), [
    "ECMWF IFS ENS",
    "NOAA HRRR",
    "NOAA GFS",
    "NOAA GEFS",
  ]);
});

test("frequency bias ranks closest to one first, on either side of it", () => {
  const ranked = rankWithinLead(
    rows(0, { "NOAA GFS": 0.5, "NOAA HRRR": 1.2, "ECMWF IFS ENS": 0.9, "NOAA GEFS": 2 }),
    METRIC_CONFIG.FrequencyBias,
  );
  // |0.5 − 1| beats |2 − 1|: the distance is linear, not a ratio.
  assert.deepEqual(order(ranked, 0), [
    "ECMWF IFS ENS",
    "NOAA HRRR",
    "NOAA GFS",
    "NOAA GEFS",
  ]);
});

test("each lead is ranked on its own", () => {
  const ranked = rankWithinLead(
    [
      ...rows(0, { "NOAA GFS": 1, "ECMWF IFS ENS": 2, "NOAA HRRR": 3 }),
      ...rows(5, { "NOAA GFS": 4, "ECMWF IFS ENS": 3 }),
    ],
    METRIC_CONFIG.MAE,
  );
  assert.deepEqual(order(ranked, 0), ["NOAA GFS", "ECMWF IFS ENS", "NOAA HRRR"]);
  // A lead with fewer models fills the leading slots and leaves the rest empty.
  assert.deepEqual(order(ranked, 5), ["ECMWF IFS ENS", "NOAA GFS"]);
  assert.deepEqual(
    ranked.filter((r) => r.lead_time_days === 5).map((r) => r.slot).sort(),
    [0, 1],
  );
});

test("ties get distinct slots in the stable model order, whatever the input order", () => {
  const values = { "Some New Model": 1, "NOAA GFS": 1, "ECMWF IFS ENS": 1, "ECCC HRDPS": 1 };
  const expected = ["ECMWF IFS ENS", "NOAA GFS", "ECCC HRDPS", "Some New Model"];
  const input = rows(0, values);
  for (const shuffled of [input, [...input].reverse()]) {
    const ranked = rankWithinLead(shuffled, METRIC_CONFIG.RMSE);
    assert.deepEqual(order(ranked, 0), expected);
    assert.deepEqual(ranked.map((r) => r.slot).sort(), [0, 1, 2, 3]);
  }
  // Bias of equal size and opposite sign is a tie too.
  const bias = rankWithinLead(
    rows(0, { "NOAA GFS": 0.2, "ECMWF IFS ENS": -0.2 }),
    METRIC_CONFIG.Bias,
  );
  assert.deepEqual(order(bias, 0), ["ECMWF IFS ENS", "NOAA GFS"]);
});

test("missing values rank last in every direction and never count as perfect", () => {
  for (const metric of ["RMSE", "ETS", "Bias", "FrequencyBias"]) {
    const cfg = METRIC_CONFIG[metric];
    for (const missing of [null, undefined, NaN, Infinity, -Infinity]) {
      assert.equal(scoreDistance(missing, cfg), Infinity, `${metric} ${missing}`);
    }
    const ranked = rankWithinLead(
      rows(0, { "ECMWF IFS ENS": null, "NOAA GEFS": NaN, "NOAA GFS": 5, "NOAA HRRR": -3 }),
      cfg,
    );
    assert.deepEqual(
      order(ranked, 0).slice(2),
      ["ECMWF IFS ENS", "NOAA GEFS"],
      `${metric} ranked a missing value ahead of a real one`,
    );
  }
});

test("a model keeps its color whichever models share the chart", () => {
  const published = [
    "ECCC HRDPS",
    "ECMWF AIFS ENS",
    "ECMWF AIFS Single",
    "ECMWF IFS ENS",
    "Google WeatherNext 2, virtual",
    "NOAA GEFS",
    "NOAA GFS",
    "NOAA HRRR",
  ];
  const colorOf = (models) => {
    const { domain, range } = modelColors(models);
    return Object.fromEntries(domain.map((m, i) => [m, range[i]]));
  };
  const all = colorOf(published);
  assert.equal(new Set(Object.values(all)).size, published.length, "colors collide");
  // The country page drops HRDPS; CRPS carries only the ensembles.
  for (const subset of [
    published.filter((m) => m !== "ECCC HRDPS"),
    ["ECMWF AIFS ENS", "ECMWF IFS ENS", "Google WeatherNext 2, virtual", "NOAA GEFS"],
    ["ECCC HRDPS", "NOAA HRRR"],
  ]) {
    const colors = colorOf(subset);
    for (const model of subset) assert.equal(colors[model], all[model], model);
  }
  // An unpinned model still gets a color, after the pinned ones in the legend.
  const { domain } = modelColors(["Some New Model", ...published]);
  assert.equal(domain.at(-1), "Some New Model");
});

test("the chart caption states the direction", () => {
  assert.match(orderNote(METRIC_CONFIG.RMSE), /lower is better/);
  assert.match(orderNote(METRIC_CONFIG.ETS), /higher is better/);
  assert.match(orderNote(METRIC_CONFIG.Bias), /closest to 0 is best/);
  assert.match(orderNote(METRIC_CONFIG.FrequencyBias), /closest to 1 is best/);
});

test("every variable's default metric is one it offers", () => {
  for (const [variable, metric] of Object.entries(DEFAULT_METRIC)) {
    assert.ok(
      VARIABLE_METRICS[variable]?.includes(metric),
      `${variable} defaults to ${metric}, which is not in its metric list, so ` +
        "no dropdown option would be preselected",
    );
  }
});

test("rejects with a catchable error, without reaching the CDN, when WebAssembly is unavailable", async () => {
  // A browser context without WebAssembly at all (e.g. Safari Lockdown Mode)
  // must not reach duckdb-wasm's unconditional feature-detection, which
  // throws an uncaught ReferenceError instead of reporting "unsupported".
  const originalWebAssembly = globalThis.WebAssembly;
  delete globalThis.WebAssembly;
  try {
    await assert.rejects(initDB(), /WebAssembly/);
  } finally {
    globalThis.WebAssembly = originalWebAssembly;
  }
});

test("window filters accept both published duration encodings", () => {
  assert.deepEqual(encodedWindowValues(180), [
    15_552_000_000_000n,
    15_552_000_000_000_000n,
  ]);
});

// Each scorecard template hardcodes its own lookback options. The e2e specs walk
// the selector on a station page only — station-filtered queries are cheap enough
// to re-run a dozen times — so the other pages are covered by that run only for
// as long as they offer the same windows. A window the pipeline does not publish
// silently renders an empty chart.
const WINDOW_SELECT_PAGES = [
  ["content/scorecard.njk", "window"],
  ["content/scorecard-state.njk", "window"],
  ["content/scorecard-station.njk", "temp-window"],
  ["content/scorecard-station.njk", "precip-window"],
];

function windowOptions(file, selectId) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const open = source.indexOf(`id="${selectId}"`);
  assert.notEqual(open, -1, `${file} has no <select id="${selectId}">`);
  const close = source.indexOf("</select>", open);
  assert.notEqual(close, -1, `${file}'s ${selectId} select is unterminated`);
  return [
    ...source.slice(open, close).matchAll(/<option value="(\d+)"/g),
  ].map((m) => Number(m[1]));
}

test("every page offers the same lookback windows", () => {
  const [first, ...rest] = WINDOW_SELECT_PAGES;
  const expected = windowOptions(...first);
  assert.ok(expected.length > 1, `${first[0]} lists no window options`);

  for (const page of rest) {
    assert.deepEqual(
      windowOptions(...page),
      expected,
      `${page[1]} in ${page[0]} offers different lookback windows than ` +
        `${first[1]} in ${first[0]}; only the windows the e2e specs walk are ` +
        "known to return data",
    );
  }
});
