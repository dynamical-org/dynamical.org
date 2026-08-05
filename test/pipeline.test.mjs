import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agencySummary,
  barTooltip,
  clockTime,
  detailRows,
  displaySource,
  etaLineText,
  initParts,
  validateDashboard,
} from "../public/pipeline.mjs";
import {
  agencyHealth,
  systemHealth,
} from "../public/status-health.mjs";
import { localZoneLabel } from "../public/status-time.mjs";

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

test("summarizes shared system and agency health", () => {
  assert.deepEqual(
    systemHealth({
      endpoints: [
        { status: "operational" },
        { status: "operational" },
      ],
    }),
    { state: "operational", label: "all systems", value: "operational" },
  );
  assert.deepEqual(
    systemHealth({
      endpoints: [{ status: "operational" }, { status: "down" }],
    }),
    { state: "down", label: "systems", value: "disrupted" },
  );
  assert.deepEqual(
    systemHealth({
      endpoints: [
        {
          status: "down",
          maintenance: { kind: "planned" },
        },
      ],
    }),
    {
      state: "advisory",
      label: "systems",
      value: "planned outage",
    },
  );
  assert.deepEqual(systemHealth({ endpoints: [{ status: "new-state" }] }), {
    state: "degraded",
    label: "some systems",
    value: "degraded",
  });
  assert.deepEqual(agencyHealth([]), {
    state: "nominal",
    label: "upstream forecast sources",
    value: "nominal",
  });
  assert.deepEqual(agencyHealth([{ agency: "noaa" }]), {
    state: "advisory",
    label: "upstream forecast sources",
    value: "NOAA advisory",
  });
});

test("formats init labels in UTC and the selected local timezone", () => {
  const timestamp = "2026-07-26T00:00:00Z";
  assert.deepEqual(initParts(timestamp), { date: "07-26", time: "00z" });
  assert.deepEqual(initParts(timestamp, "America/Chicago"), {
    date: "07-25",
    time: "19 CDT",
  });
});

test("shortens displayed web sources without changing other schemes", () => {
  assert.equal(displaySource("https://nomads.ncep.noaa.gov"), "nomads.ncep.noaa.gov");
  assert.equal(displaySource("http://example.com/data"), "example.com/data");
  assert.equal(displaySource("s3://noaa-gfs-bdp-pds"), "s3://noaa-gfs-bdp-pds");
});

test("preserves run and lead-group detail in bar tooltips", () => {
  assert.equal(
    barTooltip(
      {
        init_time: "2026-07-26T00:00:00Z",
        status: "in_flight",
        timing: "on_time",
        completion_pct: 0.5,
        latency_s: 3600,
        lead_groups: [
          {
            name: "1d",
            status: "complete",
            timing: "on_time",
            completion_pct: 1,
          },
          {
            name: "3d",
            status: "in_flight",
            timing: "delayed",
            completion_pct: 0.25,
          },
        ],
      },
      false,
    ),
    "07-26 00z · in_flight · on_time · 50% · latency 1h\n" +
      "1d complete · on_time · 3d in_flight · delayed 25%",
  );
});

test("shows exact and relative ETA in the selected timezone", () => {
  assert.equal(
    etaLineText(
      "2026-07-26T14:45:00Z",
      Date.parse("2026-07-26T13:00:00Z"),
      false,
    ),
    "ETA 14:45 (in 1h 45m)",
  );
  assert.equal(
    clockTime("2026-07-26T14:45:00Z", "America/Chicago"),
    "09:45",
  );
});

test("retains live horizon status, time, and duration in details", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T12:00:00Z",
        status: "in_flight",
        lead_groups: [
          { status: "complete", latency_s: 1800 },
          { status: "in_flight" },
        ],
      },
    ],
    lead_group_stats: [
      { label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 },
      { label: "3d", p50_s: 2400, p95_s: 3600, p99_s: 4800 },
    ],
  };
  assert.deepEqual(
    detailRows(product, Date.parse("2026-07-26T12:30:00Z"), false),
    {
      header: "07-26 12z",
      rows: [
        {
          label: "1d",
          status: "complete",
          time: "12:30",
          duration: "30m",
          p50: "20m",
          p95: "30m",
          p99: "40m",
        },
        {
          label: "3d",
          status: "processing",
          time: "ETA 13:00",
          duration: "30m 0s",
          p50: "40m",
          p95: "1h",
          p99: "1h 20m",
        },
      ],
    },
  );
});

test("shows the previous init details while waiting for the next init", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T06:00:00Z",
        status: "complete",
        lead_groups: [
          { status: "complete", latency_s: 1200 },
          { status: "complete", latency_s: 2700 },
        ],
      },
    ],
    lead_group_stats: [
      { label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 },
      { label: "3d", p50_s: 2400, p95_s: 3600, p99_s: 4800 },
    ],
  };

  const details = detailRows(
    product,
    Date.parse("2026-07-26T07:00:00Z"),
    false,
  );

  assert.equal(details.header, "07-26 06z · previous init");
  assert.deepEqual(
    details.rows.map(({ status, time, duration }) => ({
      status,
      time,
      duration,
    })),
    [
      { status: "complete", time: "06:20", duration: "20m" },
      { status: "complete", time: "06:45", duration: "45m" },
    ],
  );
});

test("status pages share the uptime, pipeline, and pipeline webhooks subnav", () => {
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

  assert.match(status, /from "status-subnav\.njk" import statusSubnav/);
  assert.match(status, /call statusSubnav\(statusSection, statusFeed, pipelineAssetsBase\)/);
  assert.match(status, /statusSection: uptime/);
  assert.match(status, /href="\/status\/pipeline\/"/);
  assert.doesNotMatch(status, /noindex: true|sitemap: false/);
  assert.match(pipeline, /from "status-subnav\.njk" import statusSubnav/);
  assert.match(pipeline, /call statusSubnav\(statusSection, statusFeed, pipelineAssetsBase\)/);
  assert.doesNotMatch(pipeline, /noindex: true|sitemap: false/);
  assert.match(subnav, /class="status-subnav-row"/);
  assert.match(subnav, /class="status-subnav" role="navigation" aria-label="Status"/);
  assert.doesNotMatch(subnav, /<nav class="status-subnav"/);
  assert.match(subnav, /\{\{ caller\(\) \}\}/);
  assert.match(subnav, />uptime</);
  assert.match(subnav, /pipeline/);
  assert.match(subnav, /https:\/\/status\.dynamical\.org\/webhooks/);
  assert.match(
    subnav,
    /href="https:\/\/status\.dynamical\.org\/webhooks" target="_blank" rel="noopener"/,
  );
  assert.match(subnav, />pipeline webhooks<\/a>/);
  assert.match(subnav, /data-slot="system-health"/);
  assert.match(subnav, /data-slot="agency-health"/);
  assert.match(subnav, /upstream forecast sources/);
  assert.doesNotMatch(subnav, /weather agencies/);
  assert.match(subnav, /statusSection == "pipeline"/);
  assert.match(subnav, /pipeline-history-toggle/);
  assert.doesNotMatch(subnav, /pipeline-controls-actions/);
  assert.match(status, /id="status-time-toggle"/);
  assert.match(pipeline, /id="status-time-toggle"/);
  assert.equal((base.match(/href="\/status\/"/g) ?? []).length, 2);
});

test("primary navigation styles the current section like the status subnav", () => {
  const base = readFileSync(
    new URL("../_includes/base.njk", import.meta.url),
    "utf8",
  );
  const mainCss = readFileSync(
    new URL("../public/main.css", import.meta.url),
    "utf8",
  );

  assert.match(base, /class="primary-nav"/);
  for (const section of ["catalog", "research", "updates", "about", "podcast", "status"]) {
    assert.match(base, new RegExp(`>${section}<`));
  }
  assert.equal((base.match(/aria-current="page"/g) ?? []).length, 6);
  assert.match(
    mainCss,
    /\.primary-nav \[aria-current="page"\],[\s\S]*\.status-subnav \[aria-current="page"\][\s\S]*font-weight: 700;[\s\S]*text-decoration: none;/,
  );
});

test("the shared time control shows only the browser's local zone", () => {
  const label = localZoneLabel(new Date("2026-07-26T12:00:00Z"));
  assert.ok(label.length > 0);
  assert.doesNotMatch(label, /local time/i);
});

test("either local status preview serves both fixture feeds", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["start:status", "start:pipeline"]) {
    assert.match(scripts[name], /STATUS_FIXTURE=1/);
    assert.match(scripts[name], /PIPELINE_FIXTURE=1/);
  }
});

test("pipeline page uses the shared subnav without a separate footer", () => {
  const template = readFileSync(
    new URL("../content/status-pipeline.njk", import.meta.url),
    "utf8",
  );
  const subnav = readFileSync(
    new URL("../_includes/status-subnav.njk", import.meta.url),
    "utf8",
  );
  const pipelineCss = readFileSync(
    new URL("../public/pipeline.css", import.meta.url),
    "utf8",
  );
  const pipelineScript = readFileSync(
    new URL("../public/pipeline.mjs", import.meta.url),
    "utf8",
  );
  const mainCss = readFileSync(
    new URL("../public/main.css", import.meta.url),
    "utf8",
  );

  assert.match(subnav, /https:\/\/status\.dynamical\.org\/webhooks/);
  assert.match(template, /forecast hours still expected/);
  assert.match(template, /no monitoring data/);
  assert.doesNotMatch(template, /pipeline-footer|window-days/);
  assert.doesNotMatch(pipelineScript, /window-days/);
  assert.match(template, /style="margin-top: 4rem;"/);
  assert.match(template, /status-page-updated[\s\S]*status-time-toggle/);
  assert.doesNotMatch(template, /Local time|Coordinated Universal Time/);
  assert.doesNotMatch(template, /Data product pipeline|Forecast-run arrival/);
  assert.match(
    pipelineCss,
    /\.pipeline-bar-segment\.g-pending,[\s\S]*\.pipeline-bar-segment\.g-unobserved\s*{\s*border: 1px dotted var\(--pipeline-unobserved\)/,
  );
  assert.match(
    pipelineCss,
    /\.pipeline-bar\[data-status="unobserved"\] \.pipeline-bar-track\s*{\s*border: 1px dotted/,
  );
  assert.doesNotMatch(
    mainCss,
    /\.status-subnav\s*{[^}]*font-size:/s,
  );
  assert.match(
    mainCss,
    /:where\(\.content\) :is\(ul, ol\):not\(\[class\]\) > li \+ li/,
  );
  assert.doesNotMatch(mainCss, /\.content \.status-health li \+ li/);
});

test("uptime uses light section headings without subtitles or rules", () => {
  const template = readFileSync(
    new URL("../content/status.njk", import.meta.url),
    "utf8",
  );
  const script = readFileSync(
    new URL("../public/status.mjs", import.meta.url),
    "utf8",
  );
  assert.match(template, />Core</);
  assert.match(template, /--index-row-border: 0/);
  assert.doesNotMatch(template, /class="status-(?:overall|groups)"/);
  assert.doesNotMatch(
    script,
    /All monitored public endpoints and tools are reporting normally\./,
  );
  assert.doesNotMatch(template, />Endpoints</);
  assert.doesNotMatch(template, /Data-serving and website/);
  assert.doesNotMatch(template, /Built on top of the data/);
  assert.doesNotMatch(template, /The data-serving path/);
  assert.doesNotMatch(template, /\.status-groups section > header/);
});
