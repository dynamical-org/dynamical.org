import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  abbreviateDuration,
  datasetFacts,
  modelFacts,
} = require("../lib/catalog-format.js");

test("abbreviates catalog durations", () => {
  const cases = [
    ["every hour", "every 1h"],
    ["every 6 hours", "every 6h"],
    ["1 hour", "1h"],
    ["3.0 hours", "3h"],
    ["30 minutes", "30m"],
    ["0-384 hours (0-16 days)", "0-384h (0-16 days)"],
    ["3 km", "3 km"],
    [null, ""],
  ];

  for (const [input, expected] of cases) {
    assert.equal(abbreviateDuration(input), expected);
  }
});

test("summarizes a forecast dataset as domain, variables, resolution, horizon, cadence", () => {
  assert.deepEqual(
    datasetFacts({
      spatial_domain: "Continental United States",
      optimization: "space",
      spatial_resolution: "3 km",
      forecast_domain: "Forecast lead time 0-18 hours ahead",
      time_resolution: "Forecasts initialized every hour",
    }),
    ["CONUS", "all variables", "3 km", "0-18h", "every 1h"],
  );
});

test("summarizes an analysis dataset with its record extent instead of a horizon", () => {
  assert.deepEqual(
    datasetFacts({
      spatial_domain: "Global",
      optimization: "time",
      variable_count: 25,
      spatial_resolution: "0.25 degrees (~20km)",
      time_domain: "2021-05-01 00:00:00 UTC to Present",
      time_resolution: "1 hour",
    }),
    ["Global", "25 variables", "0.25°", "2021-05-01 UTC to Present", "1h"],
  );
});

test("counts a model's live forecasts and analyses, skipping deprecated ones", () => {
  const datasets = [
    { forecast_domain: "Forecast lead time 0-18 hours ahead" },
    { forecast_domain: "Forecast lead time 0-48 hours ahead" },
    { forecast_domain: "Forecast lead time 0-48 hours ahead", status: "deprecated" },
    {},
  ];

  assert.deepEqual(modelFacts(datasets), ["2 forecasts", "1 analysis"]);
  assert.deepEqual(modelFacts([datasets[0]]), ["1 forecast"]);
  assert.deepEqual(modelFacts([{}, {}]), ["2 analyses"]);
  assert.deepEqual(modelFacts([]), []);
});
