// Runs every request /api/ documents against the live API at build time and hands
// the page the exact command and the exact response.
//
// This is why the page can claim its examples are real: nothing is transcribed.
// It also makes the build the drift detector — the API forbids unknown fields and
// rejects out-of-range windows, so a documented request that stops being valid
// fails the build here rather than misleading a reader indefinitely.
const fetch = require("@11ty/eleventy-fetch");

const { REQUESTS, curlFor, formatJson } = require("../lib/api-examples.js");

const DATA_API_BASE = process.env.DATA_API_BASE || "https://api.dynamical.org";
// eleventy-fetch keys its cache on method and body as well as URL, so the seven
// requests cache independently and a rebuild during local editing does not
// re-issue them. Long enough to keep `--serve` quiet, short enough that a daily
// build still shows a current run.
const CACHE_DURATION = process.env.API_EXAMPLES_CACHE_DURATION || "6h";

async function send(request) {
  const url = `${DATA_API_BASE}${request.path}`;
  const options = {
    type: "json",
    duration: CACHE_DURATION,
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
    // One retry: these routes open Icechunk archives on a scale-to-zero
    // container, so the first call after an idle period can time out on its own.
    return await fetch(url, options);
  }
}

module.exports = async function () {
  const now = Date.now();
  const examples = {};

  for (const [name, definition] of Object.entries(REQUESTS)) {
    const { build, follow, ...limits } = definition;
    const request = build(now);
    let payload;
    try {
      payload = await send(request);
    } catch (error) {
      throw new Error(
        `[apiExamples] ${name}: ${request.method} ${request.path} failed against ` +
          `${DATA_API_BASE} — ${error.message}. The page cannot show an example it ` +
          `could not fetch; set DATA_API_BASE to a reachable API or fix the request.`
      );
    }

    let shown = request;
    if (follow) {
      const next = follow(payload);
      if (!next) {
        throw new Error(
          `[apiExamples] ${name}: the response carried no link to follow, so the ` +
            `documented two-step example no longer holds`
        );
      }
      payload = await send(next);
      shown = next;
    }

    examples[name] = {
      curl: curlFor(DATA_API_BASE, shown),
      response: formatJson(payload, limits),
    };
  }

  return { base: DATA_API_BASE, ...examples };
};
