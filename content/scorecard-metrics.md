---
layout: base
title: Scorecard Metrics
permalink: /scorecard/metrics/
---

<div class="content">

# How Metrics Are Computed

Scorecard metrics compare forecast values against surface observations at each station and lead time. All metrics are computed over daily lead-time bins and averaged across initialization times within the selected window (90 or 180 days).

Deterministic metrics (RMSE, MAE, Bias, ETS, Frequency Bias, HSS) are applied to the ensemble mean for ensemble models, or directly for deterministic models. CRPS is the only metric that uses individual ensemble members; for deterministic models it reduces to MAE.

For precipitation, both forecast and observed values are first resampled to 6-hour averages before any metric is computed.

## RMSE (Root Mean Square Error)

Square root of the mean of squared differences between forecast and observed values. RMSE penalizes large errors more heavily than MAE. Units match the variable. A perfect forecast has RMSE = 0. Applied to temperature only.

```python
def rmse(forecast, observed):
    se = (forecast - observed) ** 2
    daily_mean = se.resample(lead_time="1d").mean().mean(dim="init_time")
    return np.sqrt(daily_mean)
```

## MAE (Mean Absolute Error)

Mean of the absolute differences between forecast and observed values. MAE treats all error magnitudes equally. Units match the variable. A perfect forecast has MAE = 0.

```python
def mae(forecast, observed):
    ae = abs(forecast - observed)
    return ae.resample(lead_time="1d").mean().mean(dim="init_time")
```

## Bias

Mean signed difference (forecast minus observed). Positive bias means the model over-predicts; negative means it under-predicts. Units match the variable. A perfect forecast has Bias = 0.

```python
def bias(forecast, observed):
    err = forecast - observed
    return err.resample(lead_time="1d").mean().mean(dim="init_time")
```

## CRPS (Continuous Ranked Probability Score)

CRPS measures how well the full forecast probability distribution matches the observation. It decomposes into an accuracy term (mean absolute error of each ensemble member against the observation) minus a spread term (mean absolute difference between ensemble member pairs), rewarding ensembles that are both accurate and well-calibrated. For deterministic forecasts, CRPS reduces to MAE. Units match the variable. A perfect forecast has CRPS = 0.

The spread term uses an efficient O(n log n) rank-weighted formulation rather than computing all O(n²) pairwise differences.

```python
def crps_ensemble(forecast, observed):
    # For deterministic forecasts, reduces to MAE
    if "ensemble_member" not in forecast.dims:
        return mae(forecast, observed)

    n_ens = forecast.sizes["ensemble_member"]

    # Term 1: E|X - y| — mean absolute error of each member vs obs
    abs_err = abs(forecast - observed).mean(dim="ensemble_member")

    # Term 2: E|X - X'| — mean absolute spread between all member pairs
    # Efficient O(n log n) form using sorted ensemble members:
    # E|X-X'| = (2 / n²) * sum_i (2i - n - 1) * x_{(i)}
    sorted_fc = forecast.copy(data=np.sort(forecast.values, axis=...))
    ranks = np.arange(1, n_ens + 1)
    weights = 2.0 * ranks - n_ens - 1
    spread = (2.0 / (n_ens ** 2)) * (sorted_fc * weights).sum(dim="ensemble_member")

    crps = abs_err - 0.5 * spread
    return crps.resample(lead_time="1d").mean().mean(dim="init_time")
```

## ETS (Equitable Threat Score)

Measures skill at predicting precipitation occurrence after removing hits expected by chance. A precipitation event is defined as a rate at or above 0.1 mm/h. ETS ranges from &minus;1/3 to 1, where 1 is a perfect forecast, 0 indicates no skill beyond random chance, and negative values indicate worse-than-random performance. Applied to precipitation only.

ETS is computed from a contingency table of hits (H), misses (M), false alarms (F), and correct negatives (CN):

```python
PRECIP_THRESHOLD_MM_S = 0.1 / 3600.0  # 0.1 mm/h in model units (mm/s)

def ets(forecast, observed):
    h, m, f, cn = _contingency(forecast, observed, PRECIP_THRESHOLD_MM_S)
    # Sum counts over daily lead-time bins and init_times
    h, m, f, cn = [_daily_sum(x) for x in (h, m, f, cn)]
    n = h + m + f + cn
    h_random = (h + m) * (h + f) / n
    return (h - h_random) / (h + m + f - h_random)
```

## Frequency Bias

Ratio of the number of forecast precipitation events to the number of observed precipitation events, using the same 0.1 mm/h threshold as ETS. A value of 1 means the model predicts precipitation as often as it actually occurs. Values above 1 indicate over-forecasting; below 1 indicate under-forecasting. Applied to precipitation only.

```python
def frequency_bias(forecast, observed):
    h, m, f, _ = _contingency(forecast, observed, PRECIP_THRESHOLD_MM_S)
    h, m, f = [_daily_sum(x) for x in (h, m, f)]
    return (h + f) / (h + m)
```

## HSS (Heidke Skill Score)

Measures the fraction of correct forecasts (both wet and dry) after removing those expected by random chance. Uses the same 0.1 mm/h precipitation threshold as ETS and Frequency Bias. HSS ranges from &minus;1 to 1, where 1 is a perfect forecast, 0 indicates no skill beyond random chance, and negative values indicate worse-than-random performance. Unlike ETS, HSS gives equal credit for correctly forecasting both wet and dry events. Applied to precipitation only.

```python
def hss(forecast, observed):
    h, m, f, cn = _contingency(forecast, observed, PRECIP_THRESHOLD_MM_S)
    h, m, f, cn = [_daily_sum(x) for x in (h, m, f, cn)]
    numer = 2 * (h * cn - f * m)
    denom = (h + m) * (m + cn) + (h + f) * (f + cn)
    return numer / denom
```

## Contingency Table

The categorical precipitation metrics (ETS, Frequency Bias, HSS) are built on a contingency table. For each forecast-observation pair, both values are classified as "wet" (>= 0.1 mm/h) or "dry" (< 0.1 mm/h), producing four counts:

| | Observed wet | Observed dry |
|---|---|---|
| **Forecast wet** | Hit (H) | False alarm (F) |
| **Forecast dry** | Miss (M) | Correct negative (CN) |

NaN values in either forecast or observation are excluded from all four cells.

```python
def _contingency(forecast, observed, threshold):
    valid = forecast.notnull() & observed.notnull()
    f_yes = (forecast >= threshold) & valid
    o_yes = (observed >= threshold) & valid
    hits = (f_yes & o_yes).astype(float)
    misses = (~f_yes & o_yes).astype(float)
    false_alarms = (f_yes & ~o_yes).astype(float)
    correct_neg = (~f_yes & ~o_yes & valid).astype(float)
    return hits, misses, false_alarms, correct_neg
```

</div>
