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
    if ("initialViewName" in dataset) assert.equal(typeof dataset.initialViewName, "string");
    const { bounds } = dataset.initialView;
    assert.equal(bounds.length, 4);
    assert.ok(bounds[0] < bounds[2] && bounds[1] < bounds[3], `${dataset.id} bounds are west, south, east, north`);
  }
});

const { borderPath, fitBounds, previewSvg } = require("../lib/explorer-preview.js");

const near = (actual, expected) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) < 0.01),
    `${actual.join(", ")} is not ${expected.join(", ")}`,
  );

test("the preview's projection fits bounds into the frame as mount() does", () => {
  // A box of ±45° on the equator in 1000 × 1000 less 20 of padding: height
  // limits it (Mercator stretches latitude), centred.
  const box = { width: 1000, height: 1000, padding: 20 };
  const square = fitBounds([-45, -45, 45, 45], box);
  near(square([0, 0]), [500, 500]);
  // y = (1 - ln(tan(67.5°)) / π) / 2 = 0.359725 of the world, so 45° is
  // 0.140275 of it above the equator, and that spans 480 units
  const scale = 480 / 0.140275;
  near(square([0, 45]), [500, 20]);
  near(square([0, -45]), [500, 980]);
  near(square([45, 0]), [500 + scale / 8, 500]);

  // A wide box is limited by width instead: its west and east edges sit on the
  // padding.
  const wide = fitBounds([-60, -5, 60, 5], { width: 778, height: 356, padding: 20 });
  near(wide([-60, 0]), [20, 178]);
  near(wide([60, 0]), [758, 178]);

  // Below zoom 0 (the world narrower than 512) mount() holds zoom 0.
  const world = fitBounds([-180, -85, 180, 85], { width: 400, height: 300, padding: 20 });
  near(world([-180, 0]), [200 - 256, 150]);
  near(world([180, 0]), [200 + 256, 150]);
});

test("the preview's borders are cut to the frame", () => {
  const project = ([x, y]) => [x, y];
  const frame = { width: 100, height: 100 };
  // one line in, across and out; one wholly outside; one whose middle point is
  // too close to the last kept one; one that rounds to a single point
  const d = borderPath(
    [
      [[-50, 50], [-20, 50], [10, 50], [50, 50], [90, 50], [130, 50], [160, 50]],
      [[200, 200], [300, 300]],
      [[10.2, 10.4], [11, 10], [20, 5]],
      [[50.2, 60], [50.4, 60.3]],
    ],
    project,
    frame,
  );
  assert.equal(d, "M-20 50l30 0 40 0 40 0 40 0M10 10l10-5");
});

test("the preview is an SVG path of the topology's borders in the site's colours", () => {
  const topology = {
    type: "Topology",
    objects: { countries: { type: "GeometryCollection", geometries: [{ type: "Polygon", arcs: [[0]] }] } },
    arcs: [[[-100, 30], [-90, 30], [-90, 40], [-100, 40], [-100, 30]]],
  };
  const svg = previewSvg(topology, [-125, 24, -66, 50]);
  assert.match(svg, /^<svg viewBox="0 0 778 437"[^>]* aria-hidden="true"/);
  // a move then relative lines: the square's corners, all in the frame
  const [, d] = /<path d="(M\d+ \d+l[-\d ]+)"/.exec(svg);
  assert.equal(d.match(/-?\d+/g).length, 10);
  assert.match(svg, /stroke="var\(--text-color\)"/);
});
