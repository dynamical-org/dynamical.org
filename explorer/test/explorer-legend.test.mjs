import assert from "node:assert/strict";
import { test } from "node:test";

import { formatUnits, initialRange, legendParts, sampleRange } from "../src/lib/colour.js";

test("units read as written, in familiar notation, with no unit for a dimensionless 1", () => {
  assert.equal(formatUnits("kg m-2 s-1"), "kg m⁻² s⁻¹");
  assert.equal(formatUnits("m s-1"), "m s⁻¹");
  assert.equal(formatUnits("m2 s-2"), "m² s⁻²");
  assert.equal(formatUnits("W m**-2"), "W m⁻²");
  assert.equal(formatUnits("W m^-2"), "W m⁻²");
  assert.equal(formatUnits("percent"), "%");
  assert.equal(formatUnits("degree_Celsius"), "°C");
  assert.equal(formatUnits("K"), "K");
  assert.equal(formatUnits("Pa"), "Pa");
  assert.equal(formatUnits("1"), "");
  assert.equal(formatUnits(""), "");
  assert.equal(formatUnits(undefined), "");
});

test("the legend: low value, high value and units, and nothing about samples", () => {
  const r = { min: 2.5, max: 37, kind: "sample", status: "ok" };
  assert.deepEqual(legendParts(r, "percent"), { kind: "range", low: "2.5", high: "37", units: "%" });
  assert.deepEqual(legendParts({ min: -40, max: 50, kind: "fixed" }, "degree_Celsius"), { kind: "range", low: "-40", high: "50", units: "°C" });
  // unit "1" is dimensionless: no stray "1" after the high value
  assert.deepEqual(legendParts({ min: 0.2, max: 0.9, kind: "sample", status: "ok" }, "1"), { kind: "range", low: "0.2", high: "0.9", units: "" });
});

test("close but unequal bounds print differently", () => {
  const p = legendParts({ min: 1.0002, max: 1.0004, kind: "sample", status: "ok" }, "1");
  assert.equal(p.kind, "range");
  assert.notEqual(p.low, p.high);
  assert.equal(p.low, "1.0002");
  assert.equal(p.high, "1.0004");
  const q = legendParts({ min: 101325, max: 101330, kind: "sample", status: "ok" }, "Pa");
  assert.notEqual(q.low, q.high);
});

test("no finite values: no numbers, just No data", () => {
  const r = initialRange("kg m-2 s-1", Float32Array.from([NaN, NaN]));
  assert.deepEqual(legendParts(r, "kg m-2 s-1"), { kind: "none" });
});

test("a truly constant sample shows its one value, not the padded range used to draw it", () => {
  const r = initialRange("kg m-2 s-1", new Float32Array(1000));
  assert.equal(r.status, "flat");
  assert.deepEqual(legendParts(r, "kg m-2 s-1"), { kind: "single", value: "0", units: "kg m⁻² s⁻¹" });
  const k = initialRange("K", new Float32Array(10).fill(273.5));
  assert.deepEqual(legendParts(k, "K"), { kind: "single", value: "273.5", units: "K" });
});

test("sparse values whose 2nd and 98th percentiles coincide are a range, not a constant", () => {
  // 1% of cells have rain: the percentiles are both 0, but the sample is not constant.
  const rain = Float32Array.from({ length: 1000 }, (_, i) => (i % 100 === 0 ? 3 : 0));
  const s = sampleRange(rain);
  assert.equal(s.status, "ok");
  assert.equal(s.min, 0);
  assert.equal(s.max, 3);
  const r = initialRange("kg m-2 s-1", rain);
  assert.equal(r.provisional, undefined, "a varying sample freezes the range");
  assert.deepEqual(legendParts(r, "kg m-2 s-1"), { kind: "range", low: "0", high: "3", units: "kg m⁻² s⁻¹" });
});
