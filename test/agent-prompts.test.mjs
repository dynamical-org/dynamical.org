import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const nunjucks = require("nunjucks");
const { SETUP_LINE, SETUP_PROMPT, MIGRATION, datasetPrompt } = require("../lib/agent-prompts.js");

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

// Catalog entries as _data/catalog.js shapes them, trimmed to the fields the
// dataset prompt reads. One per kind of task it writes.
const GLOBAL = [-180, -90, 179.75, 90];
const entry = (overrides) => ({
  id: "noaa-gfs-forecast",
  title: "NOAA GFS forecast",
  forecast_domain: "Forecast lead time 0-384 hours (0-16 days) ahead",
  optimization: "time",
  spatial_bbox: GLOBAL,
  dimensions: [{ name: "init_time" }, { name: "lead_time" }, { name: "latitude" }, { name: "longitude" }],
  variables: [
    { name: "categorical_freezing_rain_surface", long_name: "Categorical freezing rain" },
    { name: "temperature_2m", long_name: "2 metre temperature" },
  ],
  ...overrides,
});
const task = (text) => text.slice(text.indexOf("\n\n") + 2);

test("the dataset prompt is the setup line, then one task naming the dataset's STAC", () => {
  const text = datasetPrompt(entry());
  assert.ok(text.startsWith(`${SETUP_LINE}\n\n`));
  // prompt.md ends by asking what the user wants to build; the task has to
  // read as that answer rather than a second, competing instruction.
  assert.match(task(text), /^After setup, my task: /);
  assert.ok(!task(text).includes("\n"), "the task is one paragraph");
  assert.ok(task(text).includes("open noaa-gfs-forecast (https://stac.dynamical.org/noaa-gfs-forecast/collection.json)"));
  assert.deepEqual([...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[).,]+$/, "")), [
    SETUP_PROMPT,
    "https://stac.dynamical.org/noaa-gfs-forecast/collection.json",
  ]);
  assert.doesNotMatch(text, /s3:\/\/|\.icechunk|amazonaws\.com|data\.dynamical\.org/);
  assert.ok(text.length <= 400, `${text.length} chars`);
});

test("a time-optimized forecast asks for one run's series at a place", () => {
  assert.equal(
    task(datasetPrompt(entry())),
    "After setup, my task: open noaa-gfs-forecast (https://stac.dynamical.org/noaa-gfs-forecast/collection.json) and plot 2 metre temperature (temperature_2m) at the grid point nearest New York City (40.71, -74.01) for every lead time of the latest init_time with data. Say which times you used.",
  );
});

test("an ensemble forecast asks for a line per member", () => {
  const dims = [...entry().dimensions, { name: "ensemble_member" }];
  assert.match(task(datasetPrompt(entry({ dimensions: dims }))), /lead time of the latest init_time with data, one line per ensemble_member\. Say which times you used\.$/);
});

test("a time-optimized analysis asks for a recent window at a place", () => {
  const text = task(
    datasetPrompt(
      entry({
        id: "nasa-imerg-analysis-late",
        title: "NASA IMERG analysis, late",
        forecast_domain: null,
        dimensions: [{ name: "time" }, { name: "latitude" }, { name: "longitude" }],
        // The quality index sorts first; the prompt must still pick the rate.
        variables: [
          { name: "precipitation_quality_index_surface", long_name: "Precipitation quality index" },
          { name: "precipitation_surface", long_name: "Precipitation rate" },
        ],
      }),
    ),
  );
  assert.match(text, /plot precipitation rate \(precipitation_surface\) at the grid point nearest New York City \(40\.71, -74\.01\) over the 7 days up to its latest time with data\. Say which times you used\.$/);
});

test("a map-optimized product asks for one map, never a place", () => {
  const forecast = task(datasetPrompt(entry({ optimization: "space" })));
  assert.match(forecast, /map 2 metre temperature \(temperature_2m\) across the whole grid at the first lead_time of the latest init_time with data\. Say which times you used\.$/);
  const ensemble = task(
    datasetPrompt(entry({ optimization: "space", dimensions: [...entry().dimensions, { name: "ensemble_member" }] })),
  );
  assert.match(ensemble, /first lead_time of the latest init_time with data, averaged over ensemble_member\. Say which times you used\.$/);
  const analysis = task(datasetPrompt(entry({ optimization: "space", forecast_domain: null })));
  assert.match(analysis, /across the whole grid at the latest time with data\. Say which times you used\.$/);
});

test("the place is one the product covers", () => {
  const europe = task(datasetPrompt(entry({ spatial_bbox: [-23.5, 29.5, 62.5, 70.5] })));
  assert.match(europe, /nearest London \(51\.51, -0\.13\)/);
  // Nowhere named fits: the middle of the domain, by its coordinates.
  const elsewhere = task(datasetPrompt(entry({ spatial_bbox: [100, -40, 160, -10] })));
  assert.match(elsewhere, /nearest \(-25\.00, 130\.00\)/);
});

test("the variable falls back through maximum temperature to the first listed", () => {
  const vars = (...names) => names.map((name) => ({ name, long_name: name.replace(/_/g, " ") }));
  assert.match(task(datasetPrompt(entry({ variables: vars("cape_surface", "maximum_temperature_2m") }))), /\(maximum_temperature_2m\)/);
  assert.match(task(datasetPrompt(entry({ variables: vars("cape_surface", "wind_u_10m") }))), /\(cape_surface\)/);
});
