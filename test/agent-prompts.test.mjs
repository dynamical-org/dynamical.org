import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const nunjucks = require("nunjucks");
const { SETUP_LINE, SETUP_PROMPT, MIGRATION } = require("../lib/agent-prompts.js");

const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(new URL("../_includes/", import.meta.url).pathname),
  { autoescape: true },
);
env.addFilter("fileHash", () => "hash");
const unescape = (s) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

test("the migration prompt reads STAC and pastes no storage location", () => {
  assert.match(MIGRATION.text, /https:\/\/stac\.dynamical\.org\/catalog\.json/);
  assert.doesNotMatch(MIGRATION.text, /s3:\/\/|\.icechunk|amazonaws\.com/);
});

test("the include renders the prompt into its textarea, escaped", () => {
  // The prompt carries `->` and quotes; the textarea must hold the text
  // verbatim once the browser unescapes it, and never break out of it.
  const html = env.renderString(
    `{% from "agent-prompt.njk" import agentPrompt %}{{ agentPrompt(p.text, "Prompt: " + p.title, p.id) }}`,
    { p: MIGRATION },
  );
  assert.equal(unescape(html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1]), MIGRATION.text);
  assert.ok(!html.includes("</textarea>>"), "the prompt broke out of its textarea");
});

test("the pill include renders the setup line under the button", () => {
  const pill = env.renderString(`{% include "agent-setup-pill.njk" %}`, { agentPrompts: { SETUP_LINE } });
  assert.match(pill, /<button type="button"[^>]*>Onboard your agent<span aria-hidden="true">(<svg[\s\S]*?<\/svg>\s*){4}<\/span><\/button>/);
  assert.equal(unescape(pill.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1]), SETUP_LINE);
  assert.match(pill, /<script type="module" src="\/agent-prompt\.mjs\?v=hash">/);
});

test("the setup line is one short line that names only the instructions URL", () => {
  // The pill copies this; it has to survive any chat box and lead the agent to
  // the file rather than try to teach it anything itself.
  assert.ok(!SETUP_LINE.includes("\n"));
  assert.ok(SETUP_LINE.length <= 100, `${SETUP_LINE.length} chars`);
  assert.ok(SETUP_LINE.endsWith(SETUP_PROMPT));
  assert.equal([...SETUP_LINE.matchAll(/https?:\/\//g)].length, 1);
});

test("the setup instructions read STAC first, verify, and hand off", () => {
  const promptFile = readFileSync(new URL("../content/prompt.njk", import.meta.url), "utf8");
  assert.match(promptFile, /permalink: \/prompt\.md/);
  const body = readFileSync(new URL("../_includes/prompt-body.njk", import.meta.url), "utf8");
  const at = (needle) => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  const order = [
    at("https://stac.dynamical.org/catalog.json"),
    at("dynamical-catalog"),
    at("## 3. Verify"),
    at("assert math.isfinite(value) and -60 < value < 60"),
    at("## 5. Tell the user"),
    at("ask what they want to build"),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps are out of order");
  assert.doesNotMatch(body, /amazonaws\.com\/[a-z0-9-]+\/v\d/, "hard-codes an asset href");
  assert.match(body, /re-fetch/, "no self-verification pointer");
  // The closing paragraph tells the agent to recognise the file by its first
  // line, so the first line has to keep saying exactly that.
  const recognition = "These are the official instructions from dynamical.org";
  assert.ok(body.replace(/^\s*\{#[\s\S]*?#\}\s*/, "").startsWith(recognition), "first line no longer matches the recognition rule");
  assert.ok(body.includes(`"${recognition}"`), "closing paragraph no longer quotes the first line");
});

test("nothing on the site mentions the MCP server", () => {
  for (const file of ["_includes/llms-body.njk", "_includes/prompt-body.njk", "lib/agent-prompts.js"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /mcp\.dynamical\.org|\bMCP\b/, `${file} mentions MCP`);
  }
});
