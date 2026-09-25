// Offline tests of the explorer's dims, block math, time labels, colour range
// and shard-index probe (explorer/src/lib/{dims,time,colour}.js).
import assert from "node:assert/strict";
import test from "node:test";
import { isCelsius, missingSentinels, sampleRange, toFloat32 } from "../explorer/src/lib/colour.js";
import {
  absolutePath,
  blockRange,
  classifyDims,
  decodeIndexEntry,
  dimLabel,
  locateInner,
  probeCandidates,
  probeLatest,
  shardLayout,
  stepWithData,
} from "../explorer/src/lib/dims.js";
import { decodeCf, formatLead, formatUtc, parseCfUnits } from "../explorer/src/lib/time.js";

test("classifies forecast, ensemble, level and analysis dims", () => {
  assert.deepEqual(classifyDims(["init_time", "lead_time", "latitude", "longitude"]), {
    init: "init_time",
    step: "lead_time",
    stepKind: "lead",
    member: null,
    extras: [],
    spatial: ["latitude", "longitude"],
  });
  const ens = classifyDims(["init_time", "lead_time", "ensemble_member", "pressure_level", "latitude", "longitude"]);
  assert.equal(ens.member, "ensemble_member");
  assert.deepEqual(ens.extras, ["pressure_level"]);
  const ana = classifyDims(["time", "y", "x"]);
  assert.deepEqual([ana.init, ana.step, ana.stepKind, ana.extras], [null, "time", "time", []]);
  assert.deepEqual(classifyDims(["latitude", "longitude"]).step, null);
  assert.throws(() => classifyDims(["time", "station"]), /No \(latitude, longitude\) or \(y, x\)/);
  assert.throws(() => classifyDims(["latitude", "longitude", "time"]), /last two dimensions/);
});

test("pinned and selected dims are labelled with their coordinate value", () => {
  assert.equal(dimLabel("ensemble_member", 0, "1"), "member 0");
  assert.equal(dimLabel("pressure_level", 500, "hPa"), "500 hPa");
  assert.equal(dimLabel("model_level", 3, "1"), "3");
});

test("block math: window bounded by the texture limit and the inner chunk", () => {
  // GFS: 105-lead chunks, window 128 → the block is the chunk.
  assert.deepEqual(blockRange(0, 105, 128, 209), { start: 0, stop: 105 });
  assert.deepEqual(blockRange(104, 105, 128, 209), { start: 0, stop: 105 });
  assert.deepEqual(blockRange(105, 105, 128, 209), { start: 105, stop: 209 });
  // Analysis: 1440-step chunks, window 128 → sub-blocks that never cross a chunk.
  assert.deepEqual(blockRange(0, 1440, 128, 47367), { start: 0, stop: 128 });
  assert.deepEqual(blockRange(1439, 1440, 128, 47367), { start: 1408, stop: 1440 });
  assert.deepEqual(blockRange(1440, 1440, 128, 47367), { start: 1440, stop: 1568 });
  assert.deepEqual(blockRange(47366, 1440, 128, 47367), { start: 47360, stop: 47367 });
  // Virtual stores: one step per chunk.
  assert.deepEqual(blockRange(7, 1, 128, 209), { start: 7, stop: 8 });
  // Fixture: 300 steps in one chunk with a window of 128.
  assert.deepEqual(blockRange(299, 300, 128, 300), { start: 256, stop: 300 });
});

test("the opening step is the first (lead) or last (time) step with data", () => {
  // 3 steps of 2 cells: step 0 all NaN (a 24 h mean at +0 h), step 2 all NaN (not yet written).
  const block = Float32Array.from([NaN, NaN, 1, NaN, NaN, NaN]);
  assert.equal(stepWithData(block, 3, "first"), 1);
  assert.equal(stepWithData(block, 3, "last"), 1);
  assert.equal(stepWithData(Float32Array.from([1, 2, 3]), 3, "last"), 2);
  assert.equal(stepWithData(new Float32Array(4).fill(NaN), 2, "first"), -1);
});

test("probe candidates walk back one inner chunk at a time", () => {
  assert.deepEqual(probeCandidates(7895, 1), [7894, 7893, 7892, 7891]);
  assert.deepEqual(probeCandidates(47367, 1440), [47366, 46079, 44639, 43199]);
  assert.deepEqual(probeCandidates(2, 1, 4), [1, 0]);
});

test("CF time units decode to UTC; labels are UTC", () => {
  assert.deepEqual(parseCfUnits("seconds since 1970-01-01"), { unitMs: 1000, epochMs: 0 });
  assert.deepEqual(parseCfUnits("hours since 2000-01-01 00:00:00"), { unitMs: 3_600_000, epochMs: Date.UTC(2000, 0, 1) });
  assert.deepEqual(parseCfUnits("seconds"), { unitMs: 1000, epochMs: null });
  assert.throws(() => parseCfUnits("fortnights"), /Unsupported CF time units/);
  const [init] = decodeCf([1790337600n], "seconds since 1970-01-01");
  assert.equal(formatUtc(init), "2026-09-25 12:00 UTC");
  const [lead] = decodeCf([172800], "seconds");
  assert.equal(formatLead(lead), "+48 h");
  assert.equal(formatLead(5400_000), "+1.5 h");
  assert.equal(formatUtc(init + lead), "2026-09-27 12:00 UTC");
});

test("values of any numeric dtype become Float32 with missing sentinels as NaN", () => {
  const out = toFloat32(Int16Array.from([-1, 0, 50, 100]), { missing: [-1] });
  assert.ok(out instanceof Float32Array);
  assert.ok(Number.isNaN(out[0]));
  assert.deepEqual(Array.from(out.slice(1)), [0, 50, 100]);
  assert.deepEqual(Array.from(toFloat32(Float64Array.from([1.5, 2]))), [1.5, 2]);
  assert.deepEqual(Array.from(toFloat32(BigInt64Array.from([3n]), { scale: 0.5, offset: 1 })), [2.5]);
  const f32 = Float32Array.from([1, 2]);
  assert.equal(toFloat32(f32), f32, "plain float32 is not copied");
  assert.deepEqual(missingSentinels({}, -1), [-1]);
  assert.deepEqual(missingSentinels({}, "NaN"), []);
  assert.deepEqual(missingSentinels({ _FillValue: "AAAAAAAA+H8=" }, 0), [], "base64 NaN _FillValue overrides zarr fill 0");
  assert.deepEqual(missingSentinels({ missing_value: 9999 }, NaN), [9999]);
});

test("colour range: Celsius detection, percentiles, flat and empty samples", () => {
  assert.ok(isCelsius("degree_Celsius") && isCelsius("°C") && isCelsius("degC"));
  assert.ok(!isCelsius("K") && !isCelsius("degree") && !isCelsius("percent"));
  const ramp = Float32Array.from({ length: 1001 }, (_, i) => i / 10);
  const r = sampleRange(ramp);
  assert.equal(r.status, "ok");
  assert.ok(Math.abs(r.min - 2) < 0.11 && Math.abs(r.max - 98) < 0.11);
  assert.deepEqual(sampleRange(new Float32Array(50)), { min: 0, max: 1, status: "flat", samples: 50 });
  assert.equal(sampleRange(Float32Array.from([NaN, NaN])).status, "empty");
  const big = new Float32Array(1_000_000).map((_, i) => i);
  assert.ok(sampleRange(big).samples <= 100_000);
});

/** A 4-D array with shard (1,6,8,8) and inner (1,3,4,4): 8 inner chunks per shard. */
const META = {
  shape: [4, 6, 16, 16],
  dimension_names: ["init_time", "lead_time", "latitude", "longitude"],
  chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 6, 8, 8] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  codecs: [
    {
      name: "sharding_indexed",
      configuration: {
        chunk_shape: [1, 3, 4, 4],
        codecs: [{ name: "bytes", configuration: { endian: "little" } }, { name: "blosc" }],
        index_codecs: [{ name: "bytes", configuration: { endian: "little" } }, { name: "crc32c" }],
        index_location: "end",
      },
    },
  ],
};

/** Shard index bytes with the given entries present (others empty), plus a crc32c. */
function indexBytes(present) {
  const buf = new Uint8Array(8 * 16 + 4);
  const dv = new DataView(buf.buffer);
  for (let e = 0; e < 8; e++) {
    const hit = present.includes(e);
    dv.setBigUint64(e * 16, hit ? BigInt(e * 1000) : 0xffffffffffffffffn, true);
    dv.setBigUint64(e * 16 + 8, hit ? 1234n : 0xffffffffffffffffn, true);
  }
  return buf;
}

test("shard layout is validated against the codec metadata", () => {
  const l = shardLayout(META);
  assert.deepEqual([l.nInner, l.indexBytes, l.location], [8, 132, "end"]);
  assert.equal(shardLayout({ ...META, codecs: [{ name: "bytes" }, { name: "zstd" }] }), null, "unsharded");
  const bad = structuredClone(META);
  bad.codecs[0].configuration.index_codecs = [{ name: "bytes", configuration: { endian: "big" } }];
  assert.throws(() => shardLayout(bad), /unsupported shard index codecs/);
  const v2 = { ...META, chunk_key_encoding: { name: "v2" } };
  assert.throws(() => shardLayout(v2), /chunk key encoding "v2"/);
});

test("inner-chunk location and index-entry decode", () => {
  const l = shardLayout(META);
  // Cell (row 12, col 5) at init 3, lead 4 → shard (3,0,1,0), inner (0,1,1,1) → entry 7.
  assert.deepEqual(locateInner("/t2m", [3, 4, 12, 5], l), { key: "/t2m/c/3/0/1/0", entry: 7 });
  // Keys are absolute however the path arrives (icechunk-js misses bare keys).
  assert.equal(locateInner("t2m", [3, 4, 12, 5], l).key, "/t2m/c/3/0/1/0");
  assert.equal(locateInner("pressure_level/temperature", [0, 0, 0, 0], l).key, "/pressure_level/temperature/c/0/0/0/0");
  assert.equal(absolutePath("//a/b/"), "/a/b");
  const bytes = indexBytes([7]);
  assert.deepEqual(decodeIndexEntry(bytes, 7, l), { present: true, offset: 7000, nbytes: 1234 });
  assert.deepEqual(decodeIndexEntry(bytes, 0, l), { present: false, offset: null, nbytes: null });
  assert.throws(() => decodeIndexEntry(bytes.slice(0, 100), 0, l), /index is 100 B, expected 132 B/);
});

test("probe picks the newest init whose centre chunk is written, reading only indexes", async () => {
  const calls = [];
  // Centre cell (8, 8) → shard (i,0,1,1), inner (0,0,0,0) → entry 0 at lead block 0.
  const shards = { "/t2m/c/3/0/1/1": indexBytes([]), "/t2m/c/2/0/1/1": indexBytes([0]) };
  const getRange = async (key, range) => {
    calls.push([key, range]);
    return shards[key];
  };
  const r = await probeLatest({
    getRange,
    path: "/t2m",
    meta: META,
    dimNames: META.dimension_names,
    probeDim: "init_time",
    at: { latitude: 8, longitude: 8, lead_time: 0 },
  });
  assert.equal(r.index, 2);
  assert.equal(r.probed, true);
  assert.deepEqual(calls, [
    ["/t2m/c/3/0/1/1", { suffixLength: 132 }],
    ["/t2m/c/2/0/1/1", { suffixLength: 132 }],
  ]);
  const none = await probeLatest({ getRange: async () => undefined, path: "/t2m", meta: META, dimNames: META.dimension_names, probeDim: "init_time", at: {} });
  assert.equal(none.index, null);
  assert.equal(none.log.length, 4);
});
