import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agencySummary,
  initParts,
  validateDashboard,
} from "../public/pipeline.mjs";

function dashboard() {
  return {
    v: 1,
    generated_at: "2026-07-25T18:00:00Z",
    window_days: 90,
    advisories: [],
    groups: [
      {
        id: "noaa-gfs",
        label: "NOAA GFS forecast",
        products: [
          {
            id: "external-noaa-gfs-aws",
            row_label: "AWS",
            recent_inits: [],
          },
        ],
      },
    ],
  };
}

test("accepts the versioned dashboard contract", () => {
  assert.equal(validateDashboard(dashboard()).groups[0].id, "noaa-gfs");
});

test("rejects empty, unknown, and oversized dashboards", () => {
  assert.throws(() => validateDashboard({}), /invalid pipeline dashboard/i);
  assert.throws(
    () => validateDashboard({ ...dashboard(), v: 2 }),
    /invalid pipeline dashboard/i,
  );
  assert.throws(
    () => validateDashboard({ ...dashboard(), groups: [] }),
    /invalid pipeline dashboard/i,
  );
  const tooMany = dashboard();
  tooMany.groups[0].products[0].recent_inits = Array.from(
    { length: 11 },
    (_, index) => ({ init_time: String(index) }),
  );
  assert.throws(() => validateDashboard(tooMany), /invalid pipeline product/i);
});

test("summarizes upstream agency advisories without changing pipeline state", () => {
  assert.deepEqual(agencySummary([]), {
    state: "nominal",
    label: "nominal",
  });
  assert.deepEqual(
    agencySummary([
      { agency: "noaa" },
      { agency: "noaa" },
      { agency: "ecmwf" },
    ]),
    {
      state: "advisory",
      label: "NOAA, ECMWF advisories",
    },
  );
});

test("formats init labels in UTC and the selected local timezone", () => {
  const timestamp = "2026-07-26T00:00:00Z";
  assert.deepEqual(initParts(timestamp), { date: "07-26", time: "00z" });
  assert.deepEqual(initParts(timestamp, "America/Chicago"), {
    date: "07-25",
    time: "19 CDT",
  });
});

test("status pages share the uptime, pipeline, and webhooks subnav", () => {
  const base = readFileSync(
    new URL("../_includes/base.njk", import.meta.url),
    "utf8",
  );
  const status = readFileSync(
    new URL("../content/status.njk", import.meta.url),
    "utf8",
  );
  const pipeline = readFileSync(
    new URL("../content/status-pipeline.njk", import.meta.url),
    "utf8",
  );
  const subnav = readFileSync(
    new URL("../_includes/status-subnav.njk", import.meta.url),
    "utf8",
  );

  assert.match(status, /include "status-subnav\.njk"/);
  assert.match(status, /statusSection: uptime/);
  assert.match(status, /href="\/status\/pipeline\/"/);
  assert.doesNotMatch(status, /noindex: true|sitemap: false/);
  assert.match(pipeline, /include "status-subnav\.njk"/);
  assert.doesNotMatch(pipeline, /noindex: true|sitemap: false/);
  assert.match(subnav, />uptime</);
  assert.match(subnav, /pipeline/);
  assert.match(subnav, /https:\/\/status\.dynamical\.org\/webhooks/);
  assert.equal((base.match(/href="\/status\/"/g) ?? []).length, 2);
});

test("pipeline page links to webhooks and the integration guide", () => {
  const template = readFileSync(
    new URL("../content/status-pipeline.njk", import.meta.url),
    "utf8",
  );

  assert.match(template, /https:\/\/status\.dynamical\.org\/webhooks/);
  assert.match(template, /\/research\/when-the-forecast-is-ready\//);
  assert.match(
    template,
    /weather agencies[\s\S]*pipeline-time-toggle/,
  );
  assert.match(template, /Dashed segment: forecast horizon not yet published/);
});

test("uptime uses light section headings without subtitles or rules", () => {
  const template = readFileSync(
    new URL("../content/status.njk", import.meta.url),
    "utf8",
  );
  assert.match(template, />Core</);
  assert.match(template, /--index-row-border: 0/);
  assert.doesNotMatch(template, />Endpoints</);
  assert.doesNotMatch(template, /Data-serving and website/);
  assert.doesNotMatch(template, /Built on top of the data/);
  assert.doesNotMatch(template, /The data-serving path/);
  assert.doesNotMatch(template, /\.status-groups section > header/);
});
