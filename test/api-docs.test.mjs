import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// /api/ is the only page whose interactive part talks to a service this repo does
// not build. The e2e spec exercises that for real; these checks are the instant
// ones — that the page and its module still agree with each other, and that the
// module has no host baked into it, which is what keeps a local preview
// (DATA_API_BASE) from silently exercising production.

const PAGE = readFileSync(new URL("../content/api.njk", import.meta.url), "utf8");
const MODULE = readFileSync(new URL("../public/api-docs.mjs", import.meta.url), "utf8");
const CATALOG = readFileSync(new URL("../content/catalog.njk", import.meta.url), "utf8");

test("every run-it button has a request behind it", () => {
  const buttons = [...PAGE.matchAll(/data-try="(\w+)"/g)].map((m) => m[1]);
  const requests = [...MODULE.matchAll(/^ {2}(\w+): \(\) => \(\{/gm)].map((m) => m[1]);

  assert.ok(buttons.length > 0, "the page renders no run-it buttons");
  for (const button of buttons) {
    assert.ok(requests.includes(button), `no request defined for data-try="${button}"`);
  }
});

test("requests are relative paths against the injected base", () => {
  // A hard-coded hostname would make DATA_API_BASE a lie and keep working after
  // the deployed hostname changes.
  assert.ok(
    !MODULE.includes("api.dynamical.org"),
    "api-docs.mjs should take its host from data-api-base, not hard-code one"
  );
  const paths = [...MODULE.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length > 0, "no request paths found");
  for (const path of paths) {
    assert.ok(path.startsWith("/v1/"), `${path} is not a relative /v1 path`);
  }
});

test("the page wires the module to the configured base", () => {
  assert.match(PAGE, /id="api-docs"/);
  assert.match(PAGE, /data-api-base="\{\{ dataApiBase \}\}"/);
  assert.match(PAGE, /<script type="module" src="\/api-docs\.mjs"><\/script>/);
});

test("the catalog page points at the API docs", () => {
  // /api/ is reachable from the catalog rather than the primary nav, so this link
  // is the only entry point; losing it orphans the page.
  assert.match(CATALOG, /<a href="\/api\/">API<\/a>/);
});
