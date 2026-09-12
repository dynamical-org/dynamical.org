import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const nunjucks = require("nunjucks");
const { PROMPTS, SETUP, MIGRATION, datasetPrompt, wordCount, STAC_CATALOG, LLMS_TXT } =
  require("../lib/agent-prompts.js");

// Every prompt is pasted cold into an assistant with nothing else, so each one
// must carry the one resource an agent needs (the STAC catalog, or a collection
// in it) and none may teach the habits llms.txt warns against: retired
// data.dynamical.org URLs and hard-coded storage locations.

const GFS = {
  id: "noaa-gfs-forecast",
  title: "NOAA GFS forecast",
  stac_href: "https://stac.dynamical.org/noaa-gfs-forecast/collection.json",
  dimensions: ["init_time", "lead_time", "latitude", "longitude"].map((name) => ({ name })),
  optimization: "time",
};

const every = [...PROMPTS, ...SETUP, { id: "dataset", text: datasetPrompt(GFS) }, MIGRATION];

test("every prompt names the STAC catalog, a collection in it, or llms.txt", () => {
  // The presentation prompt goes through the JSON API instead of the archives,
  // so llms.txt (which names STAC) is enough there.
  for (const { id, text } of every) {
    assert.match(
      text,
      /https:\/\/stac\.dynamical\.org\/|https:\/\/dynamical\.org\/llms\.txt/,
      `${id} never mentions STAC or llms.txt`,
    );
  }
});

test("the minimum prompt needs nothing but STAC", () => {
  const minimum = PROMPTS.find((p) => p.id === "minimum");
  assert.ok(minimum.text.includes(STAC_CATALOG));
  assert.ok(!minimum.text.includes(LLMS_TXT), "the minimum should not depend on llms.txt");
});

test("the richer prompts point at llms.txt for the conventions", () => {
  for (const id of ["standard", "presentation", "verification", "ensemble"]) {
    const prompt = PROMPTS.find((p) => p.id === id);
    assert.ok(prompt.text.includes(LLMS_TXT), `${id} should read llms.txt`);
  }
});

test("no prompt pastes a storage location or a retired URL", () => {
  for (const { id, text } of every) {
    assert.doesNotMatch(text, /s3:\/\/|\.icechunk|amazonaws\.com/, `${id} hard-codes storage`);
    if (id !== "migration") {
      assert.doesNotMatch(text, /data\.dynamical\.org/, `${id} mentions the retired host`);
    }
  }
});

test("the general prompts stay short enough to paste anywhere", () => {
  for (const { id, text } of [...PROMPTS, ...SETUP, { id: "dataset", text: datasetPrompt(GFS) }]) {
    assert.ok(wordCount(text) <= 150, `${id} runs to ${wordCount(text)} words`);
  }
});

test("every data prompt bounds the read before loading", () => {
  // A point alone still permits decades of data; the window has to be named.
  for (const { id, text } of [...PROMPTS, { id: "dataset", text: datasetPrompt(GFS) }]) {
    if (id === "presentation") {
      assert.match(text, /validTimeStart now and validTimeEnd 7 days from now/, "the API query has no valid-time window");
      continue;
    }
    assert.match(text, /time window before loading|first 5 days only|valid times/, `${id} never bounds the read`);
  }
});

test("the dataset prompt carries the id, its collection, and its dimensions", () => {
  const text = datasetPrompt(GFS);
  assert.ok(text.includes(`dynamical_catalog.open("${GFS.id}")`));
  assert.ok(text.includes(GFS.stac_href));
  assert.ok(text.includes("init_time, lead_time, latitude, longitude"));
  assert.match(text, /time series/);
  assert.match(datasetPrompt({ ...GFS, optimization: "space" }), /whole-grid/);
});

test("prompt ids are unique and the page loops over both sets", () => {
  const ids = [...PROMPTS, ...SETUP, MIGRATION].map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const page = readFileSync(new URL("../content/agents.njk", import.meta.url), "utf8");
  assert.match(page, /agentPrompts\.PROMPTS/);
  assert.match(page, /agentPrompts\.SETUP/);
});

test("the include renders every prompt into its textarea, escaped", () => {
  // The migration prompt carries `>=` and quotes; the textarea must hold the
  // text verbatim once the browser unescapes it, and never break out of it.
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(new URL("../_includes/", import.meta.url).pathname),
    { autoescape: true },
  );
  env.addFilter("fileHash", () => "hash");
  const page = `{% from "agent-prompt.njk" import agentPrompt %}{% for p in prompts %}{{ agentPrompt(p.text, "Prompt: " + p.title, p.id) }}{% endfor %}`;
  const html = env.renderString(page, { prompts: [...PROMPTS, ...SETUP, MIGRATION] });
  const unescape = (s) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const bodies = [...html.matchAll(/<textarea[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => unescape(m[1]));
  assert.deepEqual(bodies, [...PROMPTS, ...SETUP, MIGRATION].map((p) => p.text));
  assert.equal(html.match(/<script type="module"/g).length, bodies.length, "one module tag per prompt, deduped by the browser");
  assert.ok(!html.includes("</textarea>>"), "a prompt broke out of its textarea");
});
