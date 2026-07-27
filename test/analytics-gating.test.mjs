import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The third-party snippets in base.njk are inline, so they can't be imported. Pull each
// one out of the template and run it against a stub DOM to assert what it does per host.
//
// This exists because the previous Sentry gate read correctly but did the opposite of what
// it claimed: it returned early from `sentryOnLoad` without calling `Sentry.init()`, and the
// loader then ran `isInitialized() || Sentry.init()` and initialized itself with the
// dashboard's default config. Only an end-to-end "what actually happens on localhost" check
// catches that class of bug.

const BASE = readFileSync(new URL("../_includes/base.njk", import.meta.url), "utf8");
const KEY = "testkey123";

function inlineScript(marker) {
  const blocks = [...BASE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = blocks.filter((b) => b.includes(marker));
  assert.equal(found.length, 1, `expected exactly one inline script containing "${marker}"`);
  return found[0]
    .replaceAll("{{ metadata.sentryPublicKey }}", KEY)
    .replaceAll("{{ metadata.posthogKey }}", KEY);
}

// Records every <script> the snippet injects, by either appendChild or insertBefore.
function run(source, hostname) {
  const injected = [];
  const scriptStub = () => ({ parentNode: { insertBefore: (el) => injected.push(el) } });
  const sandbox = {
    location: { hostname },
    console,
    document: {
      createElement: () => ({}),
      head: { appendChild: (el) => injected.push(el) },
      getElementsByTagName: () => [scriptStub()],
    },
  };
  sandbox.window = sandbox;
  vm.runInContext(source, vm.createContext(sandbox));
  return { sandbox, injected };
}

const OFF_PRODUCTION = ["localhost", "127.0.0.1", "dynamical-org.pages.dev", "dynamical.org.evil.com"];

test("sentry loader is not injected off production", () => {
  const source = inlineScript("sentryLoader");
  for (const hostname of OFF_PRODUCTION) {
    const { sandbox, injected } = run(source, hostname);
    assert.deepEqual(injected, [], `injected a script on ${hostname}`);
    assert.equal(sandbox.sentryOnLoad, undefined, `defined sentryOnLoad on ${hostname}`);
  }
});

test("sentry loader is injected on production and initializes itself", () => {
  const { sandbox, injected } = run(inlineScript("sentryLoader"), "dynamical.org");

  assert.equal(injected.length, 1);
  assert.equal(injected[0].src, `https://js.sentry-cdn.com/${KEY}.min.js`);
  assert.equal(injected[0].crossOrigin, "anonymous");

  // The gate is only safe because sentryOnLoad calls init. If it ever stops doing so, the
  // loader falls through to its own `Sentry.init()` with the dashboard defaults (tracing
  // and session replay included) instead of the config declared here.
  assert.equal(typeof sandbox.sentryOnLoad, "function");
  const initCalls = [];
  sandbox.Sentry = { init: (opts) => initCalls.push(opts) };
  sandbox.sentryOnLoad();
  assert.equal(initCalls.length, 1);
  assert.equal(initCalls[0].environment, "production");
});

test("posthog is not loaded off production", () => {
  const source = inlineScript("posthog.init");
  for (const hostname of OFF_PRODUCTION) {
    const { sandbox, injected } = run(source, hostname);
    assert.deepEqual(injected, [], `injected a script on ${hostname}`);
    assert.equal(sandbox.posthog, undefined, `defined posthog on ${hostname}`);
  }
});

test("posthog is loaded on production", () => {
  const { sandbox, injected } = run(inlineScript("posthog.init"), "dynamical.org");

  assert.equal(injected.length, 1);
  assert.match(injected[0].src, /posthog\.com\/static\/array\.js$/);

  // The stub snippet queues calls until array.js swaps in the real client; init must be
  // queued with the project key so the queued pageview is attributed correctly.
  const init = sandbox.posthog._i.at(-1);
  assert.equal(init[0], KEY);
  assert.equal(init[1].api_host, "https://us.i.posthog.com");
  assert.equal(init[1].person_profiles, "identified_only");
});
