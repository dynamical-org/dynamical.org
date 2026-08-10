import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SLA = readFileSync(new URL("../content/sla.html", import.meta.url), "utf8");
const TERMS = readFileSync(
  new URL("../content/sla-terms.html", import.meta.url),
  "utf8",
);

test("publishes commercial SLA terms with shared page metadata", () => {
  assert.match(TERMS, /layout: base\.njk/);
  assert.match(TERMS, /title: commercial SLA terms/);
  assert.match(TERMS, /socialTitle: Commercial SLA Terms/);
  assert.match(TERMS, /permalink: \/sla\/terms\//);
  assert.match(TERMS, /eleventyExcludeFromCollections: true/);
});

test("cross-links the SLA and its terms", () => {
  assert.match(SLA, /href="\/sla\/terms\/"/);
  assert.match(TERMS, /href="\/sla\/"/);
});

test("keeps commercial SLA services separate from catalog data licenses", () => {
  assert.match(TERMS, /Dynamical Technology PBC/);
  assert.match(TERMS, /does not purchase data products or data licenses/i);
  assert.match(TERMS, /license listed on (?:its|each) catalog\s+page/i);
  assert.match(TERMS, /commercial SLA services/i);
  assert.doesNotMatch(TERMS, /\bOrder\b/);
});

test("keeps ordinary SLA target misses within the SLA remedies", () => {
  assert.match(TERMS, /written notice describing (?:the breach|it)/i);
  assert.match(TERMS, /SLA's credits and termination rights/i);
  assert.match(TERMS, /not, by itself, a material breach/i);
});
