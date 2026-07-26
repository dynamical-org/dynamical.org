import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agencySummary,
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

test("status pages share the pipeline and webhooks subnav", () => {
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
  assert.match(status, /href="\/status\/pipeline\/"/);
  assert.match(pipeline, /include "status-subnav\.njk"/);
  assert.match(subnav, /pipeline/);
  assert.match(subnav, /https:\/\/status\.dynamical\.org\/webhooks/);
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
});
