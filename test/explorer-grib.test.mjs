// Offline tests of the explorer's GRIB2 support (explorer/src/grib/): the "gribberish" zarr
// codec against expected values from gribberish's Python codec, the retrying fetch client,
// and the whole-grid tile facade. Fixtures and expectations: test/fixtures/grib/make_fixtures.py.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GribberishCodec, drsTemplate, initGrib, registerGribberish } from "../explorer/src/grib/codec.js";
import { retryingFetchClient } from "../explorer/src/grib/retry-fetch.js";
import { createTileFacade, isWholeGridChunked } from "../explorer/src/grib/tile-facade.js";

const grib = new URL("../explorer/src/grib/", import.meta.url);
const fixtures = new URL("fixtures/grib/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", fixtures), "utf8")).fixtures;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

await initGrib(readFileSync(new URL("gribwasm_bg.wasm", grib)));

test("built decoder matches SHA256SUMS", () => {
  const sums = readFileSync(new URL("SHA256SUMS", grib), "utf8").trim().split("\n");
  assert.equal(sums.length, 2);
  for (const line of sums) {
    const [sum, name] = line.split(/\s+/);
    assert.equal(sha256(readFileSync(new URL(name, grib))), sum, name);
  }
});

for (const [name, fx] of Object.entries(expected)) {
  test(`${name}: DRS 5.${fx.drs}${fx.bitmap ? " + bitmap" : ""} decodes like the Python codec`, async () => {
    const bytes = new Uint8Array(readFileSync(new URL(name, fixtures)));
    assert.equal(sha256(bytes), fx.fileSha256, "fixture file changed; regenerate expected.json");
    assert.equal(drsTemplate(bytes), fx.drs);
    for (const c of fx.cases) {
      const label = JSON.stringify(c.config);
      const chunk = await GribberishCodec.fromConfig({ var: "fixture", ...c.config }, { dataType: "float64", shape: fx.shape }).decode(bytes);
      assert.ok(chunk.data instanceof Float64Array);
      assert.deepEqual(chunk.shape, fx.shape);
      assert.deepEqual(chunk.stride, [fx.shape[1], 1]);
      // Bit-exact: the hash covers every value, including NaN positions.
      assert.equal(sha256(new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)), c.sha256, label);
      assert.equal(chunk.data.filter(Number.isNaN).length, c.nanCount, label);
      for (const s of c.samples) {
        const v = chunk.data[s.row * fx.shape[1] + s.col];
        if (s.value === null) assert.ok(Number.isNaN(v), `${label} [${s.row},${s.col}] should be NaN`);
        else assert.equal(v, s.value, `${label} [${s.row},${s.col}]`);
      }
    }
  });
}

test("float32 arrays get Float32Array chunks", async () => {
  const bytes = new Uint8Array(readFileSync(new URL("complex-spatial.grib2", fixtures)));
  const cfg = { adjust_longitude_range: true, north_up: true };
  const f64 = await GribberishCodec.fromConfig(cfg, { dataType: "float64", shape: [46, 90] }).decode(bytes);
  const f32 = await GribberishCodec.fromConfig(cfg, { dataType: "float32", shape: [46, 90] }).decode(bytes);
  assert.ok(f32.data instanceof Float32Array);
  assert.deepEqual(f32.data, Float32Array.from(f64.data));
});

test("chunk shape with leading singleton dims (e.g. [1, 1, lat, lon, 1])", async () => {
  const bytes = new Uint8Array(readFileSync(new URL("simple.grib2", fixtures)));
  const chunk = await GribberishCodec.fromConfig({}, { dataType: "float64", shape: [1, 1, 46, 90, 1] }).decode(bytes);
  assert.deepEqual(chunk.shape, [1, 1, 46, 90, 1]);
  assert.deepEqual(chunk.stride, [4140, 4140, 90, 1, 1]);
});

test("codec rejects a mismatched chunk shape, other dtypes, coordinate mode and encoding", async () => {
  const bytes = new Uint8Array(readFileSync(new URL("simple.grib2", fixtures)));
  await assert.rejects(
    GribberishCodec.fromConfig({}, { dataType: "float64", shape: [45, 90] }).decode(bytes),
    /message has 4140 points, chunk shape \[45,90\] needs 4050/,
  );
  assert.throws(() => GribberishCodec.fromConfig({}, { dataType: "int16", shape: [46, 90] }), /unsupported data type int16/);
  assert.throws(() => GribberishCodec.fromConfig({ var: "latitude" }, { dataType: "float64", shape: [46, 90] }), /not supported/);
  assert.throws(() => GribberishCodec.fromConfig({}, { dataType: "float64", shape: [46, 90] }).encode(), /read-only/);
  await assert.rejects(GribberishCodec.fromConfig({}, { dataType: "float64", shape: [1] }).decode(new Uint8Array(16)), /GRIB/);
});

test("registerGribberish adds a lazy factory to a zarrita-style registry", async () => {
  const registry = new Map();
  registerGribberish(registry);
  assert.equal(await registry.get("gribberish")(), GribberishCodec);
});

// --- retryingFetchClient ---

const noSleep = async () => {};
const response = (status) => new Response(status === 206 ? "ok" : null, { status });

test("retries 503 and network errors, then returns the success", async () => {
  const replies = [response(503), new TypeError("Failed to fetch"), response(206)];
  const seen = [];
  const retries = [];
  const client = retryingFetchClient({
    sleep: noSleep,
    onRetry: (info) => retries.push([info.attempt, info.reason]),
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers.Range]);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const r = await client.fetch("https://x/f.grib2", { headers: { Range: "bytes=0-9" } });
  assert.equal(r.status, 206);
  assert.deepEqual(client.stats, { attempts: 3, retries: 2 });
  assert.deepEqual(seen, Array(3).fill(["https://x/f.grib2", "bytes=0-9"]), "same URL and Range every time");
  assert.deepEqual(retries, [[1, "HTTP 503"], [2, "Failed to fetch"]]);
});

test("does not retry 4xx other than 429", async () => {
  let calls = 0;
  const client = retryingFetchClient({ sleep: noSleep, fetchImpl: async () => (calls++, response(404)) });
  assert.equal((await client.fetch("u")).status, 404);
  assert.equal(calls, 1);
});

test("gives up after maxAttempts: last response, or the last error", async () => {
  let calls = 0;
  const reasons = [];
  const c1 = retryingFetchClient({ maxAttempts: 3, sleep: noSleep, fetchImpl: async () => (calls++, response(429)), onRetry: (i) => reasons.push(i.reason) });
  assert.equal((await c1.fetch("u")).status, 429);
  assert.equal(calls, 3);
  assert.deepEqual(reasons, ["HTTP 429", "HTTP 429"]);
  const c2 = retryingFetchClient({ maxAttempts: 2, sleep: noSleep, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(c2.fetch("u"), /Failed to fetch/);
  assert.equal(c2.stats.attempts, 2);
});

test("an aborted request is not retried", async () => {
  const ac = new AbortController();
  let calls = 0;
  const client = retryingFetchClient({
    sleep: noSleep,
    fetchImpl: async () => {
      calls++;
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(client.fetch("u", { signal: ac.signal }), /aborted/);
  assert.equal(calls, 1);
});

test("backoff doubles with jitter", async () => {
  const waits = [];
  const replies = [response(503), response(503), response(503), response(206)];
  const client = retryingFetchClient({ baseMs: 100, sleep: async (ms) => waits.push(ms), fetchImpl: async () => replies.shift() });
  await client.fetch("u");
  assert.equal(waits.length, 3);
  waits.forEach((ms, i) => assert.ok(ms >= 50 * 2 ** i && ms <= 150 * 2 ** i, `wait ${i} = ${ms}`));
});

// --- tile facade ---

/** A fake whole-grid array (init, lead, y, x) whose cell value encodes its coordinates. */
function fakeArray({ shape = [2, 3, 10, 12], failOnce = null } = {}) {
  const [, , H, W] = shape;
  const reads = [];
  let failed = false;
  const array = { shape, chunks: [1, 1, H, W], dimensionNames: ["init_time", "lead_time", "latitude", "longitude"], attrs: { a: 1 }, dtype: "float64" };
  const get = async (arr, sel) => {
    assert.equal(arr, array, "facade must read the real array");
    assert.deepEqual(sel.slice(2), [null, null]);
    reads.push(sel.slice(0, 2).join(","));
    if (failOnce && sel.slice(0, 2).join(",") === failOnce && !failed) {
      failed = true;
      throw new Error("upstream 503");
    }
    await new Promise((r) => setImmediate(r));
    const [i, l] = sel;
    const data = new Float64Array(H * W).map((_, k) => i * 1e6 + l * 1e4 + Math.floor(k / W) * 100 + (k % W));
    return { data, shape: [H, W] };
  };
  return { array, get, reads };
}
const slice = (start, stop) => ({ start, stop, step: null });

test("isWholeGridChunked", () => {
  assert.equal(isWholeGridChunked({ shape: [5, 209, 721, 1440], chunks: [1, 1, 721, 1440] }), true);
  assert.equal(isWholeGridChunked({ shape: [5, 209, 721, 1440], chunks: [1, 105, 121, 121] }), false);
  assert.equal(isWholeGridChunked({ shape: [3, 721, 1440, 14], chunks: [1, 721, 1440, 1] }), false, "trailing extra dim");
});

test("facade view keeps shape and names but advertises tile-sized spatial chunks", () => {
  const { array, get } = fakeArray();
  const f = createTileFacade({ array, get, tileSize: 4 });
  assert.deepEqual(f.view, { shape: [2, 3, 10, 12], chunks: [1, 1, 4, 4], dimensionNames: array.dimensionNames, attrs: { a: 1 }, dtype: "float64" });
  assert.deepEqual(createTileFacade({ array, get, tileSize: 121 }).view.chunks, [1, 1, 10, 12], "never larger than the grid");
  assert.throws(() => createTileFacade({ array: { shape: [4, 4], chunks: [2, 4] }, get }), /whole-grid chunks/);
});

test("tiles are windows of one decoded grid, read once and shared", async () => {
  const { array, get, reads } = fakeArray();
  const f = createTileFacade({ array, get, tileSize: 4 });
  // Every tile of lead 2 at init 1, as ZarrLayer would request them (edge tiles clipped).
  const tiles = [];
  for (let r = 0; r < 10; r += 4) for (let c = 0; c < 12; c += 4) tiles.push([r, c]);
  const out = await Promise.all(tiles.map(([r, c]) => f.get(f.view, [1, slice(2, 3), slice(r, Math.min(r + 4, 10)), slice(c, c + 4)])));
  assert.deepEqual(reads, ["1,2"], "one real read for all tiles");
  const bottomRight = out.at(-1);
  assert.deepEqual(bottomRight.shape, [1, 2, 4]);
  assert.deepEqual(bottomRight.stride, [8, 4, 1]);
  assert.deepEqual(Array.from(bottomRight.data), [10808, 10809, 10810, 10811, 10908, 10909, 10910, 10911].map((v) => v + 1e6 + 1e4));
  assert.ok(bottomRight.data instanceof Float64Array);
  assert.equal(f.stats.reads, 1);
  assert.equal(f.stats.hits, tiles.length - 1);
});

test("multi-step windows stack steps in C order; scalars drop their dim", async () => {
  const { array, get, reads } = fakeArray();
  const f = createTileFacade({ array, get, tileSize: 4 });
  const t = await f.get(f.view, [0, slice(0, 3), slice(0, 1), slice(5, 7)]);
  assert.deepEqual(t.shape, [3, 1, 2]);
  assert.deepEqual(Array.from(t.data), [5, 6, 10005, 10006, 20005, 20006]);
  assert.deepEqual(reads.sort(), ["0,0", "0,1", "0,2"]);
  const scalar = await f.get(f.view, [1, 0, slice(0, 1), slice(0, 1)]);
  assert.deepEqual(scalar.shape, [1, 1]);
  assert.deepEqual(Array.from(scalar.data), [1e6]);
});

test("cache is bounded (LRU) and clear() empties it", async () => {
  const { array, get, reads } = fakeArray();
  const f = createTileFacade({ array, get, tileSize: 4, cacheSize: 2 });
  const tile = (l) => f.get(f.view, [0, slice(l, l + 1), slice(0, 4), slice(0, 4)]);
  await tile(0);
  await tile(1);
  await tile(0); // hit, now most recent
  await tile(2); // evicts lead 1
  await tile(0); // still cached
  await tile(1); // re-read
  assert.deepEqual(reads, ["0,0", "0,1", "0,2", "0,1"]);
  f.clear();
  await tile(0);
  assert.equal(reads.at(-1), "0,0");
});

test("reads in flight are bounded by maxConcurrent", async () => {
  const { array } = fakeArray({ shape: [1, 12, 4, 4] });
  let active = 0, peak = 0;
  const get = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return { data: new Float64Array(16), shape: [4, 4] };
  };
  const f = createTileFacade({ array, get, tileSize: 2, maxConcurrent: 3, cacheSize: 12 });
  await f.get(f.view, [0, slice(0, 12), slice(0, 2), slice(0, 2)]);
  assert.equal(peak, 3);
});

test("a failed read is not cached; an aborted tile doesn't cancel the shared read", async () => {
  const { array, get, reads } = fakeArray({ failOnce: "0,0" });
  const f = createTileFacade({ array, get, tileSize: 4 });
  const sel = [0, slice(0, 1), slice(0, 4), slice(0, 4)];
  await assert.rejects(f.get(f.view, sel), /upstream 503/);
  const ac = new AbortController();
  const aborted = f.get(f.view, sel, { signal: ac.signal });
  const other = f.get(f.view, [0, slice(0, 1), slice(4, 8), slice(0, 4)]);
  ac.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  assert.equal((await other).data[0], 400);
  assert.deepEqual(reads, ["0,0", "0,0"], "retried once after the failure, then shared");
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(f.get(f.view, sel, { signal: pre.signal }), { name: "AbortError" });
});

test("a trailing level dim (…, lat, lon, pressure_level) is moved before the grid in the view", async () => {
  // (init, lead, lat, lon, level) with chunk (1, 1, 6, 8, 1), like AIFS pressure_level/*.
  const array = { shape: [2, 3, 6, 8, 4], chunks: [1, 1, 6, 8, 1], dimensionNames: ["init_time", "lead_time", "latitude", "longitude", "pressure_level"], attrs: {}, dtype: "float64" };
  const reads = [];
  const get = async (arr, sel) => {
    assert.equal(arr, array);
    assert.equal(sel[2], null);
    assert.equal(sel[3], null);
    reads.push([sel[0], sel[1], sel[4]].join(","));
    const [i, l, , , p] = sel;
    return { data: new Float64Array(48).map((_, k) => i * 1e6 + l * 1e4 + p * 1e3 + Math.floor(k / 8) * 10 + (k % 8)), shape: [6, 8] };
  };
  assert.equal(isWholeGridChunked(array), false, "not with the default (last two) spatial dims");
  assert.equal(isWholeGridChunked(array, [2, 3]), true);
  const f = createTileFacade({ array, get, spatial: [2, 3], tileSize: 4 });
  assert.deepEqual(f.view.dimensionNames, ["init_time", "lead_time", "pressure_level", "latitude", "longitude"]);
  assert.deepEqual(f.view.shape, [2, 3, 4, 6, 8]);
  assert.deepEqual(f.view.chunks, [1, 1, 1, 4, 4]);
  // View order: init 1, lead slice 2..3, level 3, rows 4..6, cols 4..8.
  const t = await f.get(f.view, [1, slice(2, 3), 3, slice(4, 6), slice(4, 8)]);
  assert.deepEqual(t.shape, [1, 2, 4]);
  assert.deepEqual(Array.from(t.data), [44, 45, 46, 47, 54, 55, 56, 57].map((v) => v + 1e6 + 2e4 + 3e3));
  assert.deepEqual(reads, ["1,2,3"]);
  assert.throws(() => createTileFacade({ array, get }), /whole-grid chunks/);
});

test("cache keys carry the snapshot, the variable path and every non-spatial index", async () => {
  // (init, member, lead, lat, lon, level): four non-spatial dims, level after the grid.
  const array = { shape: [2, 3, 4, 6, 8, 5], chunks: [1, 1, 1, 6, 8, 1], dimensionNames: ["init_time", "ensemble_member", "lead_time", "latitude", "longitude", "pressure_level"], attrs: {}, dtype: "float64" };
  const get = async () => ({ data: new Float64Array(48), shape: [6, 8] });
  const f = createTileFacade({ array, get, spatial: [3, 4], tileSize: 4, keyPrefix: "SNAP1|/pressure_level/temperature" });
  await f.get(f.view, [1, 2, slice(3, 4), 4, slice(0, 4), slice(0, 4)]);
  await f.get(f.view, [1, 0, slice(3, 4), 4, slice(0, 4), slice(0, 4)]); // other member
  await f.get(f.view, [1, 2, slice(3, 4), 1, slice(0, 4), slice(0, 4)]); // other level
  assert.deepEqual(f.keys(), ["SNAP1|/pressure_level/temperature|1,2,3,4", "SNAP1|/pressure_level/temperature|1,0,3,4", "SNAP1|/pressure_level/temperature|1,2,3,1"]);
  assert.equal(f.stats.reads, 3);
});

test("aborting one tile never cancels the read other tiles share", async () => {
  const { array } = fakeArray();
  let release;
  const signals = [];
  const get = async (arr, sel, opts) => {
    signals.push(opts?.signal ?? null);
    await new Promise((r) => (release = r));
    return { data: new Float64Array(120).map((_, k) => k), shape: [10, 12] };
  };
  const f = createTileFacade({ array, get, tileSize: 4 });
  const ac = new AbortController();
  const a = f.get(f.view, [0, slice(0, 1), slice(0, 4), slice(0, 4)], { signal: ac.signal });
  const b = f.get(f.view, [0, slice(0, 1), slice(4, 8), slice(0, 4)], { signal: new AbortController().signal });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  release();
  await assert.rejects(a, { name: "AbortError" });
  assert.equal((await b).data[0], 48);
  assert.deepEqual(signals, [null], "one shared read, started without any tile's signal");
});
