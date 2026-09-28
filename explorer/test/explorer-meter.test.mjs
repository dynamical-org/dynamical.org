import assert from "node:assert/strict";
import { test } from "node:test";

import { retryingFetchClient } from "../src/grib/retry-fetch.js";
import { formatMB, meteredFetch } from "../src/lib/meter.js";

const body = (n) => new Uint8Array(n).fill(7);

test("a metered fetch counts each body's bytes as it is read, and keeps status and headers", async () => {
  let total = 0;
  const f = meteredFetch(async () => new Response(body(1500), { status: 206, headers: { "content-range": "bytes 0-1499/9000" } }), (n) => (total += n));
  const r = await f("https://example.com/x");
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 0-1499/9000");
  assert.equal(total, 0, "nothing is counted before the body is read");
  assert.equal((await r.arrayBuffer()).byteLength, 1500);
  assert.equal(total, 1500);
});

test("a body with none (HEAD, 204) passes through uncounted", async () => {
  let total = 0;
  const f = meteredFetch(async () => new Response(null, { status: 204 }), (n) => (total += n));
  assert.equal((await f("x")).status, 204);
  assert.equal(total, 0);
});

test("an aborted read stops the count and rejects like fetch", async () => {
  let total = 0;
  const ac = new AbortController();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(body(100));
      ac.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  });
  const f = meteredFetch(async () => new Response(stream), (n) => (total += n));
  const r = await f("x", { signal: ac.signal });
  const reading = r.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 5));
  ac.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(total, 100, "the bytes that arrived before the abort count");
});

test("through the retrying virtual client, a retried read counts again", async () => {
  let total = 0;
  let calls = 0;
  const upstream = async () => (++calls === 1 ? new Response(body(40), { status: 503 }) : new Response(body(1000), { status: 206 }));
  const client = retryingFetchClient({ fetchImpl: meteredFetch(upstream, (n) => (total += n)), sleep: async () => {} });
  const r = await client.fetch("https://noaa-gfs-bdp-pds.s3.amazonaws.com/x", {});
  await r.arrayBuffer();
  assert.equal(calls, 2);
  // The 503's body is cancelled unread, so only what was read counts.
  assert.ok(total >= 1000 && total <= 1040, `counted ${total}`);
});

test("totals read as decimal megabytes", () => {
  assert.equal(formatMB(0), "0.00 MB");
  assert.equal(formatMB(31_000), "0.03 MB");
  assert.equal(formatMB(12_400_000), "12.4 MB");
});
