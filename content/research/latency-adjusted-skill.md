---
type: "Lab note"
status: "Draft"
title: "Forecast skill at the moment you decide: latency-adjusted skill for virtual datasets and upstream sources"
date: 2026-10-24
areas:
  - forecast-evaluation
  - weather-product-design
summary: >-
  Draft results. As of each decision time, use the newest run whose needed lead
  is recorded readable, and score it at the horizon from that time. HRRR hourly
  vs 6-hourly runs, per-lead availability at the upstream source vs our virtual
  datasets, and a short multi-model comparison, for 2 m temperature at 63 major
  US airports.
---

Draft, results only. Scope: virtual datasets and their upstream sources. 2 m temperature at the ASOS stations of 63 large and medium US hub airports (FAA calendar-year 2025 hub classes). HRRR comparisons use the 60 inside its CONUS domain (no Anchorage, Honolulu or Kahului). Per-lead availability comes from wxopticon's public archive (`https://assets.dynamical.org/wxopticon/archive/{product}/{YYYY-MM-DD}.jsonl`).

**Method.** As of decision time T (hourly), use the newest run whose needed lead is recorded readable by T, and score it at horizon V − T. Cases are paired across policies. 90% CIs are pointwise, from a circular 5-day block bootstrap over valid days. Every selection is checked against a brute-force oracle.

## HRRR hourly (18 h) vs 6-hourly (48 h) runs

{% figure "/assets/notes/latency-hrrr-18-vs-48.png", "Six panels comparing HRRR 18-hour and 48-hour virtual datasets as of decision time: lead availability after init, coverage, run age, RMSE by horizon, paired RMSE difference, and how often a newer hourly run is used." %}HRRR 18 h vs 48 h virtual, 60 CONUS airports. T hourly 2026-08-02 to 10-21 00Z (~11.5 weeks), V hourly. (a) Lead recorded readable after init. (b) Coverage of (T, V, station) cases. (c) Median age of the selected run. (d) RMSE vs horizon. (e) Paired difference vs 48 h only. (f) How often "either" uses a newer run, and by how many hours.{% endfigure %}

| horizon (h) | RMSE, 48 h only (°C) | RMSE, either (°C) | either − 48 h only (°C) [90% CI] | T at :30 | cases with a newer run | mean hours newer |
|---|---|---|---|---|---|---|
| 0–3 | 1.579 | 1.435 | **−0.144 [−0.153, −0.134]** | −0.137 [−0.144, −0.129] | 77.5% | 2.2 |
| 3–6 | 1.706 | 1.667 | −0.039 [−0.046, −0.031] | −0.046 [−0.055, −0.036] | 73.2% | 2.0 |
| 6–9 | 1.784 | 1.763 | −0.020 [−0.031, −0.010] | −0.020 [−0.030, −0.010] | 83.0% | 2.5 |
| 9–12 | 1.819 | 1.805 | −0.014 [−0.026, −0.001] | −0.014 [−0.025, −0.001] | 83.2% | 2.5 |
| 12–15 | 1.844 | 1.840 | −0.004 [−0.015, +0.008] | −0.003 [−0.015, +0.009] | 83.2% | 2.5 |
| 15–18 | 1.871 | 1.863 | −0.008 [−0.013, −0.004] | – | 54.9% | 1.6 |
| ≥ 18 | identical | identical | 0 | 0 | 0% | 0 |

- n = 345,417 paired (T, V, station) cases per bin.
- Per airport at 0–3 h: median −0.129 °C (IQR −0.163 to −0.100); 59 of 60 gain. Largest: PHX −0.40, LAS −0.34, ONT −0.32, BUR −0.30, PDX −0.27. Smallest: BNA −0.06, IND −0.04, BUF −0.04, SFO −0.02, BOS +0.02.

By region (Census), either − 48 h only (°C [90% CI]):

| region | airports | 0–3 h | 3–6 h | 6–9 h | 9–12 h |
|---|---|---|---|---|---|
| West | 17 | −0.188 [−0.202, −0.173] | −0.076 [−0.087, −0.065] | −0.057 [−0.071, −0.043] | −0.019 [−0.031, −0.007] |
| South | 24 | −0.134 [−0.146, −0.121] | −0.023 [−0.036, −0.010] | +0.001 [−0.012, +0.016] | −0.014 [−0.030, +0.006] |
| Midwest | 11 | −0.123 [−0.146, −0.100] | −0.027 [−0.047, −0.006] | −0.008 [−0.032, +0.015] | −0.001 [−0.025, +0.026] |
| Northeast | 8 | −0.098 [−0.122, −0.073] | −0.011 [−0.033, +0.010] | −0.009 [−0.027, +0.007] | −0.018 [−0.040, +0.004] |

- Median run age at T: 2 h (max 3) with hourly runs; 4–5 h (max 13) with 6-hourly runs.
- Every "newer run" case is an extra hourly cycle. Earlier copies of a shared 00/06/12/18Z cycle are ≤ 0.1%.
- Hourly-only coverage: 66% at 15–18 h, 0% beyond. 48 h-only coverage falls in the 42–48 h bins.
- History: wxopticon has the 48 h product from 2026-07-14 and the 18 h product from 2026-08-01.

## Per-lead availability: upstream source vs virtual

Median hours after init until each lead is recorded readable (inits 2026-07-10 to 10-23 where tracked):

| product | lead 0 | 24 h | 48 h | 120 h | last lead |
|---|---|---|---|---|---|
| HRRR 18 h: source / virtual | 0.86 / 0.86 | – | – | – | 1.42 / 1.43 (18 h) |
| HRRR 48 h: source / virtual | 0.87 / 0.87 | 1.35 / 1.77\* | 1.79 / 1.79 | – | 1.79 / 1.80 (48 h) |
| GFS: source / virtual | 3.59 / 3.59 | 3.71 / 3.72 | 3.81 / 3.85 | 4.14 / 4.13 | 5.27 / 5.26 (384 h) |
| AIFS single: AWS / GCS / virtual | 5.43 / 5.44 / 5.45 | 5.43 / 5.44 / 5.46 | 5.43 / 5.44 / 5.47 | 5.44 / 5.45 / 5.48 | 5.48 / 5.53 / 5.53 (360 h) |
| GEFS 0.25° 10-day: source / virtual | 3.82 / 3.82 | 3.97 / 3.97 | 4.14 / 4.15 | 4.65 / 4.68 | 5.52 / 5.52 (240 h) |

\* Interior-lead upper bound.

Recorded virtual − source per matched (init, lead), in minutes:

| pair | leads | p50 | p95 | max | > 30 min |
|---|---|---|---|---|---|
| HRRR 18 h | 20,176 | 0.7 | 7.5 | 69 | 0.1% |
| HRRR 48 h | 19,820 | 2.5 | 27.8 | 211 | 2.9% (mostly band-dated interior leads) |
| GFS | 13,167 | 1.1 | 2.7 | 83 | 0% |
| AIFS single (vs GCS) | 5,551 | 0.1 | 246 | 300 | 0% for inits through 10-18; from 10-20, 67–95% of leads 102–360 h |
| GEFS 10-day | 2,430 | 0.1 | 2.5 | 5 | 0% |

## Multi-model, and virtual vs upstream timing

{% figure "/assets/notes/latency-asof-by-source.png", "Three panels: RMSE vs horizon for HRRR, GFS and AIFS single using upstream-source timing; paired RMSE difference vs AIFS single; and the paired RMSE difference between virtual and upstream timing for each model." %}T hourly 2026-09-10 to 10-18 00Z, V at 00/06/12/18Z. HRRR on 60 CONUS airports, GFS and AIFS single on 63. HRRR is the newest of the hourly and 6-hourly runs. (a) RMSE vs horizon, newest run readable at the upstream source. (b) Paired difference vs AIFS single, same timing. (c) Same model, virtual timing minus upstream timing, on each model's own overlap.{% endfigure %}

Paired RMSE minus AIFS single, upstream timing (°C [90% CI]):

| horizon (h) | HRRR (60 CONUS) | GFS (63) |
|---|---|---|
| 0–6 | −0.035 [−0.065, −0.002] | +0.363 [+0.336, +0.386] |
| 6–12 | +0.203 [+0.163, +0.238] | +0.387 [+0.362, +0.412] |
| 12–18 | +0.255 [+0.212, +0.298] | +0.406 [+0.377, +0.437] |
| 24–30 | +0.406 [+0.356, +0.463] | +0.409 [+0.386, +0.435] |
| 30–36 | +0.475 [+0.404, +0.546] | +0.416 [+0.391, +0.447] |
| 48–54 | – | +0.438 [+0.398, +0.482] |
| 78–84 | – | +0.506 [+0.447, +0.575] |

- HRRR at 0–6 h with T at :30: +0.018 [−0.014, +0.050].
- GFS on the 60 CONUS airports only: +0.380 to +0.521.

HRRR minus AIFS single at 0–6 h, by region: West −0.376 [−0.441, −0.307]; Midwest +0.077 [+0.022, +0.131]; South +0.138 [+0.108, +0.168]; Northeast +0.279 [+0.230, +0.324]. In the West, HRRR and AIFS tie at 6–18 h and AIFS leads from 24 h (+0.157 [+0.074, +0.234]). GFS minus AIFS is positive at every horizon in every region (Alaska/Hawaii +0.07 to +0.20; South +0.57 to +0.63).

Same model, virtual timing minus upstream timing:

| model | overlap from T | (T, V) cases | older run via virtual | RMSE effect |
|---|---|---|---|---|
| HRRR | 09-10 00Z | 7,135 | 2.4% (149 by 1 h, 24 by 6 h) | +0.011 [0.005, 0.020] °C at 0–6 h; ≤ 0.003 elsewhere |
| GFS | 10-07 16Z | 3,484 | 0.6% (all 6 h, long horizons) | ≤ 0.005 °C |
| AIFS single | 09-26 06Z | 7,322 | 0% | 0 |

- With T at :30: HRRR 1.9% and ~0 °C; GFS 0%; AIFS 0.08%.

## Virtual vs materialized values

Five stations (ORD, BOS, SEA, DEN, ATL); inits 2026-10-07 to 10-20, leads 0–144 h (HRRR 0–48 h). On the 63-airport extraction, GFS and AIFS single virtual agree with these materialized extracts within the same rounding (max 0.125 °C) on every overlapping case.

| virtual | materialized twin | 2 m temperature difference | per-run errors |
|---|---|---|---|
| GFS | `noaa-gfs-forecast` | max 0.113, mean 0.021 °C; all within the twin's 7-bit rounding | reusable |
| HRRR 48 h | `noaa-hrrr-forecast-48-hour` | max 0.062 °C; all within rounding | reusable |
| AIFS single | `ecmwf-aifs-single-forecast` | max 0.062 °C; all within rounding | reusable |
| GEFS 10-day 0.25° | `noaa-gefs-forecast-35-day` (00Z only) | ensemble mean max 0.020 °C | 00Z reusable; 06/12/18Z need extraction |
| GEFS 16/35-day 0.5° | none at 0.5° | ensemble mean max 3.05 °C; station mean absolute up to 1.21 °C | need extraction |
| HRRR 18 h | none | bit-identical to 48 h virtual at 00/06/12/18Z | need extraction (hourly cycles) |

- Matched RMSE, virtual − materialized: GFS −0.0003, AIFS −0.0005, HRRR 48 h −0.0003, GEFS −0.00005 °C.
- Reuse means per-run, native-lead errors. Statistics pooled by day can't be joined to availability.

## History

| product | first full short-lead coverage in wxopticon | provenance | store values from |
|---|---|---|---|
| HRRR 18 h virtual | 2026-08-01 | reconstructed until 09-14 | 2018-07-13 |
| HRRR 48 h virtual | 2026-07-14 | reconstructed until 09-14 | 2018-07-13 |
| AIFS single virtual | 2026-09-26 (first evidence 09-17) | observed | 2024-04-01 |
| GFS virtual | 2026-10-07 | observed | 2021-05-01 |
| GEFS 10/16/35-day virtual | 2026-10-07 | observed | 2020-10-01 (10-day) |
| RRFS 84 h / RRFS ENS / REFS hourly virtual | 2026-10-15/16 | observed | 2026-08/09 |
| Sources: GFS, HRRR 48 h, AIFS, IFS ENS, GEFS long (AWS) | 2025-08-15 | temperature files reconstructed until 2026-08-11 | – |
| Sources: HRRR 18 h (AWS) / AIFS (GCS) / GEFS 10/16-day, RRFS/REFS (AWS) | 2026-09-08 / 09-30 / 10-15 | observed | – |

- The common multi-model virtual window starts 2026-10-07 (~2.5 weeks so far, growing a week per week).

## Caveats

- 2 m temperature only; 63 airports (60 for HRRR), 8–24 per region, 3 outside CONUS; ensemble means only; 5.5–11.5 weeks.
- Availability is recorded evidence, not proven first availability. Interior leads of a virtual band are upper bounds.
- Source rows require both the data and index files (time = the later of the two). A data-only rule would shift some selections at the hour boundary.
- Early source rows are reconstructed from object Last-Modified times; their precision vs live detection isn't shown.
- HRRR is recorded readable ~52 min after init, so an on-the-hour T sits at the threshold. Results are phase-sensitive (checked at :15, :30, :45).
- Today's store values are paired with historical timing. All errors come from the virtual stores.
- Download, decode and point-read time are excluded.
- AIFS's late-lead virtual lag from 10-20 falls outside the skill window.
