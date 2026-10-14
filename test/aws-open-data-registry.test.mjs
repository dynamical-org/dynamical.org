import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const nunjucks = require("nunjucks");
const yaml = require("js-yaml");

// Render the registry entry template without Eleventy: drop its front matter
// and stub the one Eleventy filter it uses.
const source = readFileSync(new URL("../content/aws-open-data-registry.njk", import.meta.url), "utf8");
const template = source.replace(/^---\n[\s\S]*?\n---\n/, "");
const env = new nunjucks.Environment(null, { autoescape: true });
env.addFilter("slugify", (s) => s);
const render = (model) => env.renderString(template, { model });

const dataset = (id, extra = {}) => ({
  id,
  title: `Example ${id}`,
  description: `Weather forecasts for ${id}.`,
  time_resolution: "Forecasts initialized every 6 hours",
  notebooks: [{ title: "Quickstart", githubUrl: `https://github.com/dynamical-org/notebooks/blob/main/${id}.ipynb` }],
  ...extra,
});

test("a multi-paragraph model description stays inside the Description block", () => {
  // RRFS's model description is two paragraphs; the second used to land at
  // column 0, ending the block scalar and breaking the whole file.
  const model = {
    id: "noaa-example",
    name: "NOAA Example",
    description: "NOAA's first paragraph.\n\nNOAA Example is pre-operational, so expect changes.",
    datasets: [dataset("noaa-example-forecast")],
  };
  const entry = yaml.load(render(model));
  assert.match(entry.Description, /^NOAA's first paragraph\.\n\nNOAA Example is pre-operational, so expect changes\.\n\nThese datasets/);
  assert.match(entry.Description, /- \[Example noaa-example-forecast\]\(https:\/\/dynamical\.org\/catalog\/noaa-example-forecast\/\) - Weather forecasts/);
  assert.equal(entry.Documentation, "https://dynamical.org/catalog/");
});

test("only datasets with a notebook are listed", () => {
  const model = {
    id: "noaa-example",
    name: "NOAA Example",
    description: "One paragraph.",
    datasets: [dataset("with-notebook"), dataset("without-notebook", { notebooks: [] })],
  };
  const entry = yaml.load(render(model));
  assert.match(entry.Description, /with-notebook/);
  assert.doesNotMatch(entry.Description, /without-notebook/);
  assert.deepEqual(entry.DataAtWork.Tutorials.map((t) => t.Title), ["Example with-notebook — Quickstart"]);
  assert.equal(entry.UpdateFrequency, "Example with-notebook: Forecasts initialized every 6 hours");
  assert.deepEqual(entry.Resources.map((r) => r.ARN), [
    "arn:aws:s3:::dynamical-noaa-example",
    "arn:aws:sns:us-west-2:761136292730:dynamical-noaa-example-object_created",
  ]);
});
