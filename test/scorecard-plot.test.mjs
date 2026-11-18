import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scorecard = new URL("../public/scorecard.js", import.meta.url);
const source = readFileSync(scorecard, "utf8");
// getPlot's import, as `./vendor/…` or `/vendor/…`: scorecard.js is served from
// the site root, so both name the same file under public/vendor/.
const plotPath = source.match(/\bimport\(\s*["']\.?(\/vendor\/plot-[^"']+\.mjs)["']\s*\)/)?.[1];

test("vendored Plot cannot fetch another module at runtime", () => {
  assert.ok(plotPath, "scorecard must import a vendored Plot file");
  const bundle = readFileSync(new URL(`.${plotPath}`, scorecard), "utf8");
  assert.doesNotMatch(bundle, /\b(?:import|export)\s*[^;]*?\bfrom\s*["'`]/);
  assert.doesNotMatch(bundle, /\bimport\s*(?:\(|["'`])/);
  assert.doesNotMatch(bundle, /https:\/\/cdn/);
});

test("scorecard loads a local Plot bundle instead of a CDN", () => {
  assert.doesNotMatch(source, /https?:\/\/[^"'`\s]*@observablehq\/plot/);
  assert.ok(plotPath, "scorecard must import a vendored Plot file");
});
