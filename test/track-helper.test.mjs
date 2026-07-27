import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Every custom event goes through `window.track`. Two properties make that safe to call
// from any page script, and both are easy to undo by accident:
//
//   1. It is defined outside the `{% if metadata.posthogKey %}` block. Inside it, a build
//      without a key would leave `track` undefined and every call site would throw.
//   2. It no-ops rather than throwing when posthog is absent — which is the normal state
//      off production, where the snippet is gated on the hostname.

const BASE = readFileSync(new URL("../_includes/base.njk", import.meta.url), "utf8");

function trackSource() {
  const blocks = [...BASE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = blocks.filter((b) => b.includes("window.track = function"));
  assert.equal(found.length, 1, "expected exactly one script defining window.track");
  return found[0];
}

function run(source, globals = {}) {
  const sandbox = { console, ...globals };
  sandbox.window = sandbox;
  vm.runInContext(source, vm.createContext(sandbox));
  return sandbox;
}

test("track is defined outside the posthog key conditional", () => {
  const start = BASE.indexOf("{% if metadata.posthogKey %}");
  assert.notEqual(start, -1, "posthog block not found");
  const end = BASE.indexOf("{% endif %}", start);
  assert.notEqual(end, -1, "posthog block is unterminated");

  const guarded = BASE.slice(start, end);
  assert.ok(
    !guarded.includes("window.track"),
    "track is defined inside `{% if metadata.posthogKey %}`; a build without a key would " +
      "leave it undefined and every call site would throw",
  );
});

test("track forwards to posthog.capture when it is present", () => {
  const calls = [];
  const sandbox = run(trackSource(), { posthog: { capture: (e, p) => calls.push([e, p]) } });

  sandbox.track("query_run", { ok: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "query_run");
  assert.equal(calls[0][1].ok, true);
});

test("track is a silent no-op when posthog is absent or broken", () => {
  // Off production the snippet never runs, so posthog is simply not there.
  const absent = run(trackSource());
  assert.doesNotThrow(() => absent.track("query_run", { ok: true }));

  // And a vendor bundle that loaded but throws must not take a page down with it.
  const broken = run(trackSource(), {
    posthog: {
      capture() {
        throw new Error("vendor exploded");
      },
    },
  });
  assert.doesNotThrow(() => broken.track("query_run", { ok: true }));
});
