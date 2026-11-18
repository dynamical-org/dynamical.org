---
title: Steering Committee Meeting, Q2 2026
date: 2026-06-03
---

## {{title}}
**Date:** June 3, 2026

**Members present:**
- Jacob Zwart
- Joe Hamman
- Stephan Hoyer
- Alden Keefe Sampson

---

## Usage and new datasets

Monthly requests exceeded **200M in March**. Since the previous meeting, we released NOAA MRMS analysis, ECMWF AIFS Single forecast, DWD ICON-EU forecast and ECMWF AIFS ENS forecast. The committee reviewed this growth alongside the transition to Icechunk.

## Dataset access and reproducibility

Members supported using the STAC catalog as the source of truth for dataset locations, so users can discover the current storage location rather than hard-code it. We discussed using PySTAC for direct access examples and defaulting to `chunks=None` when opening datasets with Xarray to avoid unnecessary Dask overhead.

For reproducibility, members recommended retaining tagged snapshots as stable references while investigating ways to compact redundant intermediate updates. The discussion distinguished preserving useful history from keeping every implementation step indefinitely.

## Reliability and sustainability

The committee discussed making reliability visible through validation reports and latency tracking. Source fallbacks and parallel updates were part of the progress reviewed. Members also discussed support agreements as a way for users who depend on the datasets operationally to help sustain the service.

## Dataset organization

We considered how to organize datasets optimized for different access patterns and variables on different vertical levels. Members weighed separate dataset identifiers against groups and data trees, with STAC providing discovery and metadata. The discussion favored grouping data that is updated or used together; the broader organization question remained open.
