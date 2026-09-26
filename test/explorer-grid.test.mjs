// Offline tests of the explorer's spatial adapter (explorer/src/lib/grid.js).
import assert from "node:assert/strict";
import test from "node:test";
import { buildGrid, cfToProj4, nearestCell, shiftAttrs, uniformAxis } from "../explorer/src/lib/grid.js";

const range = (start, step, n) => Array.from({ length: n }, (_, i) => start + i * step);

test("descending latitude, -180..180 longitude: GFS-style node-registered transform", () => {
  const g = buildGrid({ yName: "latitude", xName: "longitude", y: range(90, -0.25, 721), x: range(-180, 0.25, 1440) });
  assert.deepEqual(g.attrs, {
    "spatial:dimensions": ["latitude", "longitude"],
    "spatial:transform": [0.25, 0, -180, 0, -0.25, 90],
    "spatial:shape": [721, 1440],
    "spatial:registration": "node",
    "proj:code": "EPSG:4326",
  });
  assert.deepEqual(g.crs, { kind: "geographic" });
  assert.deepEqual(g.wrapOffsets, [0]);
});

test("ascending latitude gives a positive y step", () => {
  const g = buildGrid({ yName: "latitude", xName: "longitude", y: range(-90, 1.5, 121), x: range(-180, 1.5, 240) });
  assert.deepEqual(g.attrs["spatial:transform"], [1.5, 0, -180, 0, 1.5, -90]);
  assert.equal(nearestCell(g.y, -45), 30);
  assert.equal(nearestCell(g.y, 90), 120);
});

test("0..360 longitude keeps its origin and asks for a -360 copy", () => {
  const g = buildGrid({ yName: "latitude", xName: "longitude", y: range(90, -1, 181), x: range(0, 1, 360) });
  assert.deepEqual(g.attrs["spatial:transform"], [1, 0, 0, 0, -1, 90]);
  assert.deepEqual(g.wrapOffsets, [0, -360]);
  assert.deepEqual(shiftAttrs(g.attrs, -360)["spatial:transform"], [1, 0, -360, 0, -1, 90]);
  assert.equal(shiftAttrs(g.attrs, 0), g.attrs);
});

test("non-uniform coordinates are rejected with the coordinate named", () => {
  const lat = range(90, -1, 10);
  lat[5] += 0.3;
  assert.throws(() => uniformAxis(lat, "latitude"), /"latitude" is not uniformly spaced \(value 5/);
  assert.throws(() => uniformAxis([1], "x"), /need at least 2/);
  assert.throws(() => uniformAxis([1, 1, 1], "x"), /zero or non-finite spacing/);
});

test("float noise in coordinates (HRDPS-style) is accepted", () => {
  const x = range(-14.82122, 0.0225, 2540).map((v, i) => v + (i % 3) * 1e-9);
  const a = uniformAxis(x, "x");
  assert.ok(Math.abs(a.step - 0.0225) < 1e-9);
});

test("latitudes outside -90..90 are rejected", () => {
  assert.throws(
    () => buildGrid({ yName: "latitude", xName: "longitude", y: range(100, -1, 20), x: range(0, 1, 10) }),
    /outside -90\.\.90/,
  );
});

const HRRR_GM = {
  grid_mapping_name: "lambert_conformal_conic",
  standard_parallel: [38.5, 38.5],
  longitude_of_central_meridian: -97.5,
  latitude_of_projection_origin: 38.5,
  false_easting: 0,
  false_northing: 0,
  semi_major_axis: 6371229,
  semi_minor_axis: 6371229,
};

test("proj4 string from CF lambert_conformal_conic (HRRR)", () => {
  assert.equal(
    cfToProj4(HRRR_GM),
    "+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +x_0=0 +y_0=0 +a=6371229 +b=6371229 +units=m +no_defs",
  );
  assert.equal(cfToProj4({ ...HRRR_GM, standard_parallel: 25, semi_major_axis: undefined, semi_minor_axis: undefined }).includes("+lat_1=25 +lat_2=25"), true);
  assert.match(cfToProj4({ ...HRRR_GM, semi_major_axis: undefined, semi_minor_axis: undefined }), /\+ellps=WGS84/);
});

test("proj4 string from CF rotated_latitude_longitude (HRDPS)", () => {
  assert.equal(
    cfToProj4({
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 36.08852,
      grid_north_pole_longitude: 65.305142,
      semi_major_axis: 6371229,
      semi_minor_axis: 6371229,
    }),
    "+proj=ob_tran +o_proj=longlat +o_lat_p=36.08852 +o_lon_p=0 +lon_0=245.305142 +a=6371229 +b=6371229 +no_defs",
  );
});

test("latitude_longitude has no proj4 string; unknown mappings throw", () => {
  assert.equal(cfToProj4({ grid_mapping_name: "latitude_longitude" }), null);
  assert.equal(cfToProj4(null), null);
  assert.throws(() => cfToProj4({ grid_mapping_name: "polar_stereographic" }), /Unsupported grid mapping "polar_stereographic"/);
});

test("projected grids use the local CRS placeholder and their own units", () => {
  const g = buildGrid({
    yName: "y",
    xName: "x",
    y: range(1586693.85, -3000, 1059),
    x: range(-2697520.14, 3000, 1799),
    gridMapping: HRRR_GM,
  });
  assert.equal(g.attrs["proj:code"], "EPSG:0");
  assert.deepEqual(g.attrs["spatial:transform"], [3000, 0, -2697520.14, 0, -3000, 1586693.85]);
  assert.equal(g.crs.kind, "projected");
  assert.equal(g.crs.units, "m");
  const rot = buildGrid({ yName: "y", xName: "x", y: range(16.7, -0.0225, 10), x: range(-14.8, 0.0225, 10), proj4: "+proj=ob_tran +o_proj=longlat +o_lat_p=36 +lon_0=245 +no_defs" });
  assert.equal(rot.crs.units, "degree");
  assert.equal(rot.crs.proj4.startsWith("+proj=ob_tran"), true, "config.proj4 overrides the CF mapping");
});
