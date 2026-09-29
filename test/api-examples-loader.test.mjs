import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The /api/ loader against a stand-in API on localhost: which failures it retries,
// what it says about each, and that a build never renders a cached response over a
// request the API now refuses. Each run is its own process, because eleventy-fetch
// memoizes responses in memory and keeps its cache in the working directory.

const LOADER = fileURLToPath(new URL("../_data/apiExamples.js", import.meta.url));
const OK = { results: [{ forecasts: [{ links: { canonical: "/v1/data/x/SNAP/points/1,2" } }] }] };

/** A stand-in API whose answer to each request is `api.respond(key, hits)`. */
async function startApi(respond) {
  const api = { respond, seen: [] };
  api.server = createServer((request, response) => {
    const key = `${request.method} ${request.url}`;
    api.seen.push(key);
    const hits = api.seen.filter((k) => k === key).length;
    const [status, body, type = "application/json"] = api.respond(key, hits);
    response.writeHead(status, { "content-type": type });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  api.base = `http://127.0.0.1:${api.server.address().port}`;
  return api;
}

/** Runs the loader once in `cwd`, returning its result and the requests it made. */
async function runLoader(api, { env = {}, cwd }) {
  const before = api.seen.length;
  const script =
    `require(${JSON.stringify(LOADER)})().then(` +
    `(d) => console.log(JSON.stringify({ ok: true, forecast: d.forecast.response })), ` +
    `(e) => console.log(JSON.stringify({ ok: false, message: e.message })))`;
  const stdout = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      ["-e", script],
      { cwd, env: { PATH: process.env.PATH, DATA_API_BASE: api.base, ...env } },
      (error, out) => (error ? reject(error) : resolve(out))
    )
  );
  return { ...JSON.parse(stdout), seen: api.seen.slice(before) };
}

/** One loader run against a fresh API and an empty cache. */
async function load(respond, env = {}) {
  const api = await startApi(respond);
  const cwd = mkdtempSync(join(tmpdir(), "api-examples-"));
  try {
    return await runLoader(api, { env, cwd });
  } finally {
    api.server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

const everything = () => [200, OK];

test("a refused request fails at once, with the API's reason", async () => {
  const run = await load((key) =>
    key === "GET /v1/data-products"
      ? [422, { detail: [{ loc: ["query", "x"], msg: "Extra inputs are not permitted" }] }]
      : [200, OK]
  );

  assert.equal(run.ok, false);
  assert.match(run.message, /^\[apiExamples\] products: GET \/v1\/data-products against http/);
  assert.match(run.message, /HTTP 422: \[\{"loc":\["query","x"\],"msg":"Extra inputs/);
  assert.match(run.message, /refused a request \/api\/ documents/);
  assert.equal(run.seen.filter((k) => k === "GET /v1/data-products").length, 1);
});

test("a failing API is retried once, and said to be failing", async () => {
  const recovered = await load((key, hits) =>
    key === "GET /v1/data-products" && hits === 1 ? [524, "", "text/html"] : [200, OK]
  );
  assert.equal(recovered.ok, true);

  const down = await load(() => [524, "<html>A timeout occurred</html>", "text/html"]);
  assert.equal(down.ok, false);
  assert.match(down.message, /HTTP 524: <html>A timeout occurred<\/html>/);
  assert.match(down.message, /failed rather than refusing the request, so this is not drift/);
  assert.equal(down.seen.length, 2);
});

test("the canonical follow-up reports its own request", async () => {
  const run = await load((key) => (key.startsWith("GET /v1/data/") ? [404, {}] : [200, OK]));

  assert.equal(run.ok, false);
  assert.match(run.message, /^\[apiExamples\] canonical: GET \/v1\/data\/x\/SNAP\/points\/1,2 /);
  // The quickstart's response is reused rather than asked for again.
  assert.equal(run.seen.filter((k) => k === "POST /v1/forecasts").length, 2); // forecast, ensemble
});

test("a response that is not JSON is not called an outage", async () => {
  const run = await load(() => [200, "<html>maintenance</html>", "text/html"]);

  assert.equal(run.ok, false);
  assert.match(run.message, /cannot show an example it could not fetch/);
  assert.doesNotMatch(run.message, /not drift/);
});

test("a build never renders a cached response over a refusal", async () => {
  // eleventy-fetch falls back to an expired cache entry when a request fails and
  // the duration is positive. Pages keeps .cache between builds, so a build with
  // any cache would deploy last week's response over a request the API refuses.
  const cwd = mkdtempSync(join(tmpdir(), "api-examples-"));
  const api = await startApi(everything);
  const refuse = () => [422, { detail: "unknown field" }];
  try {
    const serving = { ELEVENTY_RUN_MODE: "serve" };
    assert.equal((await runLoader(api, { env: serving, cwd })).ok, true);

    // --serve caches, so a rebuild while editing stays off the API…
    assert.deepEqual((await runLoader(api, { env: serving, cwd })).seen, []);

    // …and its cache, once expired, papers over a refusal. That is the hazard.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    api.respond = refuse;
    const stale = await runLoader(api, {
      env: { ...serving, API_EXAMPLES_CACHE_DURATION: "1s" },
      cwd,
    });
    assert.equal(stale.ok, true, "the cache fallback this test guards against did not occur");

    // A build asks the API every time, so the same refusal fails it.
    const built = await runLoader(api, { env: { ELEVENTY_RUN_MODE: "build" }, cwd });
    assert.equal(built.ok, false);
    assert.match(built.message, /HTTP 422: unknown field/);
  } finally {
    api.server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
