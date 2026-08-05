import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { REQUESTS, curlFor, elide, formatJson, hourFloorIso } = require("../lib/api-examples.js");

const PAGE = readFileSync(new URL("../content/api.njk", import.meta.url), "utf8");
const CATALOG = readFileSync(new URL("../content/catalog.njk", import.meta.url), "utf8");

// /api/ embeds real responses fetched at build time. The build is what proves the
// requests are still valid; these are the instant checks on the shaping around
// them — that nothing is transcribed by hand, and that an elision can never be
// mistaken for the real end of an array.

test("every example the page renders is defined", () => {
  const used = [...PAGE.matchAll(/apiExamples\.(\w+)/g)].map((m) => m[1]);
  const rendered = used.filter((name) => name !== "base");

  assert.ok(rendered.length > 0, "the page renders no examples");
  for (const name of rendered) {
    assert.ok(REQUESTS[name], `the page renders apiExamples.${name}, which is not defined`);
  }
});

test("every defined example is rendered", () => {
  // An orphaned definition is a request issued on every build for nothing.
  for (const name of Object.keys(REQUESTS)) {
    assert.match(PAGE, new RegExp(`apiExamples\\.${name}\\b`), `${name} is fetched but not shown`);
  }
});

test("requests are relative paths, so the base stays configurable", () => {
  for (const [name, definition] of Object.entries(REQUESTS)) {
    const request = definition.build(Date.UTC(2026, 7, 5, 18, 30));
    assert.ok(
      request.path.startsWith("/v1/"),
      `${name} should use a relative /v1 path, got ${request.path}`
    );
  }
});

test("the quickstart request is the minimal one", () => {
  // The first example a reader meets should be the shortest thing that works: no
  // lead-time ceiling, no run selection, one variable.
  const query = REQUESTS.forecast.build(0).body.queries[0];

  assert.deepEqual(Object.keys(query).sort(), ["dataProductId", "location", "variables"]);
  assert.equal(query.variables.length, 1);
});

test("curl renders GET and POST in copy-pasteable form", () => {
  const get = curlFor("https://api.example", { method: "GET", path: "/v1/data-products" });
  assert.equal(get, "curl 'https://api.example/v1/data-products'");

  const post = curlFor("https://api.example", {
    method: "POST",
    path: "/v1/forecasts",
    body: { queries: [] },
  });
  assert.match(post, /^curl -X POST 'https:\/\/api\.example\/v1\/forecasts' \\\n/);
  assert.match(post, /-H 'content-type: application\/json' \\\n/);
  assert.match(post, /-d '\{/);
});

test("long axes are elided with the count and the real last value", () => {
  const payload = { validTimes: ["a", "b", "c", "d", "e"], leadTimeHours: [0, 1] };
  const shown = elide(payload, { arrayLimit: 3 });

  assert.deepEqual(shown.validTimes, ["a", "b", "c", "… 5 values, last e"]);
  // Short axes are left exactly as they came back.
  assert.deepEqual(shown.leadTimeHours, [0, 1]);
});

test("arrays of objects and oversized maps announce what was dropped", () => {
  const payload = {
    runs: [{ n: 1 }, { n: 2 }, { n: 3 }],
    variables: { a: 1, b: 2, c: 3 },
  };
  const shown = elide(payload, { objectArrayLimit: 2, objectLimits: { variables: 1 } });

  assert.deepEqual(shown.runs, [{ n: 1 }, { n: 2 }, "… 3 entries"]);
  assert.deepEqual(shown.variables, { a: 1, "…": "2 more" });
});

test("elision never rewrites a value it keeps", () => {
  // A reader has to be able to trust the numbers, so nothing rounds or reorders.
  const payload = {
    data: { temperature_2m: [22.75, null, 8.678436279296875e-5] },
    point: { selected: { latitude: 41.87500000000261 } },
  };

  assert.deepEqual(elide(payload), payload);
  const printed = formatJson(payload);
  assert.match(printed, /41\.87500000000261/);
  // Printing through JSON.stringify normalizes exponent notation (the API sends
  // 8.678436279296875e-05) but never the magnitude — every digit survives.
  assert.match(printed, /0\.00008678436279296875/);
  assert.equal(JSON.parse(printed).data.temperature_2m[2], 8.678436279296875e-5);
});

test("the analysis window is hour-aligned and lags the present", () => {
  // MRMS lands behind real time; a window running to `now` would document a
  // request that returns nothing.
  const now = Date.UTC(2026, 7, 5, 18, 37, 12);
  const query = REQUESTS.analysis.build(now).body.queries[0];

  assert.equal(query.startTime, "2026-08-05T06:00:00Z");
  assert.equal(query.endTime, "2026-08-05T12:00:00Z");
  assert.equal(hourFloorIso(0, now), "2026-08-05T18:00:00Z");
});

test("the catalog page points at the API docs", () => {
  // /api/ is reachable from the catalog rather than the primary nav, so this link
  // is the only entry point; losing it orphans the page.
  assert.match(CATALOG, /<a href="\/api\/">API<\/a>/);
});
