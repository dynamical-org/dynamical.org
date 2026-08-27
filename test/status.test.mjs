import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyIncidentGroups,
  barDescription,
  buildHistory,
  incidentDescription,
  groupedIncidentDescription,
  isHistoryCurrent,
  isStatusDataStale,
  overlappingEntries,
  statusLabel,
  STALE_MESSAGE,
  summarizeOverallStatus,
  uptimeDescription,
  validateStatusData,
  withoutExperimentalComponents,
} from "../public/status.mjs";
import { systemHealth } from "../public/status-health.mjs";

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
      name: "status page",
      group: "tool",
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
  // Core resources followed by the reader-facing tools; datasets remain in the
  // feed even though the page does not render them yet.
  assert.deepEqual(
    fixture.endpoints.map((entry) => [entry.id, entry.group]),
    [
      ["stac-catalog", "endpoint"],
      ["data-product-reads", "endpoint"],
      ["scorecard", "tool"],
      ["wxopticon-arrivals", "tool"],
      ["wxopticon-webhooks", "tool"],
      ["dynamical-org", "tool"],
    ],
  );
  assert.deepEqual(summarizeOverallStatus(fixture), {
    status: "down",
    incidents: [{ name: "Data product reads", status: "down" }],
  });
});

test("keeps the experimental wxopticon components off the page", () => {
  // The publisher keeps measuring them; this page drops them until they are
  // stable enough to sit behind an uptime claim.
  const data = withoutExperimentalComponents(validateStatusData(fixture));
  assert.deepEqual(
    data.endpoints.map((entry) => entry.id),
    ["stac-catalog", "data-product-reads", "scorecard", "dynamical-org"],
  );
  // Dropping them from the component list is what hides their bars and their
  // incident-log entries; the rest of the document stays as published.
  assert.deepEqual(data.datasets, fixture.datasets);
  assert.deepEqual(data.component_aliases, fixture.component_aliases);
});

test("an experimental component's state does not move the rollup", () => {
  const feed = structuredClone(operationalData);
  feed.endpoints.push({
    id: "wxopticon-arrivals",
    name: "pipeline observability",
    group: "tool",
    status: "down",
  });
  const data = withoutExperimentalComponents(validateStatusData(feed));

  assert.deepEqual(summarizeOverallStatus(data), {
    status: "operational",
    incidents: [],
  });
  assert.deepEqual(systemHealth(data), {
    state: "operational",
    label: "all systems",
    value: "operational",
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
    incidents: [{ name: "status page", status: "down" }],
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

test("labels a planned down component without changing its health state", () => {
  const entry = {
    id: "wxopticon-pipeline",
    name: "pipeline detection",
    group: "tool",
    status: "down",
    maintenance: {
      kind: "planned",
      started_at: "2026-08-05T19:58:53Z",
      summary: "HRRR history migration",
    },
  };

  assert.equal(statusLabel(entry), "Planned outage");
  assert.deepEqual(
    summarizeOverallStatus({ ...operationalData, endpoints: [entry] }),
    {
      status: "down",
      incidents: [{ name: "pipeline detection", status: "down" }],
    },
  );
});

test("labels a degraded component as a live monitoring gap", () => {
  const entry = {
    id: "data-product-reads",
    name: "Data product reads",
    group: "endpoint",
    status: "degraded",
    observation: {
      kind: "observation",
      summary: "Sentry Cron Monitoring unavailable",
    },
  };

  assert.doesNotThrow(() =>
    validateStatusData({ ...operationalData, endpoints: [entry] }),
  );
  assert.equal(statusLabel(entry), "Monitoring gap");
  assert.deepEqual(
    summarizeOverallStatus({ ...operationalData, endpoints: [entry] }),
    {
      status: "degraded",
      incidents: [{ name: "Data product reads", status: "degraded" }],
    },
  );
});

test("rejects malformed live observation metadata", () => {
  const entry = {
    id: "data-product-reads",
    name: "Data product reads",
    group: "endpoint",
    status: "degraded",
    observation: { kind: "observation" },
  };

  assert.throws(
    () => validateStatusData({ ...operationalData, endpoints: [entry] }),
    /invalid status entry/i,
  );
});

test("groups explicitly related outages and remaps day links", () => {
  const detection = {
    id: "incident-wxopticon-pipeline-1785960026",
    component: "wxopticon-pipeline",
    kind: "outage",
    start: Date.parse("2026-08-05T20:00:26Z"),
    end: Date.parse("2026-08-05T21:20:15Z"),
    ending: "resolved",
  };
  const arrivals = {
    id: "incident-wxopticon-arrivals-1785960311",
    component: "wxopticon-arrivals",
    kind: "outage",
    start: Date.parse("2026-08-05T20:05:11Z"),
    end: Date.parse("2026-08-05T21:10:15Z"),
    ending: "resolved",
  };
  const webhooks = {
    id: "incident-wxopticon-webhooks-1785960311",
    component: "wxopticon-webhooks",
    kind: "outage",
    start: Date.parse("2026-08-05T20:05:11Z"),
    end: Date.parse("2026-08-05T21:40:11Z"),
    ending: "resolved",
  };
  const history = {
    asOf: new Date("2026-08-05T21:45:00Z"),
    incidents: [detection, arrivals, webhooks],
    cells: new Map([
      [
        "wxopticon-pipeline",
        [{ date: "2026-08-05", state: "down", incidentIds: [detection.id] }],
      ],
      [
        "wxopticon-arrivals",
        [{ date: "2026-08-05", state: "down", incidentIds: [arrivals.id] }],
      ],
      [
        "wxopticon-webhooks",
        [{ date: "2026-08-05", state: "down", incidentIds: [webhooks.id] }],
      ],
    ]),
  };
  const incidentGroups = [
    {
      id: "hrrr-history-migration",
      kind: "planned",
      summary: "HRRR history migration",
      started_at: "2026-08-05T19:58:53Z",
      ended_at: "2026-08-05T21:40:11Z",
      components: [
        "wxopticon-pipeline",
        "wxopticon-arrivals",
        "wxopticon-webhooks",
      ],
    },
  ];

  const grouped = applyIncidentGroups(history, incidentGroups);

  assert.deepEqual(grouped.incidents, [
    {
      id: "incident-group-hrrr-history-migration",
      kind: "planned",
      summary: "HRRR history migration",
      components: incidentGroups[0].components,
      memberIds: [detection.id, arrivals.id, webhooks.id],
      start: detection.start,
      end: webhooks.end,
      ending: "resolved",
    },
  ]);
  for (const cells of grouped.cells.values()) {
    assert.deepEqual(cells[0], {
      date: "2026-08-05",
      state: "down",
      displayState: "planned",
      incidentIds: ["incident-group-hrrr-history-migration"],
    });
  }
});

test("accepts and preserves an observation-gap explanation", () => {
  const description =
    "Our monitoring telemetry of data product reads was unavailable for 18 minutes. " +
    "We have no indication that data product reads themselves were impacted.";
  const group = {
    id: "data-product-read-telemetry-gap",
    kind: "observation",
    summary: "Data product read monitoring telemetry",
    description,
    started_at: "2026-08-19T23:45:15Z",
    ended_at: "2026-08-20T00:03:24Z",
    components: ["data-product-reads"],
  };
  const data = validateStatusData({
    ...operationalData,
    incident_groups: [group],
  });
  const incident = {
    id: "incident-data-product-reads-1",
    component: "data-product-reads",
    kind: "outage",
    start: Date.parse(group.started_at),
    end: Date.parse(group.ended_at),
    ending: "resolved",
  };

  const grouped = applyIncidentGroups(
    { incidents: [incident], cells: new Map() },
    data.incident_groups,
  );

  assert.equal(grouped.incidents[0].kind, "observation");
  assert.equal(grouped.incidents[0].description, description);
  assert.equal(
    groupedIncidentDescription(
      grouped.incidents[0],
      new Map([["data-product-reads", "Data product reads"]]),
      incident.end,
    ),
    description,
  );
});

test("explicit unplanned incident groups retain outage severity", () => {
  const incident = {
    id: "incident-api-1",
    component: "api",
    kind: "outage",
    start: Date.parse("2026-08-05T20:00:00Z"),
    end: Date.parse("2026-08-05T20:10:00Z"),
    ending: "resolved",
  };
  const grouped = applyIncidentGroups(
    {
      incidents: [incident],
      cells: new Map([
        ["api", [{ date: "2026-08-05", state: "down", incidentIds: [incident.id] }]],
      ]),
    },
    [
      {
        id: "api-deploy",
        kind: "outage",
        summary: "API deploy rollback",
        started_at: "2026-08-05T19:59:00Z",
        ended_at: "2026-08-05T20:10:00Z",
        components: ["api"],
      },
    ],
  );

  assert.equal(grouped.incidents[0].kind, "outage");
  assert.equal(grouped.cells.get("api")[0].displayState, undefined);
  assert.deepEqual(grouped.cells.get("api")[0].incidentIds, [
    "incident-group-api-deploy",
  ]);
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
    incidentDescription(tenMinutes, "pipeline observability"),
    "Pipeline observability updated late for 10 minutes.",
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

test("bar descriptions separate planned work from outages", () => {
  const description = barDescription([
    { state: "down", displayState: "planned" },
    { state: "down" },
  ]);
  assert.match(description, /1 of the last 2 days had an outage/i);
  assert.match(description, /1 day had a planned outage/i);
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
  assert.match(
    template,
    /\.status-list \[data-kind="planned"\][^}]*var\(--pill-degraded-bg\)/s,
  );
  assert.match(
    template,
    /\.status-bars \[data-day="planned"\][^}]*var\(--pill-degraded-bg\)/s,
  );
  assert.match(
    template,
    /\.status-incident\[data-kind="planned"\][^}]*var\(--pill-degraded-bg\)/s,
  );
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

test("observation groups render their days as a gap, not an outage", () => {
  const incident = {
    id: "incident-data-product-reads-1",
    component: "data-product-reads",
    kind: "outage",
    start: Date.parse("2026-08-19T23:45:15Z"),
    end: Date.parse("2026-08-20T00:03:24Z"),
    ending: "resolved",
  };
  const history = {
    incidents: [incident],
    cells: new Map([
      [
        "data-product-reads",
        [
          {
            date: "2026-08-19",
            state: "down",
            incidentIds: [incident.id],
          },
        ],
      ],
    ]),
  };

  const grouped = applyIncidentGroups(history, [
    {
      id: "data-product-read-telemetry-gap",
      kind: "observation",
      summary: "Data product read monitoring telemetry",
      description: "Telemetry was unavailable; reads were not confirmed down.",
      started_at: "2026-08-19T23:45:15Z",
      ended_at: "2026-08-20T00:03:24Z",
      components: ["data-product-reads"],
    },
  ]);

  assert.deepEqual(grouped.cells.get("data-product-reads")[0], {
    date: "2026-08-19",
    state: "down",
    displayState: "observation",
    incidentIds: ["incident-group-data-product-read-telemetry-gap"],
  });
});

test("corrected coverage gaps retain their explicit observation incident", () => {
  const history = {
    incidents: [],
    cells: new Map([
      [
        "data-product-reads",
        [{ date: "2026-08-27", state: "nodata" }],
      ],
    ]),
  };
  const configured = {
    id: "sentry-cron-gap-20260827-0955",
    kind: "observation",
    summary: "Data product read monitoring telemetry",
    description:
      "Sentry's US Cron Monitoring outage interrupted read-canary telemetry; " +
      "data product reads were not confirmed down.",
    started_at: "2026-08-27T09:55:11Z",
    ended_at: "2026-08-27T10:10:12Z",
    components: ["data-product-reads"],
  };

  const grouped = applyIncidentGroups(history, [configured]);

  assert.deepEqual(grouped.incidents, [
    {
      id: `incident-group-${configured.id}`,
      kind: "observation",
      summary: configured.summary,
      description: configured.description,
      components: configured.components,
      memberIds: [],
      start: Date.parse(configured.started_at),
      end: Date.parse(configured.ended_at),
      ending: "resolved",
    },
  ]);
  assert.deepEqual(grouped.cells.get("data-product-reads")[0], {
    date: "2026-08-27",
    state: "nodata",
    displayState: "observation",
    incidentIds: [`incident-group-${configured.id}`],
  });
});

test("partial-day corrected gaps override an otherwise operational day", () => {
  const component = "data-product-reads";
  const events = [
    {
      ts: "2026-08-27T00:00:00Z",
      kind: "coverage",
      component,
      monitored: true,
      state: "operational",
    },
    {
      ts: "2026-08-27T09:55:11Z",
      kind: "coverage",
      component,
      monitored: false,
    },
    {
      ts: "2026-08-27T10:10:12Z",
      kind: "coverage",
      component,
      monitored: true,
      state: "operational",
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  const history = buildHistory(
    events,
    JSON.stringify({
      v: 2,
      reconciled_at: "2026-08-27T12:00:00Z",
      events_count: 3,
    }),
  );
  const configured = {
    id: "sentry-cron-gap-20260827-0955",
    kind: "observation",
    summary: "Data product read monitoring telemetry",
    description:
      "Sentry's US Cron Monitoring outage interrupted read-canary telemetry; " +
      "data product reads were not confirmed down.",
    started_at: "2026-08-27T09:55:11Z",
    ended_at: "2026-08-27T10:10:12Z",
    components: [component],
  };

  const grouped = applyIncidentGroups(history, [configured]);
  const cell = grouped.cells
    .get(component)
    .find(({ date }) => date === "2026-08-27");

  assert.equal(cell.state, "operational");
  assert.equal(cell.displayState, "observation");
  assert.deepEqual(cell.incidentIds, [`incident-group-${configured.id}`]);
  assert.equal(grouped.incidents[0].id, `incident-group-${configured.id}`);
});

test("partial-day gaps do not soften known trouble elsewhere that day", () => {
  const component = "data-product-reads";
  const configured = {
    id: "sentry-cron-gap-20260827-0955",
    kind: "observation",
    summary: "Data product read monitoring telemetry",
    description: "Telemetry was unavailable; reads were not confirmed down.",
    started_at: "2026-08-27T09:55:11Z",
    ended_at: "2026-08-27T10:10:12Z",
    components: [component],
  };

  for (const state of ["degraded", "down"]) {
    const events = [
      {
        ts: "2026-08-27T00:00:00Z",
        kind: "coverage",
        component,
        monitored: true,
        state: "operational",
      },
      {
        ts: configured.started_at,
        kind: "coverage",
        component,
        monitored: false,
      },
      {
        ts: configured.ended_at,
        kind: "coverage",
        component,
        monitored: true,
        state: "operational",
      },
      {
        ts: "2026-08-27T11:00:00Z",
        kind: "transition",
        component,
        to: state,
      },
    ]
      .map(JSON.stringify)
      .join("\n");
    const history = buildHistory(
      events,
      JSON.stringify({
        v: 2,
        reconciled_at: "2026-08-27T12:00:00Z",
        events_count: 4,
      }),
    );

    const grouped = applyIncidentGroups(history, [configured]);
    const cell = grouped.cells
      .get(component)
      .find(({ date }) => date === "2026-08-27");

    assert.equal(cell.state, state);
    assert.equal(cell.displayState, undefined);
    assert.ok(
      grouped.incidents.some(
        ({ id }) => id === `incident-group-${configured.id}`,
      ),
    );
  }
});

test("bar descriptions separate monitoring gaps from outages", () => {
  const description = barDescription([
    { state: "down", displayState: "observation" },
    { state: "down" },
  ]);
  assert.match(description, /1 of the last 2 days had an outage/i);
  assert.match(description, /1 day had a monitoring gap/i);
});

test("monitoring-gap days render as dithered green, not red", () => {
  const template = readFileSync(
    new URL("../content/status.njk", import.meta.url),
    "utf8",
  );

  const rule = template.match(
    /\.status-bars \[data-day="observation"\]\s*{([^}]*)}/s,
  );
  assert.ok(rule, "expected a bar rule for observation days");
  assert.match(rule[1], /var\(--pill-available-bg\)/);
  assert.match(rule[1], /var\(--hatch-diagonal\)/);
  assert.doesNotMatch(rule[1], /--pill-down-bg/);
});

test("the hatch tile the status bars mark gaps with is a shared token", () => {
  const css = readFileSync(
    new URL("../public/main.css", import.meta.url),
    "utf8",
  );

  // One definition per theme, and the ink runs opposite to the shadow tiles:
  // the hatch erodes the cell toward the page background, so it lightens on a
  // light page and darkens on a dark one.
  assert.equal(css.match(/--hatch-diagonal:/g)?.length, 2);
  // One line per declaration; the data URI has semicolons of its own, so the
  // line is the boundary to cut on, not the statement terminator.
  const declaration = (block) =>
    block.slice(block.indexOf("--hatch-diagonal:")).split("\n")[0];
  const [light, dark] = css.split("prefers-color-scheme: dark");
  assert.match(declaration(light), /fill='white'/);
  assert.match(declaration(dark), /fill='black'/);
});
