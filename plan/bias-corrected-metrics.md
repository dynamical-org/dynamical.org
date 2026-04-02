# Display Bias-Corrected Temperature Metrics in Scorecard

## Context

scorecard-backend PR #29 adds bias-corrected temperature metrics to `statistics.parquet`. These appear as `RMSE_bc`, `MAE_bc`, `Bias_bc`, `CRPS_bc` — same model names, same schema, just new metric values. The frontend needs to expose these as selectable options.

## How the frontend works today

All scorecard chart rendering flows through a single file:

- **`public/scorecard.js`** — shared module imported by all three scorecard pages
  - `METRIC_CONFIG` — per-metric display config (label, unitType, refValue)
  - `VARIABLE_METRICS` — which metrics appear in each variable's dropdown
  - `DEFAULT_METRIC` — which metric is selected by default
  - `renderMetric()` — queries `statistics.parquet` via DuckDB-WASM, renders with Observable Plot

Three pages consume it identically:
- `content/scorecard.njk` — national view
- `content/scorecard-station.njk` — single station
- `content/scorecard-state.njk` — state aggregate

Each page has a `<select id="temp-metric">` populated from `VARIABLE_METRICS.temperature_2m`. The selected value is passed directly as the `metric` filter in the DuckDB SQL query against `statistics.parquet`.

Metric documentation lives in `content/scorecard-metrics.md`.

## Changes required

### `public/scorecard.js`

1. Add bc entries to `METRIC_CONFIG`:
```js
RMSE_bc:  { label: "RMSE (bias-corrected)",  unitType: "standard", refValue: 0 },
MAE_bc:   { label: "MAE (bias-corrected)",   unitType: "standard", refValue: 0 },
Bias_bc:  { label: "Bias (bias-corrected)",  unitType: "standard", refValue: 0 },
CRPS_bc:  { label: "CRPS (bias-corrected)",  unitType: "standard", refValue: 0 },
```

2. Add bc metrics to `VARIABLE_METRICS.temperature_2m`:
```js
temperature_2m: ["RMSE", "RMSE_bc", "MAE", "MAE_bc", "Bias", "Bias_bc", "CRPS", "CRPS_bc"],
```

No changes to `renderMetric()`, the SQL query, or any page templates — the metric value flows through as-is.

### `content/scorecard-metrics.md`

Add a section explaining bias correction: what it is, why it's useful (pixel-station representativeness), how the correction factor is computed (180d mean error per station×model), and that it's temperature-only.

## Steps

- [x] Add `_bc` entries to `METRIC_CONFIG` in `scorecard.js`
- [x] Add `_bc` metrics to `VARIABLE_METRICS.temperature_2m`
- [x] Export `METRIC_CONFIG` and use it for dropdown labels in all 3 pages (replaces hardcoded `FrequencyBias` special case)
- [x] Add bias correction explanation to `scorecard-metrics.md`
- [x] Verify build with `npm run build`

## Decisions

- Dropdown order: interleaved (RMSE, RMSE_bc, MAE, MAE_bc, ...)
- Default metric: unchanged (RMSE)
