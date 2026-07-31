import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  barDescription,
  blockTitle,
  buildHistory,
  daySeam,
  dayTitle,
  incidentDescription,
  isHistoryCurrent,
  isStatusDataStale,
  overlappingEntries,
  STALE_MESSAGE,
  summarizeOverallStatus,
  uptimeDescription,
  validateStatusData,
} from "../public/status.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/status.json", import.meta.url), "utf8"),
);

const operationalData = {
  generated_at: "2026-07-24T19:55:00Z",
  datasets: [
    {
      id: "noaa-gfs-forecast",
      name: "NOAA GFS forecast",
      status: "operational",
      last_successful_update: "2026-07-24T18:00:00Z",
    },
  ],
  endpoints: [
    {
      id: "dynamical-org",
      name: "dynamical.org website",
      group: "endpoint",
      status: "operational",
      uptime: 99.9,
      uptime_since: "2026-04-26T19:55:00Z",
    },
  ],
};

test("accepts the published feed shape", () => {
  // Returns a normalized copy, not the same reference, so compare by value.
  assert.deepEqual(validateStatusData(fixture), fixture);
  // 14, matching the collections in stac.dynamical.org/catalog.json — the
  // publisher deliberately excludes contrib datasets and source archivers.
  assert.equal(fixture.datasets.length, 14);
  // Five endpoints across the page's two sections, plus the 14 datasets the feed
  // still carries even though the page does not render them yet.
  assert.deepEqual(
    fixture.endpoints.map((entry) => [entry.id, entry.group]),
    [
      ["dynamical-org", "endpoint"],
      ["stac-catalog", "endpoint"],
      ["data-product-reads", "endpoint"],
      ["wxopticon", "tool"],
      ["scorecard", "tool"],
    ],
  );
  assert.deepEqual(summarizeOverallStatus(fixture), {
    status: "down",
    incidents: [{ name: "Data product reads", status: "down" }],
  });
});

test("summarizes an operational feed", () => {
  assert.deepEqual(summarizeOverallStatus(operationalData), {
    status: "operational",
    incidents: [],
  });
});

test("summarizes only the components this page renders", () => {
  const data = structuredClone(operationalData);
  data.datasets[0].status = "degraded";
  data.endpoints[0].status = "down";

  assert.deepEqual(summarizeOverallStatus(data), {
    status: "down",
    incidents: [{ name: "dynamical.org website", status: "down" }],
  });
});

test("marks status data stale after twenty minutes", () => {
  const generatedAt = "2026-07-24T19:40:00Z";

  assert.equal(
    isStatusDataStale(generatedAt, new Date("2026-07-24T20:00:00Z")),
    false,
  );
  assert.equal(
    isStatusDataStale(generatedAt, new Date("2026-07-24T20:00:00.001Z")),
    true,
  );
});

test("rejects a malformed envelope", () => {
  assert.throws(() => validateStatusData({}), /invalid status document/i);
  assert.throws(
    () => validateStatusData({ ...operationalData, generated_at: "nope" }),
    /invalid status document/i,
  );
  assert.throws(
    () => validateStatusData({ ...operationalData, datasets: [{ id: 1 }] }),
    /invalid status entry/i,
  );
  assert.throws(
    () =>
      validateStatusData({
        ...operationalData,
        generated_at: "2026-07-24T19:55:00",
      }),
    /invalid status document/i,
  );
});

test("refuses a contentless document instead of reporting all clear", () => {
  // The worst possible failure for a status page: a well-formed envelope with no
  // components rendering as "All systems operational" during an outage.
  assert.throws(
    () => validateStatusData({ ...operationalData, datasets: [], endpoints: [] }),
    /no components/i,
  );
  assert.throws(
    () => validateStatusData({ ...operationalData, endpoints: [] }),
    /no components/i,
  );
});

test("does not require the deferred dataset section", () => {
  assert.doesNotThrow(() =>
    validateStatusData({ ...operationalData, datasets: [] }),
  );
});

test("keeps rendering when a visible component has an unrecognized state", () => {
  // The publisher deploys from a separate repo; a fourth state must degrade one
  // row to Unknown, not black out the whole page.
  const data = structuredClone(operationalData);
  data.endpoints.push({
    id: "future-tool",
    name: "Future tool",
    group: "tool",
    status: "maintenance",
  });

  const validated = validateStatusData(data);

  assert.equal(validated.endpoints[1].status, "unknown");
  assert.deepEqual(summarizeOverallStatus(validated), {
    status: "degraded",
    incidents: [{ name: "Future tool", status: "unknown" }],
  });
});

test("rejects a mismatched event-log revision", () => {
  const events = `${JSON.stringify({
    ts: "2026-07-24T19:00:00Z",
    kind: "coverage",
    component: "dynamical-org",
    monitored: true,
    state: "operational",
  })}\n`;
  const meta = JSON.stringify({
    v: 1,
    reconciled_at: "2026-07-24T20:00:00Z",
    events_count: 2,
  });

  assert.throws(() => buildHistory(events, meta), /event-log revision/i);
});

test("revision count includes additive records old clients skip", () => {
  const events = [
    {
      ts: "2026-07-24T19:00:00Z",
      kind: "coverage",
      component: "dynamical-org",
      monitored: true,
      state: "operational",
    },
    {
      ts: "2026-07-24T19:30:00Z",
      kind: "future-metadata",
      component: "dynamical-org",
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  const meta = JSON.stringify({
    v: 1,
    reconciled_at: "2026-07-24T20:00:00Z",
    events_count: 2,
  });

  const history = buildHistory(events, meta);

  assert.equal(history.incidents.length, 0);
  assert.equal(history.uptime.has("dynamical-org"), true);
  assert.equal(history.asOf.toISOString(), "2026-07-24T20:00:00.000Z");
});

test("revision metadata rejects a truncated record", () => {
  const events =
    `${JSON.stringify({
      ts: "2026-07-24T19:00:00Z",
      kind: "coverage",
      component: "dynamical-org",
      monitored: true,
      state: "operational",
    })}\n` + '{"ts":"2026-07-24T19:30:00Z","kind":"transi';
  const meta = JSON.stringify({
    v: 1,
    reconciled_at: "2026-07-24T20:00:00Z",
    events_count: 2,
  });

  assert.throws(() => buildHistory(events, meta), /event-log revision/i);
});

test("accepts legacy history metadata during publisher rollout", () => {
  const events = `${JSON.stringify({
    ts: "2026-07-24T19:00:00Z",
    kind: "coverage",
    component: "dynamical-org",
    monitored: true,
    state: "operational",
  })}\n`;
  const history = buildHistory(
    events,
    JSON.stringify({ v: 1, reconciled_at: "2026-07-24T20:00:00Z" }),
  );

  assert.equal(history.asOf.toISOString(), "2026-07-24T20:00:00.000Z");
});

test("history must be close to the current snapshot", () => {
  assert.equal(
    isHistoryCurrent(
      new Date("2026-07-24T19:40:00Z"),
      "2026-07-24T20:00:00Z",
    ),
    true,
  );
  assert.equal(
    isHistoryCurrent(
      new Date("2026-07-24T19:39:59.999Z"),
      "2026-07-24T20:00:00Z",
    ),
    false,
  );
  assert.equal(
    isHistoryCurrent(
      new Date("2026-07-24T20:20:00.001Z"),
      "2026-07-24T20:00:00Z",
    ),
    false,
  );
});

test("incident descriptions say what the state did to the thing you use", () => {
  const tenMinutes = {
    component: "wxopticon-arrivals",
    kind: "delay",
    start: Date.parse("2026-07-29T17:10:00Z"),
    end: Date.parse("2026-07-29T17:20:00Z"),
  };
  assert.equal(
    incidentDescription(tenMinutes, "Arrivals dashboard"),
    "The pipeline status page updated late for 10 minutes.",
  );
  assert.equal(
    incidentDescription(
      { ...tenMinutes, component: "data-product-reads", kind: "outage" },
      "Data product reads",
    ),
    "Reads of dynamical.org data failed their canary checks for 10 minutes.",
  );
});

test("incident descriptions fall back to generic phrasing for unknown ids", () => {
  // The publisher deploys separately: a component this page has no impact
  // language for still reads as a sentence, not a blank.
  const entry = {
    component: "future-tool",
    kind: "outage",
    start: Date.parse("2026-07-29T17:10:00Z"),
    end: Date.parse("2026-07-29T17:12:00Z"),
  };
  assert.equal(
    incidentDescription(entry, "Future tool"),
    "Future tool was down for 2 minutes.",
  );
  assert.equal(
    incidentDescription({ ...entry, kind: "delay", end: null }, "Future tool"),
    "Future tool ran behind — ongoing.",
  );
  // Entries from a history built before kinds existed read as outages.
  assert.equal(
    incidentDescription({ ...entry, kind: undefined }, "Future tool"),
    "Future tool was down for 2 minutes.",
  );
});

test("overlap is claimed only for intervals that actually intersect", () => {
  const asOf = Date.parse("2026-07-29T21:00:00Z");
  const outage = {
    component: "noaa",
    kind: "outage",
    start: Date.parse("2026-07-29T13:00:00Z"),
    end: Date.parse("2026-07-29T16:00:00Z"),
  };
  const during = {
    component: "arrivals",
    kind: "delay",
    start: Date.parse("2026-07-29T14:00:00Z"),
    end: Date.parse("2026-07-29T14:10:00Z"),
  };
  const after = {
    component: "arrivals",
    kind: "delay",
    start: Date.parse("2026-07-29T17:00:00Z"),
    end: Date.parse("2026-07-29T17:10:00Z"),
  };
  const ongoing = {
    component: "scorecard",
    kind: "delay",
    start: Date.parse("2026-07-29T15:00:00Z"),
    end: null,
  };
  const entries = [outage, during, after, ongoing];

  assert.deepEqual(overlappingEntries(outage, entries, asOf), [during, ongoing]);
  assert.deepEqual(overlappingEntries(after, entries, asOf), [ongoing]);
  // Same-component entries never count as their own context, and an entry that
  // started later (the ongoing scorecard delay) is not context for one that
  // had already ended.
  assert.deepEqual(overlappingEntries(during, entries, asOf), [outage]);
});

test("week seams anchor at the right edge and the oldest two run wide", () => {
  const seams = Array.from({ length: 90 }, (_, index) => daySeam(index, 90));
  const seamIndices = seams
    .map((seam, index) => (seam ? index : null))
    .filter((index) => index !== null);

  // Twelve seams for 90 days; the newest day always closes a full week.
  assert.equal(seamIndices.length, 12);
  assert.deepEqual(seamIndices.slice(-2), [75, 82]);
  assert.equal(seams[89], null);
  assert.equal(seams[5], "status-day-seam");
});

test("block tooltips name the exact window a block represents", () => {
  const cell = {
    date: "2026-07-29",
    state: "degraded",
    segments: ["operational", "operational", "degraded", "degraded"],
  };
  // The date fragment follows the viewer's locale; the window and zone do not.
  assert.match(blockTitle(cell, 2, false), /12:00\u201318:00 UTC \u00b7 degraded$/);
  // The last block's range closes the day as 24:00, not a wrapped 00:00.
  assert.match(blockTitle(cell, 3, false), /18:00\u201324:00 UTC \u00b7 degraded$/);
  assert.match(
    blockTitle({ ...cell, segments: ["nodata", "operational", "operational", "operational"] }, 0, false),
    /00:00\u201306:00 UTC \u00b7 not monitored$/,
  );
  // A window that has not arrived yet is "upcoming", never "not monitored" —
  // the UTC grid opens today's cell mid-evening for viewers west of it.
  assert.match(
    blockTitle({ ...cell, date: "2099-01-01", segments: ["nodata", "nodata", "nodata", "nodata"] }, 2, false),
    /12:00\u201318:00 UTC \u00b7 upcoming$/,
  );
});

test("day tooltips name the affected windows, not just the worst state", () => {
  assert.equal(
    dayTitle({
      date: "2026-07-29",
      state: "down",
      segments: ["operational", "down", "degraded", "operational"],
    }),
    "2026-07-29: down 06:00–12:00Z, degraded 12:00–18:00Z",
  );
  assert.equal(
    dayTitle({ date: "2026-07-29", state: "nodata", segments: [] }),
    "2026-07-29: not monitored",
  );
  // A healthy day (or a cell from a build without segments) keeps the old form.
  assert.equal(
    dayTitle({ date: "2026-07-29", state: "operational" }),
    "2026-07-29: operational",
  );
});

test("bar descriptions distinguish unknown state from missing coverage", () => {
  assert.match(barDescription([{ state: "unknown" }]), /unknown state/i);
  assert.doesNotMatch(barDescription([{ state: "unknown" }]), /not monitored/i);
});

test("uptime description states the fixed window without a coverage suffix", () => {
  assert.equal(
    uptimeDescription({ uptime: 100, coverage: 1.5 }, 90),
    "100% uptime over the last 90 days",
  );
});

test("bar descriptions count degraded days apart from outages", () => {
  const description = barDescription([{ state: "degraded" }, { state: "down" }]);
  assert.match(description, /1 of the last 2 days had an outage/i);
  assert.match(description, /1 day degraded/i);
});

test("uptime description surfaces degraded time without calling it downtime", () => {
  assert.equal(
    uptimeDescription({ uptime: 100, coverage: 50, delayed: 0.007 }, 90),
    "100% uptime over the last 90 days (0.007% degraded)",
  );
  // A history object from before the delayed field existed must render as before.
  assert.equal(
    uptimeDescription({ uptime: 100, coverage: 50 }, 90),
    "100% uptime over the last 90 days",
  );
});

test("status page passes its timestamp into the shared subnav row", () => {
  const template = readFileSync(
    new URL("../content/status.njk", import.meta.url),
    "utf8",
  );
  const script = readFileSync(
    new URL("../public/status.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(template, />dynamical\.org status</);
  assert.match(template, /call statusSubnav\(statusSection, statusFeed, pipelineAssetsBase\)/);
  assert.match(template, /style="margin-top: 4rem;"/);
  assert.match(template, /data-slot="status-updated">As of —</);
  assert.doesNotMatch(template, /id="status-as-of"[^>]*><strong>/);
  assert.match(template, /status-page-updated[\s\S]*status-time-toggle/);
  assert.doesNotMatch(template, /Local time|Coordinated Universal Time/);
  assert.match(
    template,
    /\.status-bars > \*\s*{[^}]*border: 1px dotted/s,
  );
  assert.doesNotMatch(template, /\.status-bars \+ p/);
  assert.doesNotMatch(script, /textContent = "Today"|day.*ago/);
  assert.doesNotMatch(
    template,
    /Current health of dynamical\.org public endpoints, tools, and resources\./,
  );
  assert.equal(
    STALE_MESSAGE,
    "Stale: status page experiencing delayed updates",
  );
  assert.match(
    template,
    /#status-as-of\.status-stale\s*\{\s*color: var\(--pill-degraded-bg\)/,
  );
});
