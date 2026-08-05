import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const migration = require("../_data/legacyZarrMigration.js");

const EXPECTED_ROUTES = [
  "/noaa/gfs/forecast",
  "/noaa/gfs/analysis",
  "/noaa/gfs/analysis-hourly",
  "/noaa/gefs/forecast-35-day",
  "/noaa/gefs/analysis",
  "/noaa/hrrr/forecast-48-hour",
  "/noaa/hrrr/analysis",
  "/noaa/mrms/conus-analysis-hourly",
  "/ecmwf/ifs-ens/forecast-15-day-0-25-degree",
  "/ecmwf/aifs-single/forecast",
  "/dwd/icon-eu/forecast-5-day",
];

test("legacy migration data covers every proxy route exactly once", () => {
  assert.equal(migration.sunset, "2026-09-01T00:00:00Z");
  assert.equal(migration.path, "/migrate-from-zarr/");
  assert.deepEqual(
    migration.routes.map(({ legacyPath }) => legacyPath),
    EXPECTED_ROUTES,
  );
  assert.equal(new Set(migration.routes.map(({ legacyPath }) => legacyPath)).size, 11);
});

test("the retired hourly GFS route points to the current GFS analysis", () => {
  const route = migration.routes.find(
    ({ legacyPath }) => legacyPath === "/noaa/gfs/analysis-hourly",
  );
  assert.equal(route.datasetId, "noaa-gfs-analysis");
  assert.match(route.note, /replaced/i);
});

test("catalog notices are scoped to mapped replacement datasets", () => {
  const template = readFileSync(
    new URL("../content/catalog-pages.njk", import.meta.url),
    "utf8",
  );
  assert.match(template, /legacyZarrMigration\.affectedDatasetIds\[entry\.id\]/);
  assert.match(template, /legacyZarrMigration\.path/);
  assert.equal(Object.keys(migration.affectedDatasetIds).length, 10);
});

test("migration guide documents both supported access patterns and every route", () => {
  const guide = readFileSync(
    new URL("../content/migrate-from-zarr.njk", import.meta.url),
    "utf8",
  );
  assert.match(guide, /dynamical_catalog\.open/);
  assert.match(guide, /icechunk-https/);
  assert.match(guide, /stac\.dynamical\.org\/catalog\.json/);
  assert.match(guide, /legacyZarrMigration\.routes/);
});
