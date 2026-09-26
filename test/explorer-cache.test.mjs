// Offline tests of explorer/src/lib/cache.js: failed reads must not be cached, so Retry
// recovers (the coordinate, grid and zarr-metadata caches in source.js and store.js).
import assert from "node:assert/strict";
import test from "node:test";
import { cachedPromise } from "../explorer/src/lib/cache.js";

test("a rejected promise is evicted, so the next call retries and then stays cached", async () => {
  const map = new Map();
  let calls = 0;
  const make = async () => {
    calls++;
    if (calls === 1) throw new Error("latitude chunk: Failed to fetch");
    return { values: [90, 89.75] };
  };
  await assert.rejects(cachedPromise(map, "/latitude", make), /Failed to fetch/);
  assert.equal(map.has("/latitude"), false, "failure evicted");
  const ok = await cachedPromise(map, "/latitude", make);
  assert.deepEqual(ok, { values: [90, 89.75] });
  assert.equal(await cachedPromise(map, "/latitude", make), ok);
  assert.equal(calls, 2, "the success is reused");
});

test("concurrent callers share one attempt, and a late failure doesn't evict a newer entry", async () => {
  const map = new Map();
  let reject;
  const first = cachedPromise(map, "k", () => new Promise((_, r) => (reject = r)));
  assert.equal(cachedPromise(map, "k", () => assert.fail("must share")), first);
  const newer = Promise.resolve("new");
  map.set("k", newer); // e.g. a reload replaced it
  reject(new Error("old"));
  await assert.rejects(first, /old/);
  assert.equal(map.get("k"), newer);
});
