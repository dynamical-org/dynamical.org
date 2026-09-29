// Runs every request /api/ documents against the live API at build time and hands
// the page the exact command and the exact response.
//
// This is why the page can claim its examples are real: nothing is transcribed.
// It also makes the build the drift detector — the API forbids unknown fields and
// rejects out-of-range windows, so a documented request that stops being valid
// fails the build here rather than misleading a reader indefinitely.
const fetch = require("@11ty/eleventy-fetch");

const {
  REQUESTS,
  classifyFailure,
  curlFor,
  failureDetail,
  formatJson,
} = require("../lib/api-examples.js");

const DATA_API_BASE = process.env.DATA_API_BASE || "https://api.dynamical.org";

// A build always asks the API. eleventy-fetch answers a failed request with an
// expired cache entry whenever the duration is positive, and Pages keeps `.cache`
// between builds, so any cache here would let a deploy render an old response over
// a request the API now refuses — the one thing this file exists to catch.
// `--serve` rebuilds on every save, so it caches for 6h to stay quiet; eleventy-fetch
// keys on method and body as well as URL, so the seven requests cache apart.
function cacheDuration() {
  const serving = ["serve", "watch"].includes(process.env.ELEVENTY_RUN_MODE);
  return process.env.API_EXAMPLES_CACHE_DURATION || (serving ? "6h" : "0s");
}

async function send(request) {
  const url = `${DATA_API_BASE}${request.path}`;
  const options = {
    type: "json",
    duration: cacheDuration(),
    fetchOptions: {
      method: request.method,
      ...(request.body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.body),
          }
        : {}),
    },
  };
  try {
    return await fetch(url, options);
  } catch (error) {
    // A refusal will not change on a second asking.
    if (classifyFailure(error) === "refused") throw error;
    // One retry: these routes open Icechunk archives on a scale-to-zero
    // container, so the first call after an idle period can time out on its own.
    return await fetch(url, options);
  }
}

// A failed build should say what kind of failure it saw, because the fixes differ:
// a refused request usually means the documentation has drifted from the API, and
// a failing API means waiting.
const ADVICE = {
  refused:
    "The API refused a request /api/ documents. If the detail is a validation error, " +
    "the request has drifted from the API: change it in lib/api-examples.js, and the " +
    "prose around it, to match.",
  failed:
    "The API failed rather than refusing the request, so this is not drift: rebuild " +
    "once it recovers, or set DATA_API_BASE to a reachable API.",
  other: "The page cannot show an example it could not fetch.",
};

async function sendFor(name, request) {
  try {
    return await send(request);
  } catch (error) {
    const kind = classifyFailure(error);
    throw new Error(
      `[apiExamples] ${name}: ${request.method} ${request.path} against ${DATA_API_BASE} — ` +
        `${await failureDetail(error)}. ${ADVICE[kind]}`,
      { cause: error }
    );
  }
}

module.exports = async function () {
  const now = Date.now();
  const examples = {};

  for (const [name, definition] of Object.entries(REQUESTS)) {
    const { build, follow, ...limits } = definition;
    const request = build(now);
    let payload = await sendFor(name, request);

    let shown = request;
    if (follow) {
      const next = follow(payload);
      if (!next) {
        throw new Error(
          `[apiExamples] ${name}: the response carried no link to follow, so the ` +
            `documented two-step example no longer holds`
        );
      }
      payload = await sendFor(name, next);
      shown = next;
    }

    examples[name] = {
      curl: curlFor(DATA_API_BASE, shown),
      response: formatJson(payload, limits),
    };
  }

  return { base: DATA_API_BASE, ...examples };
};
