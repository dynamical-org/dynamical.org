import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import sharp from "sharp";

import {
  createPipelineCardModel,
  createStatusCardModel,
  loadPipelineCardModel,
  loadStatusCardModel,
  unavailablePipelineCardModel,
  unavailableStatusCardModel,
} from "../lib/status-og-card.mjs";
import { buildHistory } from "../public/status.mjs";

const require = createRequire(import.meta.url);
const { renderCard } = require("../lib/og-card.js");

const statusFixture = JSON.parse(
  readFileSync(new URL("./fixtures/status.json", import.meta.url), "utf8"),
);
const pipelineFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/pipeline-dashboard.json", import.meta.url),
    "utf8",
  ),
);
const eventsFixture = readFileSync(
  new URL("./fixtures/events.jsonl", import.meta.url),
  "utf8",
);

function statusHistory() {
  return buildHistory(
    eventsFixture,
    JSON.stringify({
      v: 1,
      reconciled_at: statusFixture.generated_at,
      events_count: 14,
    }),
  );
}

test("projects the uptime snapshot into five component rows with history", () => {
  const model = createStatusCardModel(statusFixture, statusHistory(), {
    now: new Date("2026-07-24T20:00:00Z"),
  });

  assert.equal(model.variant, "status");
  assert.equal(model.state, "down");
  assert.equal(model.headline, "Service disruption");
  assert.equal(model.timestamp, "2026-07-24 · 19:55 UTC");
  assert.equal(model.components.length, 5);
  assert.deepEqual(
    model.components.map(({ name, state }) => [name, state]),
    [
      ["dynamical.org website", "operational"],
      ["STAC catalog", "operational"],
      ["Data product reads", "down"],
      ["wxopticon", "operational"],
      ["scorecard", "operational"],
    ],
  );
  assert.equal(model.components[2].history.length, 90);
  assert.equal(model.components[2].history.at(-1), "down");
});

test("marks an old uptime snapshot stale without discarding its detail", () => {
  const model = createStatusCardModel(statusFixture, statusHistory(), {
    now: new Date("2026-07-24T20:15:00.001Z"),
  });

  assert.equal(model.state, "stale");
  assert.equal(model.headline, "Status snapshot is stale");
  assert.equal(model.components.length, 5);
});

test("projects recent pipeline runs by model and summarizes latest states", () => {
  const model = createPipelineCardModel(pipelineFixture, {
    now: new Date("2026-07-25T18:05:00Z"),
  });

  assert.equal(model.variant, "pipeline");
  assert.equal(model.state, "advisory");
  assert.equal(model.headline, "Upstream advisory active");
  assert.equal(model.timestamp, "2026-07-25 · 18:00 UTC");
  assert.equal(model.advisory, "NOAA advisory");
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].label, "NOAA GFS forecast");
  assert.deepEqual(model.rows[0].runs, [
    "complete",
    "complete",
    "complete",
    "complete",
    "complete",
    "delayed",
    "failed",
    "delayed",
  ]);
  assert.deepEqual(model.latest, {
    complete: 0,
    pending: 0,
    processing: 0,
    delayed: 1,
    failed: 0,
    unobserved: 0,
    unknown: 0,
  });
});

test("marks an old pipeline artifact stale", () => {
  const model = createPipelineCardModel(pipelineFixture, {
    now: new Date("2026-07-25T18:10:00.001Z"),
  });

  assert.equal(model.state, "stale");
  assert.equal(model.headline, "Pipeline snapshot is stale");
});

test("provides explicit unavailable models", () => {
  assert.deepEqual(unavailableStatusCardModel(), {
    variant: "status",
    state: "unavailable",
    headline: "Status snapshot unavailable",
    summary: "Visit the status page for the current view.",
    timestamp: "snapshot unavailable",
    components: [],
  });
  assert.deepEqual(unavailablePipelineCardModel(), {
    variant: "pipeline",
    state: "unavailable",
    headline: "Pipeline snapshot unavailable",
    summary: "Visit the pipeline page for the current view.",
    timestamp: "snapshot unavailable",
    advisory: "source status unavailable",
    latest: {
      complete: 0,
      pending: 0,
      processing: 0,
      delayed: 0,
      failed: 0,
      unobserved: 0,
      unknown: 0,
    },
    rows: [],
    extraRows: 0,
  });
});

test("renders expected-but-not-started pipeline cycles as pending", () => {
  const data = structuredClone(pipelineFixture);
  const latest = data.groups[0].products[0].recent_inits.at(-1);
  latest.status = "pending";
  delete latest.timing;

  const model = createPipelineCardModel(data, {
    now: new Date("2026-07-25T18:05:00Z"),
  });

  assert.equal(model.latest.pending, 1);
  assert.equal(model.rows[0].runs.at(-1), "pending");
  assert.match(model.summary, /1 pending/);
});

test("clamps oversized pipeline matrices to the card canvas", async () => {
  const data = structuredClone(pipelineFixture);
  data.groups = Array.from({ length: 8 }, (_, index) => {
    const group = structuredClone(pipelineFixture.groups[0]);
    group.id = `group-${index}`;
    group.label =
      `ECMWF IFS ENS forecast, 15 day, 0.25 degree variant ${index + 1}`;
    return group;
  });

  const model = createPipelineCardModel(data, {
    now: new Date("2026-07-25T18:05:00Z"),
  });

  assert.equal(model.rows.length, 6);
  assert.equal(model.rows.every(({ runs }) => runs.length === 8), true);
  assert.equal(model.extraRows, 2);
  const metadata = await sharp(await renderCard({ snapshot: model })).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 630);
});

test("loaders degrade failed artifacts to explicit unavailable snapshots", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });

  assert.deepEqual(
    await loadStatusCardModel({
      statusUrl: "https://example.test/status.json",
      logBase: "https://example.test",
      fetchImpl,
    }),
    unavailableStatusCardModel(),
  );
  assert.deepEqual(
    await loadPipelineCardModel({
      assetsBase: "https://example.test",
      fetchImpl,
    }),
    unavailablePipelineCardModel(),
  );
});

test("uptime loader keeps current state when history is unavailable", async () => {
  const fetchImpl = async (url) =>
    url.endsWith("status.json")
      ? {
          ok: true,
          json: async () => statusFixture,
        }
      : { ok: false, status: 503 };

  const model = await loadStatusCardModel({
    statusUrl: "https://example.test/status.json",
    logBase: "https://example.test",
    fetchImpl,
    now: new Date("2026-07-24T20:00:00Z"),
  });

  assert.equal(model.state, "down");
  assert.equal(model.components.length, 5);
  assert.equal(model.components.every(({ history }) => history.length === 0), true);
});

test("renders rich and generic cards as 1200 by 630 PNGs", async () => {
  const status = createStatusCardModel(statusFixture, statusHistory(), {
    now: new Date("2026-07-24T20:00:00Z"),
  });
  const pipeline = createPipelineCardModel(pipelineFixture, {
    now: new Date("2026-07-25T18:05:00Z"),
  });
  const cards = await Promise.all([
    renderCard({ snapshot: status }),
    renderCard({ snapshot: pipeline }),
    renderCard({
      title: "Open weather data",
      subtitle: "Analysis-ready weather data for everyone.",
      label: "data catalog",
    }),
  ]);

  for (const card of cards) {
    const metadata = await sharp(card).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 630);
  }
});
