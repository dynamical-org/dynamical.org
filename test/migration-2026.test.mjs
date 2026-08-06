import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const guide = read("../content/migration-2026.njk");
const catalogPages = read("../content/catalog-pages.njk");

const EXPECTED_URLS = [
  "data.dynamical.org/noaa/gfs/forecast/latest.zarr",
  "data.dynamical.org/noaa/gfs/analysis/latest.zarr",
  "data.dynamical.org/noaa/gfs/analysis-hourly/latest.zarr",
  "data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr",
  "data.dynamical.org/noaa/gefs/analysis/latest.zarr",
  "data.dynamical.org/noaa/hrrr/forecast-48-hour/latest.zarr",
  "data.dynamical.org/noaa/hrrr/analysis/latest.zarr",
  "data.dynamical.org/noaa/mrms/conus-analysis-hourly/latest.zarr",
  "data.dynamical.org/ecmwf/ifs-ens/forecast-15-day-0-25-degree/latest.zarr",
  "data.dynamical.org/ecmwf/aifs-single/forecast/latest.zarr",
  "data.dynamical.org/dwd/icon-eu/forecast-5-day/latest.zarr",
];

const matchAll = (source, pattern) => [...source.matchAll(pattern)].map((m) => m[1]);

test("the guide maps every data.dynamical.org URL exactly once", () => {
  assert.deepEqual(
    matchAll(guide, /<code>(data\.dynamical\.org\/[^<]+)<\/code>/g),
    EXPECTED_URLS,
  );
});

test("the guide documents both supported access patterns", () => {
  assert.match(guide, /dynamical_catalog\.open/);
  assert.match(guide, /icechunk-https/);
  assert.match(guide, /stac\.dynamical\.org\/catalog\.json/);
});

test("catalog notices are scoped to the guide's replacement datasets", () => {
  const noticed = matchAll(
    catalogPages.match(/{% if entry\.id in \[[^\]]+\] %}/)[0],
    /"([^"]+)"/g,
  );
  const replacements = matchAll(guide, /href="\/catalog\/([^/]+)\//g);

  assert.deepEqual(new Set(noticed), new Set(replacements));
  assert.equal(noticed.length, 10);
  assert.match(catalogPages, /href="\/migration-2026\/"/);
});
