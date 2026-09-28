// Catalog datasets whose page offers the in-browser map explorer: the
// {% explorer entry %} shortcode (plugin.cjs) renders an Explore section for
// these ids only. An id missing from this list gets no Explore section. Per
// dataset:
//
// - initialView: what the map fits on load, bounds [west, south, east, north].
//   - Materialized: the outer frame. Global and US products use CONUS, regional
//     ones their own domain, and the two heaviest analyses Houston. The map opens
//     on at most 6 × 4 of the default variable's chunks centred in it
//     (mount-options.cjs, from the STAC chunk shape), so the first view reads
//     about 24 chunks at most.
//   - Virtual: the whole grid. That is WORLD for the global stores and CONUS for
//     HRRR. Each step reads one whole-grid GRIB message, so the view costs no
//     extra bytes.
// - proj4: overrides the grid mapping read from the store. None is needed:
//   the explorer builds lcc and ob_tran strings from the stores' CF attrs (the
//   strings it built are noted beside HRRR and HRDPS for provenance).
// - defaultVariable: the variable drawn first, a path from entry.variables.
// - virtual: true for a -virtual store, whose chunks are byte ranges of the
//   upstream GRIB files (NOAA/ECMWF buckets), decoded in the browser. Their
//   first view is mostly store metadata plus one GRIB message, and each lead or
//   time step reads one more message (0.14–1.22 MB).
//
// The comment beside each row records the compressed download measured for its
// first view on 2026-09-25 (headless Chromium, 758×345 CSS px map in a
// 1280-wide page, latest run or time then; snapshots noted where recorded), when
// every row opened on its whole frame and the virtual ones on CONUS.
// Latitudes −60…75 are width-limited in the 16:9 box, so the whole longitude range fits.
const WORLD = [-180, -60, 180, 75];
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
  },
  {
    id: "noaa-gfs-analysis",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 46.03 MB, time 2026-09-25 14:00 (1,440-step chunks, 128-step texture window).
  },
  {
    id: "noaa-gefs-forecast-35-day",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 55.31 MB, init 2026-09-25 00Z, member 0.
  },
  {
    id: "noaa-gefs-analysis",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 14.28 MB, time 2026-09-25 12:00.
  },
  {
    id: "noaa-hrrr-forecast-48-hour",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 58.42 MB, init 2026-09-25 18Z. Grid mapping from CF:
    // +proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +x_0=0 +y_0=0 +a=6371229 +b=6371229 +units=m +no_defs
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
  },
  {
    id: "ecmwf-aifs-single-forecast",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 11.92 MB, init 2026-09-25 12Z.
  },
  {
    id: "ecmwf-aifs-ens-forecast",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 137.51 MB, member 0; every chunk carries all 51 members.
  },
  {
    id: "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 195.48 MB, init 2026-09-25 00Z, member 0; every chunk carries all members.
  },
  {
    id: "ecmwf-ifs-ens-forecast-46-day-daily-1-5-degree",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "average_temperature_2m",
    // 8.51 MB; opens at +24 h, since lead 0 of a 24 h mean is NaN.
  },
  {
    id: "ecmwf-ifs-ens-forecast-46-day-6-hourly-1-5-degree",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "maximum_temperature_2m",
    // 17.99 MB; opens at +6 h, since lead 0 is NaN.
  },
  {
    id: "dwd-icon-eu-forecast-5-day",
    initialView: { bounds: EUROPE },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 51.7 MB, init 2026-09-25 12Z.
  },
  {
    id: "eccc-hrdps-forecast",
    initialView: { bounds: CANADA },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 114.32 MB, init 2026-09-25 12Z. Rotated-pole grid mapping from CF:
    // +proj=ob_tran +o_proj=longlat +o_lat_p=36.08852 +o_lon_p=0 +lon_0=245.305142 +a=6371229 +b=6371229 +no_defs
  },
  {
    id: "nasa-imerg-analysis-early",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "precipitation_surface",
    // 87.93 MB, time 2026-09-25 15:30.
  },
  {
    id: "nasa-imerg-analysis-late",
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "precipitation_surface",
    // 88.67 MB, time 2026-09-25 05:30.
  },
  // Virtual stores. The row comments are from the virtual hook-up run on 2026-09-25
  // (same browser and map size as above, CONUS view): store metadata plus the
  // latest-run probe and one GRIB message. Snapshots were recorded only for
  // the four products checked for registration.
  {
    id: "noaa-gfs-forecast-virtual",
    virtual: true,
    initialView: { bounds: WORLD },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 7.17 MB (6.66 store + 0.51 GRIB), snapshot H5G8BVY2PBVRXA6A6VKG, init
    // 2026-09-25 12Z (18Z's final lead wasn't in yet).
  },
  {
    id: "noaa-gfs-analysis-virtual",
    virtual: true,
    initialView: { bounds: WORLD },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 0.79 MB (0.28 store + 0.51 GRIB), time 2026-09-25 23:00.
  },
  {
    id: "noaa-gefs-forecast-10-day-0-25-degree-virtual",
    virtual: true,
    initialView: { bounds: WORLD },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 2.65 MB (2.21 store + 0.44 GRIB), init 2026-09-25 12Z, member 0.
  },
  {
    id: "noaa-gefs-forecast-16-day-0-5-degree-virtual",
    virtual: true,
    initialView: { bounds: WORLD },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 24.07 MB, almost all its 23.9 MB snapshot file; snapshot
    // XEXMCCBSAEXMXQMWY0QG, init 2026-09-25 12Z, member 0.
  },
  {
    id: "noaa-gefs-forecast-35-day-0-5-degree-virtual",
    virtual: true,
    initialView: { bounds: WORLD },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 6.39 MB (6.25 store + 0.14 GRIB), init 2026-09-24 00Z (09-25 00Z's +840 h
    // wasn't in yet), member 0.
  },
  {
    id: "noaa-gefs-analysis-0-25-degree-virtual",
    virtual: true,
    initialView: { bounds: WORLD },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 0.58 MB (0.15 store + 0.43 GRIB), time 2026-09-25 21:00.
  },
  {
    id: "noaa-hrrr-forecast-48-hour-virtual",
    virtual: true,
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 2.79 MB (1.56 store + 1.23 GRIB), snapshot 7EKK9FHTNE8B8ZAN0TWG, init
    // 2026-09-25 18Z. LCC grid; proj4 built from CF as for
    // noaa-hrrr-forecast-48-hour.
  },
  {
    id: "noaa-hrrr-forecast-18-hour-virtual",
    virtual: true,
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 3.75 MB (2.52 store + 1.22 GRIB), init 2026-09-25 20Z. LCC grid.
  },
  {
    id: "noaa-hrrr-analysis-virtual",
    virtual: true,
    initialView: { bounds: CONUS },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 1.68 MB (0.46 store + 1.22 GRIB), time 2026-09-25 21:00. LCC grid.
  },
  {
    id: "ecmwf-aifs-single-forecast-virtual",
    virtual: true,
    initialView: { bounds: WORLD },
    proj4: null,
    defaultVariable: "temperature_2m",
    // 0.81 MB (0.19 store + 0.62 GRIB), snapshot X4G5D2WQDY7YXXM53XD0, init
    // 2026-09-25 12Z.
  },
];

module.exports = { datasets };
