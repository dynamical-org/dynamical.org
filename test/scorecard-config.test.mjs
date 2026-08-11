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
} = await import(
  `data:text/javascript,${encodeURIComponent(readFileSync(SCORECARD_JS, "utf8"))}`
);

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
