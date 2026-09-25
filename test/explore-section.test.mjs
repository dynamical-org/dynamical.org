import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { explorerMountOptions } = require("../lib/explorer-config.js");

const HREF = "https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-forecast/v0.2.7.icechunk";

const entry = {
  id: "noaa-gfs-forecast",
  assets: { "icechunk-https": { href: HREF } },
  variables: [
    {
      name: "temperature_2m",
      long_name: "2 metre temperature",
      units: "degree_Celsius",
      dimension_names: ["init_time", "lead_time", "latitude", "longitude"],
      comment: "not passed on",
    },
  ],
  variableGroups: [
    {
      name: "isobaric",
      variables: [
        {
          name: "temperature",
          long_name: "Temperature",
          units: "degree_Celsius",
          dimension_names: ["init_time", "lead_time", "pressure_level", "latitude", "longitude"],
        },
      ],
    },
  ],
};

const datasets = [
  {
    id: "noaa-gfs-forecast",
    initialView: { bounds: [-125, 24, -66, 50] },
    proj4: null,
    defaultVariable: "temperature_2m",
    firstViewMB: 7,
  },
];

test("builds mount options for an enabled dataset", () => {
  assert.deepEqual(explorerMountOptions(entry, datasets), {
    id: "noaa-gfs-forecast",
    href: HREF,
    variables: [
      {
        path: "temperature_2m",
        name: "temperature_2m",
        long_name: "2 metre temperature",
        units: "degree_Celsius",
        dims: ["init_time", "lead_time", "latitude", "longitude"],
      },
      {
        path: "isobaric/temperature",
        name: "temperature",
        long_name: "Temperature",
        units: "degree_Celsius",
        dims: ["init_time", "lead_time", "pressure_level", "latitude", "longitude"],
      },
    ],
    defaultVariable: "temperature_2m",
    initialView: { bounds: [-125, 24, -66, 50] },
    proj4: null,
  });
});

test("passes the virtual flag through only when a dataset sets it", () => {
  const virtual = [{ ...datasets[0], virtual: true }];
  assert.equal(explorerMountOptions(entry, virtual).virtual, true);
  assert.equal("virtual" in explorerMountOptions(entry, datasets), false);
});

test("returns null for datasets without the explorer or an HTTPS store", () => {
  assert.equal(explorerMountOptions({ ...entry, id: "noaa-hrrr-analysis" }, datasets), null);
  assert.equal(explorerMountOptions({ ...entry, assets: {} }, datasets), null);
});

test("every enabled dataset in _data/explorer.js is well formed", () => {
  const enabled = require("../_data/explorer.js").datasets;
  assert.ok(enabled.length > 0);
  assert.equal(new Set(enabled.map((d) => d.id)).size, enabled.length, "ids are unique");
  for (const dataset of enabled) {
    assert.match(dataset.id, /^[a-z0-9-]+$/);
    assert.equal(dataset.virtual === true || !dataset.id.includes("-virtual"), true, `${dataset.id} is virtual but not flagged`);
    assert.equal(typeof dataset.defaultVariable, "string");
    assert.ok(Number.isInteger(dataset.firstViewMB) && dataset.firstViewMB > 0, `${dataset.id} firstViewMB is a whole MB`);
    const { bounds } = dataset.initialView;
    assert.equal(bounds.length, 4);
    assert.ok(bounds[0] < bounds[2] && bounds[1] < bounds[3], `${dataset.id} bounds are west, south, east, north`);
  }
});
