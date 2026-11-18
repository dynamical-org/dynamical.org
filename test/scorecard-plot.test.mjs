import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import test from "node:test";

const scorecard = new URL("../public/scorecard.js", import.meta.url);
const source = readFileSync(scorecard, "utf8");
const plotPath = source.match(/\bimport\(\s*["'](\.\/vendor\/plot-[^"']+\.mjs)["']\s*\)/)?.[1];

test("vendored Plot cannot fetch another module at runtime", () => {
  const bundle = readFileSync(new URL("../public/vendor/plot-0.6.17.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bundle, /\b(?:import|export)\s*[^;]*?\bfrom\s*["'`]/);
  assert.doesNotMatch(bundle, /\bimport\s*(?:\(|["'`])/);
  assert.doesNotMatch(bundle, /https:\/\/cdn/);
});

test("scorecard loads an existing local Plot bundle instead of a CDN", () => {
  assert.doesNotMatch(source, /https?:\/\/[^"'`\s]*@observablehq\/plot/);
  assert.ok(plotPath, "scorecard must import a module-relative vendored Plot file");
  accessSync(new URL(plotPath, scorecard));
});
