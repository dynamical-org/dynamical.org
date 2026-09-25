const { explorerMountOptions } = require("../lib/explorer-config.js");

// Catalog datasets whose page offers the in-browser map explorer (explorer/,
// mounted by the Explore section of content/catalog-pages.njk). An id missing
// from this list gets no Explore section. Per dataset:
//
// - initialView: what the map fits on load. Global and US products open on
//   CONUS; regional ones on their own domain. Bounds are [west, south, east,
//   north]. A whole-globe or whole-CONUS view reads every tile of the grid,
//   which is why the two heaviest analyses open on Houston instead.
// - proj4: overrides the grid mapping read from the store. None is needed:
//   the explorer builds lcc and ob_tran strings from the stores' CF attrs (the
//   strings it built are noted beside HRRR and HRDPS for provenance).
// - defaultVariable: the variable drawn first, a path from entry.variables.
// - firstViewMB: the caption's "~N MB", rounded: compressed bytes read from S3
//   between open and the first complete frame of defaultVariable at
//   initialView, store discovery included. Re-measure when a store's chunking
//   or a default changes.
// - virtual: set true for a -virtual (GRIB-referencing) store. None are enabled
//   yet; they need the browser GRIB codec, and their own firstViewMB.
//
// Unless noted, firstViewMB is from the explorer's per-product run on
// 2026-09-25 (headless Chromium, 758×345 CSS px map in a 1280-wide page,
// latest run or time at the time; per-product snapshots weren't recorded).
const CONUS = [-125, 24, -66, 50];
const EUROPE = [-12, 35, 35, 62];
const CANADA = [-140, 40, -55, 65];
const HOUSTON = [-97.5, 28.5, -93.5, 31.5];

const datasets = [
  {
    id: "noaa-gfs-forecast",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 8.64 MB, init 2026-09-25 12Z. The earlier spike read 7.02 MB at
    // 1280×800 (snapshot 593MB4JXEPB4TA33RXCG) and 13.2 MB on a phone viewport.
    firstViewMB: 9,
  },
  {
    id: "noaa-gfs-analysis",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 46.03 MB, time 2026-09-25 14:00 (1,440-step chunks, 128-step texture window).
    firstViewMB: 46,
  },
  {
    id: "noaa-gefs-forecast-35-day",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 55.31 MB, init 2026-09-25 00Z, member 0.
    firstViewMB: 55,
  },
  {
    id: "noaa-gefs-analysis",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 14.28 MB, time 2026-09-25 12:00.
    firstViewMB: 14,
  },
  {
    id: "noaa-hrrr-forecast-48-hour",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 58.42 MB, init 2026-09-25 18Z. Grid mapping from CF:
    // +proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +x_0=0 +y_0=0 +a=6371229 +b=6371229 +units=m +no_defs
    firstViewMB: 58,
  },
  {
    id: "noaa-hrrr-analysis",
    initialView: { bounds: HOUSTON },
    proj4: null,
    defaultVariable: "temperature_2m",
    // Re-measured at exactly HOUSTON on 2026-09-25 (snapshot
    // J6MBGMVS8W78D2E403X0, time 2026-09-25 17:00): 40 requests, 44.35 MB.
    // A CONUS view is 960 tiles, about 1,545 MB by shard-index sum. Grid
    // mapping from CF: the same lcc string as noaa-hrrr-forecast-48-hour.
    firstViewMB: 44,
  },
  {
    id: "noaa-mrms-conus-analysis-hourly",
    initialView: { bounds: HOUSTON },
    proj4: null,
    defaultVariable: "precipitation_surface",
    // Re-measured at exactly HOUSTON on 2026-09-25 (snapshot
    // D1WQJT0163H1KMJBRW6G, time 2026-09-25 21:00): 47 requests, 8.65 MB.
    // Fitting this box lands a zoom below the zoom-7 view first measured
    // (4.39 MB), so more tiles are read.
    // A CONUS view is 1,708 chunks, about 387 MB by shard-index sum.
    firstViewMB: 9,
  },
  {
    id: "ecmwf-aifs-single-forecast",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 11.92 MB, init 2026-09-25 12Z.
    firstViewMB: 12,
  },
  {
    id: "ecmwf-aifs-ens-forecast",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 137.51 MB, member 0; every chunk carries all 51 members.
    firstViewMB: 138,
  },
  {
    id: "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 195.48 MB, init 2026-09-25 00Z, member 0; every chunk carries all members.
    firstViewMB: 195,
  },
  {
    id: "ecmwf-ifs-ens-forecast-46-day-daily-1-5-degree",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "average_temperature_2m",
    // 8.51 MB; opens at +24 h, since lead 0 of a 24 h mean is NaN.
    firstViewMB: 9,
  },
  {
    id: "ecmwf-ifs-ens-forecast-46-day-6-hourly-1-5-degree",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "maximum_temperature_2m",
    // 17.99 MB; opens at +6 h, since lead 0 is NaN.
    firstViewMB: 18,
  },
  {
    id: "dwd-icon-eu-forecast-5-day",
    initialView: { bounds: EUROPE },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 51.7 MB, init 2026-09-25 12Z.
    firstViewMB: 52,
  },
  {
    id: "eccc-hrdps-forecast",
    initialView: { bounds: CANADA },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 114.32 MB, init 2026-09-25 12Z. Rotated-pole grid mapping from CF:
    // +proj=ob_tran +o_proj=longlat +o_lat_p=36.08852 +o_lon_p=0 +lon_0=245.305142 +a=6371229 +b=6371229 +no_defs
    firstViewMB: 114,
  },
  {
    id: "nasa-imerg-analysis-early",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "precipitation_surface",
    // 87.93 MB, time 2026-09-25 15:30.
    firstViewMB: 88,
  },
  {
    id: "nasa-imerg-analysis-late",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "precipitation_surface",
    // 88.67 MB, time 2026-09-25 05:30.
    firstViewMB: 89,
  },
];

module.exports = {
  datasets,
  // The template calls explorer.mountOptions(entry); null means no Explore section.
  mountOptions: (entry) => explorerMountOptions(entry, datasets),
};
