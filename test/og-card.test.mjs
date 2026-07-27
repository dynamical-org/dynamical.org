import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import sharp from "sharp";

const require = createRequire(import.meta.url);
const { cardContext } = require("../lib/og-card-context.js");
const { renderCard } = require("../lib/og-card.js");

test("maps public routes to durable, section-aware card context", () => {
  const cases = [
    ["/", "weather + climate", "Explore the work"],
    ["/catalog/", "data catalog", "Explore the catalog"],
    ["/catalog/models/noaa-gfs/", "model archive", "Explore model data"],
    [
      "/catalog/noaa-gfs-forecast/validation/",
      "validation report",
      "Review the checks",
    ],
    ["/scorecard/", "forecast evaluation", "Explore the scorecard"],
    ["/research/forecast-evaluation/", "research", "Read the research"],
    ["/updates/2026-07-13/", "dispatch", "Read the update"],
    ["/podcast/008/", "weathering podcast", "Listen to the episode"],
    ["/meetings/steering-committee/2025-12-03/", "steering committee", "Read the notes"],
    ["/about/", "about", "Meet dynamical"],
    ["/privacy/", "privacy", "Read the policy"],
  ];

  for (const [url, label, action] of cases) {
    const context = cardContext(url);
    assert.equal(context.label, label);
    assert.equal(context.action, action);
    assert.equal(context.items.length, 3);
  }
});

test("status contexts explain the live pages without embedding telemetry", () => {
  assert.deepEqual(cardContext("/status/"), {
    label: "system status",
    action: "Open for current conditions",
    items: [
      { name: "availability", detail: "service reachability" },
      { name: "incidents", detail: "active + resolved events" },
      { name: "history", detail: "rolling 90-day record" },
    ],
  });
  assert.deepEqual(cardContext("/status/pipeline/"), {
    label: "data pipeline",
    action: "Open the live pipeline",
    items: [
      { name: "source runs", detail: "forecast arrival" },
      { name: "latency", detail: "expected delivery" },
      { name: "advisories", detail: "upstream notices" },
    ],
  });

  const serialized = JSON.stringify([
    cardContext("/status/"),
    cardContext("/status/pipeline/"),
  ]);
  assert.doesNotMatch(
    serialized,
    /operational|degraded|down|failed|timestamp|generated_at|recent_inits/,
  );
});

test("status metadata describes the destination instead of a cached snapshot", () => {
  for (const source of ["status.njk", "status-pipeline.njk"]) {
    const template = readFileSync(
      new URL(`../content/${source}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(template, /socialImageAlt:.*snapshot/i);
    assert.doesNotMatch(template, /socialImageAlt:.*current.*state/i);
  }
});

test("artwork is composed into generated cards and scorecard details share one image", () => {
  const base = readFileSync(
    new URL("../_includes/base.njk", import.meta.url),
    "utf8",
  );
  const catalog = readFileSync(
    new URL("../content/catalog-pages.njk", import.meta.url),
    "utf8",
  );
  const imageBaseUrl = readFileSync(
    new URL("../_data/socialImageBaseUrl.js", import.meta.url),
    "utf8",
  );
  assert.match(base, /socialImageBaseUrl \+ "\/assets\/og\/"/);
  assert.match(imageBaseUrl, /process\.env\.CF_PAGES_URL/);
  assert.match(imageBaseUrl, /https:\/\/dynamical\.org/);
  assert.match(base, /dynamical:card-artwork/);
  assert.match(catalog, /socialCardImage: '\{\{ entry\.thumbnail \}\}'/);
  assert.doesNotMatch(catalog, /socialImage: '\{\{ entry\.thumbnail \}\}'/);

  for (const source of ["scorecard-state.njk", "scorecard-station.njk"]) {
    const template = readFileSync(
      new URL(`../content/${source}`, import.meta.url),
      "utf8",
    );
    assert.match(template, /socialCardSlug: scorecard/);
    assert.match(template, /eleventyComputed:\n  title:/);
    assert.match(template, /\n  description:/);
  }
});

test("renders plain, status, and artwork cards as 1200 by 630 PNGs", async () => {
  const artwork = readFileSync(
    new URL(
      "../public/assets/catalog-thumbnails/noaa-gfs-forecast.jpg",
      import.meta.url,
    ),
  ).toString("base64");
  const cards = await Promise.all([
    renderCard({
      title: "Open weather data",
      subtitle: "Analysis-ready weather data for everyone.",
      url: "https://dynamical.org/catalog/",
      context: cardContext("/catalog/"),
    }),
    renderCard({
      title: "Live system status",
      subtitle:
        "Availability, incidents, and history for dynamical.org services.",
      url: "https://dynamical.org/status/",
      context: cardContext("/status/"),
    }),
    renderCard({
      title:
        "A very long validation report title that still needs to remain safely inside the social-card canvas at every supported preview size",
      subtitle:
        "Completeness, spatial, temporal, and availability checks for a published weather dataset.",
      url:
        "https://dynamical.org/catalog/noaa-gfs-forecast/validation/",
      context: cardContext("/catalog/noaa-gfs-forecast/validation/"),
      artwork: `data:image/jpeg;base64,${artwork}`,
    }),
  ]);

  for (const card of cards) {
    const metadata = await sharp(card).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 630);
  }
});
