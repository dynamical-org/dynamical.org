import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { explorerMountOptions } = require("../site/mount-options.cjs");

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

test("infers virtual from the suffix, with explicit true and false overrides", () => {
  const virtual = [{ ...datasets[0], virtual: true }];
  assert.equal(explorerMountOptions(entry, virtual).virtual, true);
  assert.equal("virtual" in explorerMountOptions(entry, datasets), false);
  const suffixed = { ...entry, id: "new-forecast-virtual" };
  assert.equal(explorerMountOptions(suffixed).virtual, true);
  assert.equal("virtual" in explorerMountOptions(suffixed, [{ id: suffixed.id, virtual: false }]), false);
  assert.equal("virtual" in explorerMountOptions({ ...entry, id: "virtual-in-the-middle" }), false);
});

test("unlisted entries automatically get Explore; only HTTPS Icechunk assets qualify", () => {
  const newEntry = { ...entry, id: "new-unlisted-dataset" };
  assert.equal(explorerMountOptions(newEntry, datasets).id, newEntry.id);
  assert.equal(explorerMountOptions(newEntry).defaultVariable, "temperature_2m");
  assert.equal(explorerMountOptions({ ...entry, assets: {} }, datasets), null);
  for (const href of ["http://example.org/store.icechunk", "s3://bucket/store.icechunk", "/store.icechunk", "invalid"])
    assert.equal(explorerMountOptions({ ...entry, assets: { "icechunk-https": { href } } }), null);
});

test("opt-outs require reasons and take precedence over overrides", () => {
  const optOuts = [{ id: entry.id, reason: "This fixture uses an unsupported grid." }];
  assert.equal(explorerMountOptions(entry, datasets, optOuts), null);
  assert.ok(explorerMountOptions({ ...entry, id: "another-dataset" }, datasets, optOuts));
  for (const reason of [undefined, "", "   "])
    assert.throws(() => explorerMountOptions(entry, datasets, [{ id: entry.id, reason }]), /needs a reason/);
  const configured = require("../site/datasets.cjs").optOuts;
  const overrides = require("../site/datasets.cjs").datasets;
  assert.equal(new Set(configured.map((d) => d.id)).size, configured.length);
  for (const { id, reason } of configured) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(typeof reason === "string" && reason.trim().length > 0, `${id} needs a reason`);
    assert.ok(!overrides.some((d) => d.id === id), `${id} must not also have overrides`);
  }
});

test("dataset overrides may omit any field", () => {
  const options = explorerMountOptions(entry, [{ id: entry.id }]);
  assert.deepEqual(options, explorerMountOptions(entry));
  assert.equal("proj4" in options, false);
  assert.equal(explorerMountOptions(entry, [{ id: entry.id, proj4: "+proj=lcc" }]).proj4, "+proj=lcc");
  const chosen = explorerMountOptions(entry, [{ id: entry.id, defaultVariable: "isobaric/temperature" }]);
  assert.equal(chosen.defaultVariable, "isobaric/temperature");
  assert.deepEqual(chosen.initialView, options.initialView);
  const view = { bounds: [-10, 30, 10, 50] };
  assert.deepEqual(explorerMountOptions(entry, [{ id: entry.id, initialView: view }]).initialView, view);
});

test("every optional dataset override in explorer/site/datasets.cjs is well formed", () => {
  const overrides = require("../site/datasets.cjs").datasets;
  assert.equal(new Set(overrides.map((d) => d.id)).size, overrides.length, "ids are unique");
  for (const dataset of overrides) {
    assert.match(dataset.id, /^[a-z0-9-]+$/);
    if (dataset.virtual !== undefined) assert.equal(typeof dataset.virtual, "boolean");
    if (dataset.defaultVariable !== undefined) assert.equal(typeof dataset.defaultVariable, "string");
    if (dataset.initialView?.bounds) {
      const { bounds } = dataset.initialView;
      assert.equal(bounds.length, 4);
      assert.ok(bounds[0] < bounds[2] && bounds[1] < bounds[3], `${dataset.id} bounds are west, south, east, north`);
    }
  }
});

const { borderPath, fitBounds, previewSvg } = require("../site/preview.cjs");

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

const { exploreSection } = require("../site/plugin.cjs");

test("the explorer shortcode enables an unlisted id and omits entries without HTTPS Icechunk", () => {
  assert.match(exploreSection({ ...entry, id: "new-unlisted-dataset" }, () => "<svg/>"), /<section class="explore"/);
  assert.equal(exploreSection({ ...entry, assets: {} }, () => "<svg/>"), "");
});

test("the explorer shortcode renders the preview, the button and options that round-trip", () => {
  const withQuote = { ...entry, variables: [{ ...entry.variables[0], long_name: `2 "metre" <temp> & 'more'` }] };
  const html = exploreSection(withQuote, () => "<svg>preview</svg>");
  const [, attribute] = /<section class="explore"[^>]* data-options="([^"]*)">/.exec(html);
  const decoded = attribute
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  assert.equal(JSON.parse(decoded).variables[0].long_name, `2 "metre" <temp> & 'more'`);
  assert.match(html, /<div class="explore-map">\s*<svg>preview<\/svg>\s*<button type="button">Load interactive map<\/button>/);
  assert.match(html, /^<style>[^]*\.explore-map \{[^]*<\/style>/);
  assert.match(html, /<script type="module">[^]*import\("\/explorer\/explorer\.js"\)[^]*<\/script>$/);
});

const { chunkView } = require("../site/mount-options.cjs");

// A STAC cube for one variable: chunk cells per spatial dim over a dim's extent and size.
const cube = (dims, chunks, spatial) => ({
  "cube:variables": { temperature_2m: { dimensions: dims, chunks } },
  "cube:dimensions": spatial,
});
const LATLON = { latitude: { extent: [-90, 90], size: 721, unit: "degree_north" }, longitude: { extent: [-180, 179.75], size: 1440, unit: "degree_east" } };
const CONUS_ROW = { id: "x", defaultVariable: "temperature_2m", initialView: { bounds: [-125, 24, -66, 50] } };
const RAD = Math.PI / 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / RAD;
const latOf = (y) => (2 * Math.atan(Math.exp(y * RAD)) - Math.PI / 2) / RAD;
// The desktop frame, 778 × 437, fits bounds inside 20 px of padding: 738 × 397.
const ASPECT = 738 / 397;

test("all existing dataset views and default variables remain unchanged", () => {
  const overrides = require("../site/datasets.cjs").datasets;
  // Frozen pre-default policy, independent of the implementation's override rows.
  const legacy = [
    ["noaa-gfs-forecast", "conus"], ["noaa-gfs-analysis", "conus"],
    ["noaa-gefs-forecast-35-day", "conus"], ["noaa-gefs-analysis", "conus"],
    ["noaa-hrrr-forecast-48-hour", "conus"], ["noaa-hrrr-analysis", "houston"],
    ["noaa-mrms-conus-analysis-hourly", "houston", "precipitation_surface"],
    ["ecmwf-aifs-single-forecast", "conus"], ["ecmwf-aifs-ens-forecast", "conus"],
    ["ecmwf-ifs-ens-forecast-15-day-0-25-degree", "conus"],
    ["ecmwf-ifs-ens-forecast-46-day-daily-1-5-degree", "conus", "average_temperature_2m"],
    ["ecmwf-ifs-ens-forecast-46-day-6-hourly-1-5-degree", "conus", "maximum_temperature_2m"],
    ["dwd-icon-eu-forecast-5-day", "europe"], ["eccc-hrdps-forecast", "canada"],
    ["nasa-imerg-analysis-early", "conus", "precipitation_surface"],
    ["nasa-imerg-analysis-late", "conus", "precipitation_surface"],
    ["noaa-gfs-forecast-virtual", "world"], ["noaa-gfs-analysis-virtual", "world"],
    ["noaa-gefs-forecast-10-day-0-25-degree-virtual", "world"],
    ["noaa-gefs-forecast-16-day-0-5-degree-virtual", "world"],
    ["noaa-gefs-forecast-35-day-0-5-degree-virtual", "world"],
    ["noaa-gefs-analysis-0-25-degree-virtual", "world"],
    ["noaa-hrrr-forecast-48-hour-virtual", "conus"], ["noaa-hrrr-forecast-18-hour-virtual", "conus"],
    ["noaa-hrrr-analysis-virtual", "conus"], ["ecmwf-aifs-single-forecast-virtual", "world"],
  ];
  const frames = { conus: [-125, 24, -66, 50], houston: [-97.5, 28.5, -93.5, 31.5],
    europe: [-12, 35, 35, 62], canada: [-140, 40, -55, 65], world: [-180, -60, 180, 75] };
  for (const [id, frame, variable = "temperature_2m"] of legacy) {
    const options = explorerMountOptions({ ...entry, id, spatial_bbox: [-180, -90, 180, 90] }, overrides);
    assert.deepEqual(options.initialView, { bounds: frames[frame] }, id);
    assert.equal(options.defaultVariable, variable, id);
    assert.equal(options.proj4, null, id);
    assert.equal(options.virtual === true, id.endsWith("-virtual"), id);
  }
});

test("new initial views use bbox before extent before domain, and stay Mercator-safe", () => {
  const view = (metadata) => explorerMountOptions({ ...entry, ...metadata }).initialView.bounds;
  assert.deepEqual(view({ spatial_bbox: [-20, 30, 25, 60], extent: { spatial: { bbox: [[-180, -90, 180, 90]] } } }), [-20, 30, 25, 60]);
  assert.deepEqual(view({ spatial_bbox: [NaN, 0, 1, 2], extent: { spatial: { bbox: [[10, -20, 40, 30]] } } }), [10, -20, 40, 30]);
  assert.deepEqual(view({ spatial_bbox: [-20, 30, -100, 25, 60, 1000] }), [-20, 30, 25, 60]);
  const polar = view({ spatial_bbox: [10, -90, 30, 90] });
  assert.deepEqual([polar[0], polar[2]], [10, 30]);
  assert.ok(polar[1] > -90 && polar[3] < 90);
  assert.ok(polar.every(Number.isFinite));
  assert.deepEqual(view({ spatial_bbox: [170, -20, -170, 20] }), [170, -20, 190, 20]);
  assert.deepEqual(view({ spatial_bbox: [200, -20, 240, 20] }), [-160, -20, -120, 20]);
  assert.deepEqual(view({ spatial_bbox: [0, -90, 360, 90] }), [-125, 24, -66, 50]);
  assert.deepEqual(view({ id: "global-virtual", spatial_bbox: [-180, -90, 180, 90] }), [-180, -60, 180, 75]);
  assert.deepEqual(view({ spatial_domain: "Continental United States" }), [-125, 24, -66, 50]);
  assert.deepEqual(view({ summaries: { spatial_domain: ["Global land, 60N-60S"] } }), [-180, -60, 180, 60]);
  assert.deepEqual(view({ spatial_domain: "Canada" }), [-140, 40, -55, 65]);
  assert.deepEqual(view({ spatial_domain: "Europe" }), [-12, 35, 35, 62]);
  assert.deepEqual(view({ spatial_bbox: [0, 0, 0, 0] }), [-180, -60, 180, 75]);
});

test("derived variables prefer temperature then precipitation then a drawable spatial path", () => {
  const variable = (name, dimension_names = ["time", "latitude", "longitude"]) => ({ name, dimension_names });
  const choose = (variables, extra = {}) => explorerMountOptions({ ...entry, variableGroups: [], variables, ...extra }).defaultVariable;
  const rain = variable("precipitation_surface");
  const temp = variable("temperature_2m");
  const wind = variable("wind_speed");
  assert.equal(choose([wind, rain, temp]), "temperature_2m");
  assert.equal(choose([wind, rain]), "precipitation_surface");
  assert.equal(choose([variable("crs", []), variable("station_temp", ["station"]), wind]), "wind_speed");
  assert.equal(choose([variable("temperature_2m", []), rain]), "precipitation_surface");
  assert.equal(choose([variable("temperature", ["time", "y", "x", "level"]), rain]), "precipitation_surface");
  const nested = { variableGroups: [{ name: "level", variables: [variable("wind", ["time", "y", "x", "level"])] }] };
  assert.equal(choose([], { id: "new-virtual", ...nested }), "level/wind");
  assert.equal(choose([variable("crs", [])]), undefined);
});

test("all eight new products are enabled, with derived frames and one variable override", () => {
  const overrides = require("../site/datasets.cjs").datasets;
  const regional = [-134.09547424316406, 21.13812255859375, -60.91719436645508, 52.61565399169922];
  const ids = ["noaa-rrfs-forecast-sub-hourly-virtual", "noaa-rrfs-forecast-18-hour-virtual",
    "noaa-rrfs-forecast-84-hour-virtual", "noaa-rrfs-ens-forecast-virtual",
    "noaa-refs-forecast-hourly-virtual", "noaa-refs-forecast-3-hourly-virtual"];
  for (const id of ids) {
    const variable = id === "noaa-refs-forecast-3-hourly-virtual" ? "total_precipitation_3_hour_surface" : "temperature_2m";
    const options = explorerMountOptions({ ...entry, id, spatial_bbox: regional,
      variables: [{ name: variable, dimension_names: ["init_time", "lead_time", "y", "x"] }],
      variableGroups: [],
      ...cube(["init_time", "lead_time", "y", "x"], [1, 1, 1059, 1799], {
        x: { extent: [-2697520, 2696480], size: 1799, unit: "m" },
        y: { extent: [-1587306, 1586694], size: 1059, unit: "m" },
      }),
    }, overrides);
    assert.deepEqual(options.initialView.bounds, [-125, 24, -66, 50], id);
    assert.equal(options.defaultVariable, variable, id);
    assert.equal(options.virtual, true, id);
    assert.equal("proj4" in options, false, "CF Lambert mapping is used at runtime");
  }
  for (const id of ["ucsb-chc-chirps-analysis-final", "ucsb-chc-chirps-analysis-preliminary"]) {
    const chirps = { ...entry, id, variableGroups: [],
      spatial_bbox: [-179.975, -59.975, 179.975, 59.975],
      variables: [{ name: "precipitation_surface", dimension_names: ["time", "latitude", "longitude"] }],
    };
    const options = explorerMountOptions(chirps);
    assert.deepEqual(options.initialView.bounds, [-125, 24, -66, 50]);
    assert.equal(options.defaultVariable, "precipitation_surface");
    assert.equal("virtual" in options, false);
    const chunked = explorerMountOptions({ ...chirps,
      "cube:variables": { precipitation_surface: { dimensions: ["time", "latitude", "longitude"], chunks: [365, 60, 60] } },
      "cube:dimensions": {
        latitude: { extent: [-59.975, 59.975], size: 2400, unit: "degree_north" },
        longitude: { extent: [-179.975, 179.975], size: 7200, unit: "degree_east" },
      },
    });
    const view = shown(chunked.initialView.bounds);
    assert.ok(Math.abs(view.lon + 95.5) < 0.01, "CHIRPS opens over the southern Plains, not at (0, 0)");
    assert.ok(Math.abs(view.width - 18) < 0.01 && view.height <= 12, "CHIRPS obeys the 6 × 4 chunk budget");
  }
});

// Bounds as the frame shows them, padding included: the width and height in degrees
// the whole frame covers, the bounds' Mercator aspect, and their centre.
function shown([w, s, e, n]) {
  const y = (mercY(s) + mercY(n)) / 2;
  const h = ((mercY(n) - mercY(s)) * 437) / 397;
  return { width: ((e - w) * 778) / 738, height: latOf(y + h / 2) - latOf(y - h / 2), aspect: (e - w) / (mercY(n) - mercY(s)), lon: (w + e) / 2, y };
}

test("a view that already shows at most 6 × 4 chunks is left as it is", () => {
  // GFS: 121-cell (30.25°) chunks, so CONUS shows about 2 × 1 of them.
  const entry = cube(["init_time", "lead_time", "latitude", "longitude"], [1, 105, 121, 121], LATLON);
  assert.deepEqual(chunkView(entry, CONUS_ROW), { bounds: [-125, 24, -66, 50] });
});

test("the view shrinks about its centre, at the map's aspect, to 6 chunks across or 4 down", () => {
  const before = shown(CONUS_ROW.initialView.bounds);
  // IFS ENS 0.25°: 32-cell (8°) chunks. CONUS as the frame shows it is about 64° wide, 8
  // chunks, and 3.5 down: width limits, so it shrinks to show 48° across.
  const ens = cube(["init_time", "lead_time", "ensemble_member", "latitude", "longitude"], [1, 85, 51, 32, 32], LATLON);
  const a = shown(chunkView(ens, CONUS_ROW).bounds);
  assert.ok(Math.abs(a.width - 48) < 0.01, `${a.width}`);
  assert.ok(a.height / 8 <= 4);
  // GEFS 35-day: 17 × 16 cells (4.25° × 4°); width limits again, at 24° shown.
  const gefs = cube(["init_time", "ensemble_member", "lead_time", "latitude", "longitude"], [1, 31, 64, 17, 16], LATLON);
  const b = shown(chunkView(gefs, CONUS_ROW).bounds);
  assert.ok(Math.abs(b.width - 24) < 0.01, `${b.width}`);
  assert.ok(b.height / 4.25 <= 4);
  // Wide chunks (5° × 20°): height limits instead, at 4 down, 20° shown (Mercator makes it approximate).
  const tall = cube(["time", "latitude", "longitude"], [1, 20, 80], LATLON);
  const c = shown(chunkView(tall, CONUS_ROW).bounds);
  assert.ok(Math.abs(c.height - 20) < 0.1, `${c.height}`);
  assert.ok(c.width / 20 <= 6);
  for (const v of [a, b, c]) {
    assert.ok(Math.abs(v.aspect - ASPECT) < 0.01, `aspect ${v.aspect}`);
    assert.ok(Math.abs(v.lon - before.lon) < 0.01 && Math.abs(v.y - before.y) < 0.01, "same centre");
  }
});

test("projected chunks are converted to degrees at the view's centre", () => {
  const lat = (Math.atan(Math.sinh(shown(CONUS_ROW.initialView.bounds).y * RAD)) / RAD) * RAD;
  // Metres (HRRR's lcc): 100 cells of 3 km = 300 km chunks, so 1800 km across.
  const hrrr = cube(["time", "y", "x"], [1, 100, 100], {
    y: { extent: [0, 3000 * 999], size: 1000, unit: "m" },
    x: { extent: [0, 3000 * 999], size: 1000, unit: "m" },
  });
  const a = shown(chunkView(hrrr, CONUS_ROW).bounds);
  assert.ok(Math.abs(a.width - 1800 / (111.2 * Math.cos(lat))) < 0.01, `${a.width}`);
  // Rotated-pole degrees (HRDPS) are great-circle degrees: 1° cells, 3-cell chunks.
  const hrdps = cube(["time", "y", "x"], [1, 3, 3], {
    y: { extent: [0, 99], size: 100, unit: "degrees" },
    x: { extent: [0, 99], size: 100, unit: "degrees" },
  });
  const b = shown(chunkView(hrdps, CONUS_ROW).bounds);
  assert.ok(Math.abs(b.width - 18 / Math.cos(lat)) < 0.01, `${b.width}`);
});

test("without chunk metadata, or for a virtual row, the row's view is kept", () => {
  assert.deepEqual(chunkView({}, CONUS_ROW), CONUS_ROW.initialView);
  const entry = cube(["init_time", "lead_time", "latitude", "longitude"], [1, 1, 32, 32], LATLON);
  assert.deepEqual(chunkView(entry, { ...CONUS_ROW, virtual: true }), CONUS_ROW.initialView);
  const unknownUnit = cube(["time", "y", "x"], [1, 2, 2], { y: { extent: [0, 9], size: 10, unit: "furlong" }, x: { extent: [0, 9], size: 10, unit: "furlong" } });
  assert.deepEqual(chunkView(unknownUnit, CONUS_ROW), CONUS_ROW.initialView);
});

test("the preview is drawn for the view the map opens on", () => {
  const withCube = { ...entry, ...cube(["init_time", "lead_time", "ensemble_member", "latitude", "longitude"], [1, 85, 51, 32, 32], LATLON) };
  const html = exploreSection(withCube, (bounds) => `<svg data-bounds="${bounds.join(",")}"></svg>`);
  const [, attr] = /<svg data-bounds="([^"]+)">/.exec(html);
  assert.deepEqual(attr.split(",").map(Number), chunkView(withCube, { id: "noaa-gfs-forecast", defaultVariable: "temperature_2m", initialView: { bounds: [-125, 24, -66, 50] } }).bounds);
});

// Round 5 (Marsh, 2026-09-28): on the world view the preview drew straight lines across
// the map. A border that crosses the antimeridian (Chukotka, Fiji) steps from +180° to
// −180°; with both ends in the frame, the step was drawn as a line across it.
test("a border crossing the antimeridian draws no line across the world preview", () => {
  const topology = {
    type: "Topology",
    objects: { countries: { type: "GeometryCollection", geometries: [{ type: "LineString", arcs: [0] }] } },
    arcs: [[[170, 65], [179.9, 66], [-179.9, 66], [-170, 65]]],
  };
  const svg = previewSvg(topology, [-180, -60, 180, 75]);
  const [, d] = /<path d="([^"]*)"/.exec(svg);
  // Every relative step is short: nothing spans half the 778-unit frame.
  const steps = [...d.matchAll(/l([-\d ]+)/g)].flatMap(([, run]) => {
    const n = run.match(/-?\d+/g).map(Number);
    return n.flatMap((v, i) => (i % 2 ? [] : [Math.abs(v)]));
  });
  assert.ok(steps.length > 0, `path ${d}`);
  assert.ok(Math.max(...steps) < 389, `a step of ${Math.max(...steps)} units in ${d}`);
});
