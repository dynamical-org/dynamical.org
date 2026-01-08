---
layout: base
title: Scorecard Observation Data
permalink: /scorecard/observation-data/
---

<div class="content">

# Scorecard Observation Data

## Source

Our verification system uses observations from the Automated Surface Observing System (ASOS), the primary surface weather observation network in the United States. ASOS stations are located at airports nationwide, providing consistent, high-quality weather measurements around the clock.

Observation data is retrieved from the [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/), maintained by Iowa State University, which archives and distributes ASOS data.

## Variables

We verify forecasts against two key surface variables:

- **Temperature** — 2-meter air temperature in degrees Celsius, measured instantaneously at each reporting time
- **Precipitation** — 1-hour accumulated precipitation in millimeters

## Processing

Raw ASOS observations are processed to align with forecast data:

1. **Hourly Resampling** — Observations are aggregated into consistent hourly bins aligned to the top of each hour (UTC)
2. **Temperature Handling** — Hourly means are computed, with short gaps (up to 2 hours) filled using linear interpolation
3. **Precipitation Handling** — Hourly maximum values are used to capture accumulation totals; no interpolation is applied to preserve the integrity of wet/dry periods
4. **Quality Control** — Negative precipitation values are filtered out; stations must be marked as operational in the network

## Alignment with Forecasts

Observations are matched to forecast grid points using nearest-neighbor spatial selection. Forecast valid times are aligned with observation timestamps, allowing direct comparison at each lead time from 0 to 239 hours (approximately 10 days).

## Coverage

The scorecard includes all operational US ASOS stations with sufficient data coverage during the verification period, providing broad geographic representation across the continental United States, Alaska, Hawaii, and US territories.

</div>
