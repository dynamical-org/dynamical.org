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
  bestNote,
  encodedWindowValues,
  initDB,
  legendLabel,
  markBest,
  modelColors,
  modelCoversRegion,
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

// The models marked best at one lead, sorted by name.
const bestAt = (marked, lead) =>
  marked
    .filter((r) => r.lead_time_days === lead && r.best)
    .map((r) => r.model)
    .sort();

test("errors mark the lowest", () => {
  const marked = markBest(
    rows(0, { "NOAA GFS": 2.4, "NOAA HRRR": 1.8, "ECMWF IFS ENS": 2.0 }),
    METRIC_CONFIG.RMSE,
  );
  assert.deepEqual(bestAt(marked, 0), ["NOAA HRRR"]);
});

test("skill scores mark the highest, negative scores included", () => {
  const marked = markBest(
    rows(0, { "NOAA GFS": -0.05, "NOAA HRRR": 0.3, "ECMWF IFS ENS": 0.01 }),
    METRIC_CONFIG.ETS,
  );
  assert.deepEqual(bestAt(marked, 0), ["NOAA HRRR"]);
  // A lead where every model has negative skill still has a best one.
  const negative = markBest(
    rows(0, { "NOAA GFS": -0.05, "NOAA HRRR": -0.3 }),
    METRIC_CONFIG.HSS,
  );
  assert.deepEqual(bestAt(negative, 0), ["NOAA GFS"]);
});

test("bias marks the closest to zero, whatever its sign", () => {
  const marked = markBest(
    rows(0, { "NOAA GFS": -0.5, "NOAA HRRR": 0.3, "ECMWF IFS ENS": -0.1, "NOAA GEFS": 0.8 }),
    METRIC_CONFIG.Bias,
  );
  assert.deepEqual(bestAt(marked, 0), ["ECMWF IFS ENS"]);
  // A perfect zero is a real score, not a missing one.
  const zero = markBest(rows(0, { "NOAA GFS": 0, "NOAA HRRR": 0.3 }), METRIC_CONFIG.Bias);
  assert.deepEqual(bestAt(zero, 0), ["NOAA GFS"]);
});

test("frequency bias marks the closest to one, on either side of it", () => {
  const marked = markBest(
    rows(0, { "NOAA GFS": 0.5, "NOAA HRRR": 1.2, "ECMWF IFS ENS": 0.9, "NOAA GEFS": 2 }),
    METRIC_CONFIG.FrequencyBias,
  );
  assert.deepEqual(bestAt(marked, 0), ["ECMWF IFS ENS"]);
  // |0.5 − 1| beats |2 − 1|: the distance is linear, not a ratio.
  const linear = markBest(rows(0, { "NOAA GFS": 0.5, "NOAA GEFS": 2 }), METRIC_CONFIG.FrequencyBias);
  assert.deepEqual(bestAt(linear, 0), ["NOAA GFS"]);
});

test("each lead is judged on its own", () => {
  const marked = markBest(
    [
      ...rows(0, { "NOAA GFS": 1, "ECMWF IFS ENS": 2, "NOAA HRRR": 3 }),
      ...rows(5, { "NOAA GFS": 4, "ECMWF IFS ENS": 3 }),
    ],
    METRIC_CONFIG.MAE,
  );
  assert.deepEqual(bestAt(marked, 0), ["NOAA GFS"]);
  assert.deepEqual(bestAt(marked, 5), ["ECMWF IFS ENS"]);
});

// A tie is an equal computed distance, with no tolerance: Bias ±0.2 and Frequency
// Bias 0.5/1.5 are exact in binary and tie, while 0.9/1.1 land a few ulps apart
// and do not. Titles round to three figures, so near-ties can look tied there.
test("tied scores are all marked best", () => {
  const all = markBest(
    rows(0, { "NOAA GFS": 1, "ECMWF IFS ENS": 1, "NOAA HRRR": 1 }),
    METRIC_CONFIG.RMSE,
  );
  assert.deepEqual(bestAt(all, 0), ["ECMWF IFS ENS", "NOAA GFS", "NOAA HRRR"]);
  const two = markBest(
    rows(0, { "NOAA GFS": 0.3, "ECMWF IFS ENS": 0.3, "NOAA HRRR": 0.1 }),
    METRIC_CONFIG.ETS,
  );
  assert.deepEqual(bestAt(two, 0), ["ECMWF IFS ENS", "NOAA GFS"]);
  const bias = markBest(
    rows(0, { "NOAA GFS": 0.2, "ECMWF IFS ENS": -0.2, "NOAA HRRR": 0.3 }),
    METRIC_CONFIG.Bias,
  );
  assert.deepEqual(bestAt(bias, 0), ["ECMWF IFS ENS", "NOAA GFS"]);
  const fb = markBest(
    rows(0, { "NOAA GFS": 0.5, "ECMWF IFS ENS": 1.5, "NOAA HRRR": 2 }),
    METRIC_CONFIG.FrequencyBias,
  );
  assert.deepEqual(bestAt(fb, 0), ["ECMWF IFS ENS", "NOAA GFS"]);
  const nearTie = markBest(
    rows(0, { "NOAA GFS": 0.9, "ECMWF IFS ENS": 1.1 }),
    METRIC_CONFIG.FrequencyBias,
  );
  assert.equal(bestAt(nearTie, 0).length, 1);
});

test("missing values are never best, in any direction", () => {
  for (const metric of ["RMSE", "ETS", "Bias", "FrequencyBias"]) {
    const cfg = METRIC_CONFIG[metric];
    for (const missing of [null, undefined, NaN, Infinity, -Infinity]) {
      assert.equal(scoreDistance(missing, cfg), Infinity, `${metric} ${missing}`);
    }
    // -Infinity would otherwise win RMSE and +Infinity would win ETS.
    const marked = markBest(
      [
        ...rows(0, {
          "ECMWF IFS ENS": null,
          "NOAA GEFS": NaN,
          "NOAA GFS": 0.5,
          "NOAA HRRR": Infinity,
          "ECMWF AIFS ENS": -Infinity,
          "ECMWF AIFS Single": undefined,
        }),
        // A lead with no real score has no best bar, rather than marking every
        // missing one because Infinity equals Infinity.
        ...rows(1, { "ECMWF IFS ENS": null, "NOAA GEFS": NaN, "NOAA HRRR": Infinity }),
      ],
      cfg,
    );
    assert.deepEqual(bestAt(marked, 0), ["NOAA GFS"], metric);
    assert.deepEqual(bestAt(marked, 1), [], metric);
  }
  assert.deepEqual(markBest([], METRIC_CONFIG.RMSE), []);
});

test("marking best keeps every row and leaves the input alone", () => {
  const input = rows(0, { "NOAA GFS": 2, "NOAA HRRR": 1, "ECMWF IFS ENS": null });
  const before = structuredClone(input);
  const marked = markBest(input, METRIC_CONFIG.RMSE);
  assert.deepEqual(input, before);
  assert.deepEqual(
    marked.map(({ best, ...row }) => row),
    input,
    "markBest must not drop, reorder, or change rows",
  );
  assert.deepEqual(
    marked.map((r) => r.best),
    [false, true, false],
  );
});

// Bars take their x slot from modelColors' domain, shared by every lead, so a
// model sits in the same place at every lead whichever model is best there.
test("bars keep the legend's model order whatever the scores or input order", () => {
  const input = [
    ...rows(0, { "Some New Model": 1, "NOAA GFS": 3, "ECMWF IFS ENS": 2, "ECCC HRDPS": null }),
    ...rows(1, { "Another Model": 1, "NOAA GFS": 1, "NOAA HRRR": 5 }),
  ];
  const expected = [
    "ECMWF IFS ENS",
    "NOAA GFS",
    "NOAA HRRR",
    "ECCC HRDPS",
    "Another Model",
    "Some New Model",
  ];
  for (const shuffled of [input, [...input].reverse()]) {
    // A model whose only value is missing keeps its slot too.
    assert.deepEqual(modelColors(shuffled.map((r) => r.model)).domain, expected);
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

test("the chart caption names the marker and the direction", () => {
  for (const [metric, phrase] of [
    ["RMSE", "lowest is best"],
    ["ETS", "highest is best"],
    ["Bias", "closest to 0 is best"],
    ["FrequencyBias", "closest to 1 is best"],
  ]) {
    const note = bestNote(METRIC_CONFIG[metric]);
    assert.match(note, /^Triangles mark the best bar at each lead time;/, metric);
    assert.ok(note.endsWith(`; ${phrase}.`), `${metric}: ${note}`);
  }
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
