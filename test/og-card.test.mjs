import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import sharp from "sharp";

const require = createRequire(import.meta.url);
const { cardLabel } = require("../lib/og-card-label.js");
const { renderCardIndex } = require("../lib/og-card-index.js");
const { renderCard, bindWithinFacts, subtitleCharsPerLine } = require(
  "../lib/og-card.js",
);

test("maps public routes to a durable section label", () => {
  const cases = [
    ["/", "weather + climate"],
    ["/catalog/", "data catalog"],
    ["/catalog/models/noaa-gfs/", "model archive"],
    ["/catalog/noaa-gfs-forecast/validation/", "validation report"],
    ["/scorecard/", "forecast evaluation"],
    ["/research/forecast-evaluation/", "research"],
    ["/updates/2026-07-13/", "dispatch"],
    ["/podcast/008/", "weathering podcast"],
    ["/meetings/steering-committee/2025-12-03/", "steering committee"],
    ["/about/", "about"],
    ["/privacy/", "privacy"],
    ["/status/", "system status"],
    ["/status/pipeline/", "data pipeline"],
    ["/some-unmapped-page/", "weather + climate"],
  ];

  for (const [url, label] of cases) {
    assert.equal(cardLabel(url), label);
  }
});

test("status labels name the live pages without embedding telemetry", () => {
  const labels = [cardLabel("/status/"), cardLabel("/status/pipeline/")].join();
  assert.doesNotMatch(
    labels,
    /operational|degraded|down|failed|timestamp|generated_at|recent_inits/,
  );
});

test("link previews prefer a page's fact line while SEO keeps the prose", () => {
  const base = readFileSync(
    new URL("../_includes/base.njk", import.meta.url),
    "utf8",
  );
  // og:/twitter: descriptions are what an unfurl prints next to the card, so a
  // page with a terse socialDescription wins there; <meta name="description">
  // stays on the prose for search results.
  assert.match(
    base,
    /set ogDescription = socialDescription or description or metadata\.description/,
  );
  assert.match(base, /<meta name="description" content="\{\{ description or metadata\.description \}\}"/);

  for (const [source, field] of [
    ["catalog-pages.njk", "entry"],
    ["model-pages.njk", "model"],
  ]) {
    const template = readFileSync(
      new URL(`../content/${source}`, import.meta.url),
      "utf8",
    );
    assert.match(
      template,
      new RegExp(`socialDescription: '\\{\\{ ${field}\\.facts \\| join\\(" · "\\) \\}\\}'`),
    );
  }
});

test("the card carries no copy of its own beyond the brand and the page", () => {
  const card = readFileSync(new URL("../lib/og-card.js", import.meta.url), "utf8");
  // The card once padded itself out with an invented eyebrow, a numbered
  // "on this page" list, and a per-section call to action. Nothing on the card
  // should be text that does not come from the page it links to.
  assert.doesNotMatch(card, /on this page|open weather infrastructure/i);
  assert.doesNotMatch(card, /action/);
  assert.doesNotMatch(card, /items/);
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

test("a card leaves room for a full fact line on one line", () => {
  // A complete dataset fact line reaches 62 characters; the widest one we
  // publish must fit beside a thumbnail without wrapping.
  assert.ok(subtitleCharsPerLine(true) >= 62);
  assert.equal(subtitleCharsPerLine(true), 63);
  // Without a thumbnail the column is capped for readability, not by the panel.
  assert.equal(subtitleCharsPerLine(false), 66);
});

test("a fact line breaks between facts, never inside one", () => {
  const bound = bindWithinFacts(
    "Global · 27 variables · 0-240h: 0.25°, 246-840h: 0.5° · 0-840h (0-35 days) · every 24h",
  );

  // Separators stay breakable; every space inside a fact does not.
  assert.equal(bound.split(" ").length - 1, 8);
  assert.match(bound, /0-240h:\u00A00\.25°,\u00A0246-840h:\u00A00\.5°/);
  assert.match(bound, /every\u00A024h/);
  // Same characters, same length — only the spaces' breaking behavior changed.
  assert.equal(bound.length, 86);
  assert.equal(bound.replace(/\u00A0/g, " ").length, 86);

  // Prose needs its spaces breakable or it could not wrap at all.
  const prose = "Availability, incidents, and 90-day history for dynamical.org.";
  assert.equal(bindWithinFacts(prose), prose);
  assert.doesNotMatch(bindWithinFacts(prose), /\u00A0/);
});

test("the review contact sheet lists every card and flags the ones to look at", () => {
  const html = renderCardIndex([
    {
      slug: "catalog-noaa-gfs-forecast",
      title: "NOAA GFS forecast",
      subtitle: "Global · 25 variables · 0.25° · 0-384h (0-16 days) · every 6h",
      url: "https://dynamical.org/catalog/noaa-gfs-forecast/",
      label: "data catalog",
      hasArtwork: true,
    },
    {
      slug: "updates-2026-07-30",
      title: "OMGIMERG & \"friends\" <b>",
      subtitle: "NASA IMERG Early and Late precipitation analyses join the…",
      url: "https://dynamical.org/updates/2026-07-30/",
      label: "dispatch",
      hasArtwork: false,
    },
  ]);

  assert.match(html, /<img src="\/assets\/og\/catalog-noaa-gfs-forecast\.png"/);
  assert.match(html, /<a href="https:\/\/dynamical\.org\/updates\/2026-07-30\/"/);
  // Truncated prose is what a reviewer is hunting for; clean cards stay unmarked.
  assert.match(html, /<mark>truncated<\/mark>/);
  assert.equal(html.match(/<mark>/g).length, 1);
  assert.match(html, /1 flagged/);
  // Titles are page content, so they must not be able to inject markup.
  assert.match(html, /OMGIMERG &amp; &quot;friends&quot; &lt;b&gt;/);
  assert.doesNotMatch(html, /friends" <b>/);
  // Never indexable, wherever a preview build happens to publish it.
  assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
});

test("the review contact sheet is generated for previews but never for production", () => {
  const config = readFileSync(new URL("../.eleventy.js", import.meta.url), "utf8");
  assert.match(config, /if \(process\.env\.CF_PAGES_BRANCH !== "main"\) \{/);
  assert.match(config, /"dev", "cards", "index\.html"/);
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
      label: cardLabel("/catalog/"),
    }),
    renderCard({
      title: "Live system status",
      subtitle:
        "Availability, incidents, and history for dynamical.org services.",
      url: "https://dynamical.org/status/",
      label: cardLabel("/status/"),
    }),
    renderCard({
      title:
        "A very long validation report title that still needs to remain safely inside the social-card canvas at every supported preview size",
      subtitle:
        "Completeness, spatial, temporal, and availability checks for a published weather dataset.",
      url:
        "https://dynamical.org/catalog/noaa-gfs-forecast/validation/",
      label: cardLabel("/catalog/noaa-gfs-forecast/validation/"),
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
