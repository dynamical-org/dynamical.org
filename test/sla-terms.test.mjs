import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SLA = readFileSync(new URL("../content/sla.html", import.meta.url), "utf8");
const TERMS = readFileSync(
  new URL("../content/sla-terms.html", import.meta.url),
  "utf8",
);
// The page wraps prose at arbitrary points; match clauses across line breaks.
const TEXT = TERMS.replace(/\s+/g, " ");

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
  assert.match(TERMS, /does not narrow or expand the rights granted by those\s+licenses/i);
  assert.match(TERMS, /license listed on (?:its|each) catalog\s+page/i);
  assert.match(TERMS, /commercial SLA services/i);
  assert.match(TERMS, /"Order" means a statement of work, invoice, or purchase order accepted by\s+both parties/i);
});

test("keeps ordinary SLA target misses within the SLA remedies", () => {
  assert.match(TERMS, /written notice describing (?:the breach|it)/i);
  assert.match(TERMS, /SLA's credits and termination rights/i);
  assert.match(TERMS, /not, by itself, a material breach/i);
});

test("lets the Order expressly override the default provisions", () => {
  assert.match(TEXT, /Sections 2 through 5 apply unless the Order expressly provides otherwise/i);
  assert.match(TEXT, /Order controls, followed by the applicable SLA, then these terms/i);
  assert.match(TEXT, /versions or dates of the Commercial SLA and these terms identified in the Order govern/i);
  assert.match(TEXT, /do not amend an existing agreement unless both parties agree in writing/i);
});

test("adds and removes covered products only on written confirmation", () => {
  assert.match(TEXT, /Order identifies the data products initially covered/i);
  assert.match(TEXT, /takes effect on the date Dynamical confirms in writing/i);
  assert.match(TEXT, /not covered unless added through this process/i);
});

test("measures timeliness per complete unit from source completion", () => {
  assert.match(TEXT, /"Timeliness Unit"/);
  assert.match(TEXT, /one complete model run for a single initialization time/i);
  assert.match(TEXT, /one complete analysis time step/i);
  assert.match(TEXT, /first Icechunk snapshot commit on the main branch/i);
  assert.match(TEXT, /including when it never completes/i);
  assert.match(TEXT, /retained, replayable event log/i);
  assert.match(TEXT, /not a separate breach for each unit/i);
});

test("defines the support clock and business hours", () => {
  assert.match(TEXT, /team@dynamical\.org/);
  assert.match(TEXT, /09:00.17:00 America\/New_York, Monday through Friday, excluding US federal holidays/i);
  assert.match(TEXT, /eight business hours/i);
  assert.match(TEXT, /24\/7 run continuously/i);
});

test("applies service credits to the next invoice", () => {
  assert.match(TEXT, /Service credits will be applied to Customer's next invoice\./);
});
