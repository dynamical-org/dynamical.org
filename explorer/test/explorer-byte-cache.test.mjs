import assert from "node:assert/strict";
import test from "node:test";
import { cachingStore } from "../src/lib/byte-cache.js";

// A store that counts reads and returns `size` bytes filled with a per-key byte.
function countingStore(size = 10) {
  const reads = [];
  const bytes = (key) => new Uint8Array(size).fill(key.length);
  return {
    reads,
    get: async (key) => (reads.push(["get", key]), key.includes("missing") ? undefined : bytes(key)),
    getRange: async (key, range) => (reads.push(["getRange", key, range]), bytes(key)),
  };
}

test("a repeated read is served from memory", async () => {
  const inner = countingStore();
  const store = cachingStore(inner, { maxBytes: 100 });
  const a = await store.getRange("/t/c/0/0", { offset: 5, length: 10 });
  const b = await store.getRange("/t/c/0/0", { offset: 5, length: 10 });
  assert.deepEqual(a, b);
  await store.get("/t/c/1/0");
  await store.get("/t/c/1/0");
  assert.equal(inner.reads.length, 2);
});

test("ranges of the same object are separate entries", async () => {
  const inner = countingStore();
  const store = cachingStore(inner, { maxBytes: 100 });
  await store.getRange("/t/c/0", { offset: 0, length: 10 });
  await store.getRange("/t/c/0", { offset: 10, length: 10 });
  await store.getRange("/t/c/0", { suffixLength: 10 });
  await store.get("/t/c/0");
  assert.equal(inner.reads.length, 4);
});

test("the least recently used entries go when the budget is full", async () => {
  const inner = countingStore(10);
  const store = cachingStore(inner, { maxBytes: 25 });
  await store.get("/a");
  await store.get("/b");
  await store.get("/a"); // /a is now the most recent
  await store.get("/c"); // 30 bytes: /b goes
  inner.reads.length = 0;
  await store.get("/a");
  await store.get("/c");
  assert.equal(inner.reads.length, 0);
  await store.get("/b");
  assert.deepEqual(inner.reads, [["get", "/b"]]);
});

test("a missing object or a failed read is not remembered", async () => {
  const inner = countingStore();
  let fail = true;
  const flaky = { ...inner, get: async (key) => (fail ? Promise.reject(new Error("503")) : inner.get(key)) };
  const store = cachingStore(flaky, { maxBytes: 100 });
  await assert.rejects(store.get("/t/c/0"), /503/);
  fail = false;
  assert.ok(await store.get("/t/c/0"));
  assert.equal(await store.get("/missing"), undefined);
  assert.equal(await store.get("/missing"), undefined);
  assert.equal(inner.reads.filter(([, key]) => key === "/missing").length, 2);
});

test("a caller that changes its bytes doesn't change what the next caller gets", async () => {
  const store = cachingStore(countingStore(), { maxBytes: 100 });
  const first = await store.get("/abc");
  first.fill(0);
  assert.deepEqual([...(await store.get("/abc"))], new Array(10).fill(4));
});

test("an object larger than the budget is read but not kept", async () => {
  const inner = countingStore(50);
  const store = cachingStore(inner, { maxBytes: 20 });
  await store.get("/big");
  await store.get("/big");
  assert.equal(inner.reads.length, 2);
});

test("reads of one key that land together are counted once", async () => {
  for (const read of [(s, k) => s.get(k), (s, k) => s.getRange(k, { offset: 0, length: 10 })]) {
    const inner = countingStore(10);
    const store = cachingStore(inner, { maxBytes: 20 });
    await Promise.all([read(store, "/a"), read(store, "/a"), read(store, "/a")]);
    await read(store, "/b");
    inner.reads.length = 0;
    await read(store, "/a");
    await read(store, "/b");
    assert.equal(inner.reads.length, 0, "both still held within the 20-byte budget");
  }
});

test("a hit with an aborted signal rejects as a read would", async () => {
  const store = cachingStore(countingStore(), { maxBytes: 100 });
  await store.get("/a");
  await store.getRange("/a", { offset: 0, length: 10 });
  const signal = AbortSignal.abort();
  await assert.rejects(store.get("/a", { signal }), { name: "AbortError" });
  await assert.rejects(store.getRange("/a", { offset: 0, length: 10 }, { signal }), { name: "AbortError" });
});
