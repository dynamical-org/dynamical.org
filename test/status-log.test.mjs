import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  componentSpans,
  dailyBars,
  effectiveAsOf,
  incidentLog,
  parseEventLog,
  parseEvents,
  readRegionsView,
  readScopeView,
  uptimeSummary,
} from "../public/status-log.mjs";

const AS_OF = new Date("2026-07-25T12:00:00Z");
const C = "noaa-gfs-forecast";

const coverage = (ts, component, monitored, state) => ({
  ts,
  kind: "coverage",
  component,
  monitored,
  ...(state ? { state } : {}),
});
const transition = (ts, component, to) => ({
  ts,
  kind: "transition",
  component,
  to,
});
const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const spansOf = (...events) =>
  componentSpans(parseEvents(jsonl(...events)), { asOf: AS_OF });

// --- parsing --------------------------------------------------------------

test("skips unknown event kinds instead of failing", () => {
  const events = parseEvents(
    jsonl(
      coverage("2026-07-20T00:00:00Z", C, true, "operational"),
      { ts: "2026-07-21T00:00:00Z", kind: "future-metadata", component: C },
      transition("2026-07-22T00:00:00Z", C, "down"),
    ),
  );

  assert.deepEqual(
    events.map((e) => e.kind),
    ["coverage", "transition"],
  );
});

test("survives a truncated final line", () => {
  // R2 has no append, so a write interrupted mid-object must not cost the history.
  const text =
    JSON.stringify(coverage("2026-07-20T00:00:00Z", C, true, "operational")) +
    '\n{"ts":"2026-07-21T00:00:00Z","kind":"transi';

  assert.equal(parseEvents(text).length, 1);
});

test("sorts by timestamp, then coverage before transition", () => {
  const events = parseEvents(
    jsonl(
      transition("2026-07-20T00:00:00Z", C, "down"),
      coverage("2026-07-20T00:00:00Z", C, true, "operational"),
    ),
  );

  assert.deepEqual(
    events.map((e) => e.kind),
    ["coverage", "transition"],
  );
});

test("effective as-of covers CDN skew between the two artifacts", () => {
  const events = parseEvents(jsonl(coverage("2026-07-25T12:05:00Z", C, true, "down")));

  // A browser can hold events newer than the meta.json it fetched alongside.
  assert.deepEqual(
    effectiveAsOf("2026-07-25T12:00:00Z", events),
    new Date("2026-07-25T12:05:00Z"),
  );
  assert.deepEqual(effectiveAsOf("2026-07-25T12:00:00Z", []), AS_OF);
  assert.equal(effectiveAsOf("not-a-date", []), null);
});

// --- spans ----------------------------------------------------------------

test("an open span ends at the as-of, never at now", () => {
  // Otherwise a browser on Friday renders green days from a publisher that died
  // on Tuesday. This is the rule separating evidence from extrapolation.
  const spans = spansOf(coverage("2026-07-24T12:00:00Z", C, true, "operational"));

  assert.deepEqual(spans.get(C), [
    {
      start: Date.parse("2026-07-24T12:00:00Z"),
      end: AS_OF.getTime(),
      state: "operational",
    },
  ]);
});

test("a same-state coverage re-assertion does not split a span", () => {
  const spans = spansOf(
    coverage("2026-07-24T00:00:00Z", C, true, "down"),
    coverage("2026-07-24T06:00:00Z", C, true, "down"),
  );

  assert.equal(spans.get(C).length, 1);
  assert.equal(spans.get(C)[0].start, Date.parse("2026-07-24T00:00:00Z"));
});

test("a coverage exit closes the span and leaves a gap, not a state", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    coverage("2026-07-24T00:00:00Z", C, false),
  );

  assert.deepEqual(
    spans.get(C).map((span) => span.state),
    ["operational"],
  );
});

test("an unrecognized state becomes unknown, never operational", () => {
  const spans = spansOf(coverage("2026-07-24T00:00:00Z", C, true, "maintenance"));

  assert.equal(spans.get(C)[0].state, "unknown");
});

test("a transition while uncovered is ignored rather than inventing coverage", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    coverage("2026-07-24T00:00:00Z", C, false),
    transition("2026-07-24T06:00:00Z", C, "down"),
  );

  assert.equal(spans.get(C).length, 1);
});

test("events after the as-of are clamped rather than extending the window", () => {
  const spans = spansOf(
    coverage("2026-07-24T00:00:00Z", C, true, "operational"),
    transition("2026-07-26T00:00:00Z", C, "down"),
  );

  assert.equal(spans.get(C).at(-1).end, AS_OF.getTime());
});

test("incidents distinguish resolution from observation ending", () => {
  const events = parseEvents(
    jsonl(
      coverage("2026-07-24T00:00:00Z", C, true, "operational"),
      transition("2026-07-24T01:00:00Z", C, "down"),
      transition("2026-07-24T02:00:00Z", C, "operational"),
      transition("2026-07-24T03:00:00Z", C, "down"),
      coverage("2026-07-24T04:00:00Z", C, false),
      coverage("2026-07-24T05:00:00Z", C, true, "down"),
    ),
  );

  assert.deepEqual(
    incidentLog(events).map(({ start, end, ending }) => ({
      start,
      end,
      ending,
    })),
    [
      {
        start: Date.parse("2026-07-24T01:00:00Z"),
        end: Date.parse("2026-07-24T02:00:00Z"),
        ending: "resolved",
      },
      {
        start: Date.parse("2026-07-24T03:00:00Z"),
        end: Date.parse("2026-07-24T04:00:00Z"),
        ending: "observation-ended",
      },
      {
        start: Date.parse("2026-07-24T05:00:00Z"),
        end: null,
        ending: null,
      },
    ],
  );
});

// --- bars -----------------------------------------------------------------

test("bars always cover the full rolling window", () => {
  const spans = spansOf(coverage("2026-07-23T00:00:00Z", C, true, "operational"));

  const cells = dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.equal(cells.length, 90);
  assert.equal(cells[0].date, "2026-04-27");
  assert.equal(cells[0].state, "nodata");
  assert.deepEqual(cells.slice(-3).map((cell) => cell.state), [
    "operational",
    "operational",
    "operational",
  ]);
});

test("an entirely unobserved component gets 90 blank bars", () => {
  const cells = dailyBars(new Map([[C, []]]), {
    asOf: AS_OF,
    days: 90,
  }).get(C);

  assert.equal(cells.length, 90);
  assert.ok(cells.every((cell) => cell.state === "nodata"));
});

test("a day with any down interval renders down", () => {
  // Precedence is deliberate: hiding a witnessed outage behind "no data" is the
  // wrong direction for this artifact.
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    transition("2026-07-24T10:00:00Z", C, "down"),
    transition("2026-07-24T10:05:00Z", C, "operational"),
  );

  const byDate = new Map(
    dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-23"), "operational");
  assert.equal(byDate.get("2026-07-24"), "down");
  assert.deepEqual(
    dailyBars(spans, { asOf: AS_OF, days: 90 })
      .get(C)
      .find((cell) => cell.date === "2026-07-24").incidentIds,
    [`incident-${C}-${Date.parse("2026-07-24T10:00:00Z") / 1000}`],
  );
});

test("a partly observed day is filled while coverage records the gap", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    coverage("2026-07-24T06:00:00Z", C, false),
    coverage("2026-07-24T18:00:00Z", C, true, "operational"),
  );

  const byDate = new Map(
    dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-24"), "operational");
});

test("an unknown state outranks no data rather than hiding behind it", () => {
  // A state this build cannot read is something we were told; a coverage gap is
  // nobody watching. Rendering the former as the latter would let a state the
  // publisher added hide behind "not monitored".
  const spans = spansOf(coverage("2026-07-24T00:00:00Z", C, true, "maintenance"));

  const byDate = new Map(
    dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-24"), "unknown");
});

test("partial first coverage day is filled from observed status", () => {
  const spans = spansOf(coverage("2026-07-24T09:00:00Z", C, true, "operational"));
  const cells = dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.equal(cells.length, 90);
  assert.deepEqual(cells.slice(-2), [
    { date: "2026-07-24", state: "operational" },
    { date: "2026-07-25", state: "operational" },
  ]);
});

test("today is judged against the as-of, not against midnight", () => {
  // Otherwise the remainder of the current day always counts as unobserved and
  // the newest cell is permanently "no data".
  const spans = spansOf(coverage("2026-07-25T00:00:00Z", C, true, "operational"));

  const cells = dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.equal(cells.length, 90);
  assert.equal(cells.at(-2).state, "nodata");
  assert.deepEqual(cells.at(-1), {
    date: "2026-07-25",
    state: "operational",
  });
});

test("the window caps at the requested number of days", () => {
  const spans = spansOf(coverage("2026-01-01T00:00:00Z", C, true, "operational"));

  assert.equal(dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).length, 90);
});

// --- degraded ---------------------------------------------------------------

test("a degraded day outranks operational but never down", () => {
  const spans = spansOf(
    coverage("2026-07-22T00:00:00Z", C, true, "operational"),
    transition("2026-07-23T10:00:00Z", C, "degraded"),
    transition("2026-07-23T10:10:00Z", C, "operational"),
    transition("2026-07-24T10:00:00Z", C, "degraded"),
    transition("2026-07-24T11:00:00Z", C, "down"),
    transition("2026-07-24T12:00:00Z", C, "operational"),
  );

  const byDate = new Map(
    dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-22"), "operational");
  assert.equal(byDate.get("2026-07-23"), "degraded");
  assert.equal(byDate.get("2026-07-24"), "down");
});

test("a degraded day outranks unknown: a state we could read beats one we could not", () => {
  const spans = spansOf(
    coverage("2026-07-24T00:00:00Z", C, true, "maintenance"),
    transition("2026-07-24T12:00:00Z", C, "degraded"),
  );

  const byDate = new Map(
    dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-24"), "degraded");
});

test("a degraded cell links to no incident", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    transition("2026-07-24T10:00:00Z", C, "degraded"),
    transition("2026-07-24T10:10:00Z", C, "operational"),
  );

  const cell = dailyBars(spans, { asOf: AS_OF, days: 90 })
    .get(C)
    .find((c) => c.date === "2026-07-24");

  assert.equal(cell.state, "degraded");
  assert.equal(cell.incidentIds, undefined);
});

test("delays are first-class history entries beside outages", () => {
  // A delay is not an outage, but it is a story the history should tell. An
  // outage that decays to degraded is over — the lingering delay is its own
  // entry, so the record says both what broke and what lingered.
  const events = parseEvents(
    jsonl(
      coverage("2026-07-24T00:00:00Z", C, true, "operational"),
      transition("2026-07-24T01:00:00Z", C, "degraded"),
      transition("2026-07-24T02:00:00Z", C, "down"),
      transition("2026-07-24T03:00:00Z", C, "degraded"),
    ),
  );

  assert.deepEqual(
    incidentLog(events).map(({ kind, id, start, end, ending }) => ({
      kind,
      id,
      start,
      end,
      ending,
    })),
    [
      {
        kind: "delay",
        id: `delay-${C}-${Date.parse("2026-07-24T01:00:00Z") / 1000}`,
        start: Date.parse("2026-07-24T01:00:00Z"),
        end: Date.parse("2026-07-24T02:00:00Z"),
        ending: "resolved",
      },
      {
        kind: "outage",
        id: `incident-${C}-${Date.parse("2026-07-24T02:00:00Z") / 1000}`,
        start: Date.parse("2026-07-24T02:00:00Z"),
        end: Date.parse("2026-07-24T03:00:00Z"),
        ending: "resolved",
      },
      {
        kind: "delay",
        id: `delay-${C}-${Date.parse("2026-07-24T03:00:00Z") / 1000}`,
        start: Date.parse("2026-07-24T03:00:00Z"),
        end: null,
        ending: null,
      },
    ],
  );
});

test("a delay ends as observation-ended when coverage stops", () => {
  const events = parseEvents(
    jsonl(
      coverage("2026-07-24T00:00:00Z", C, true, "operational"),
      transition("2026-07-24T01:00:00Z", C, "degraded"),
      coverage("2026-07-24T02:00:00Z", C, false),
    ),
  );

  assert.deepEqual(
    incidentLog(events).map(({ kind, ending }) => ({ kind, ending })),
    [{ kind: "delay", ending: "observation-ended" }],
  );
});

test("a same-kind reassertion does not split a delay entry", () => {
  const events = parseEvents(
    jsonl(
      coverage("2026-07-24T00:00:00Z", C, true, "degraded"),
      coverage("2026-07-24T01:00:00Z", C, true, "degraded"),
    ),
  );

  assert.equal(incidentLog(events).length, 1);
});

test("degraded days link their delay entries the way down days link incidents", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    transition("2026-07-24T10:00:00Z", C, "degraded"),
    transition("2026-07-24T10:10:00Z", C, "operational"),
  );

  const cell = dailyBars(spans, { asOf: AS_OF, days: 90 })
    .get(C)
    .find((candidate) => candidate.date === "2026-07-24");

  assert.equal(cell.state, "degraded");
  assert.deepEqual(cell.delayIds, [
    `delay-${C}-${Date.parse("2026-07-24T10:00:00Z") / 1000}`,
  ]);
  assert.equal("incidentIds" in cell, false);
});

test("a down day links only its outages, not the day's delays", () => {
  // The worse story is the one the click should tell.
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    transition("2026-07-24T08:00:00Z", C, "degraded"),
    transition("2026-07-24T09:00:00Z", C, "down"),
    transition("2026-07-24T10:00:00Z", C, "operational"),
  );

  const cell = dailyBars(spans, { asOf: AS_OF, days: 90 })
    .get(C)
    .find((candidate) => candidate.date === "2026-07-24");

  assert.equal(cell.state, "down");
  assert.deepEqual(cell.incidentIds, [
    `incident-${C}-${Date.parse("2026-07-24T09:00:00Z") / 1000}`,
  ]);
  assert.equal("delayIds" in cell, false);
});

test("a witnessed delay never rounds itself invisible", () => {
  // 30 seconds of degraded time against months of coverage is below 0.001% —
  // flooring would present it as a flat 0 and uptimeDescription would omit it,
  // the mirror of the confirmed-downtime-never-shows-100% rule.
  const spans = spansOf(
    coverage("2026-04-27T00:00:00Z", C, true, "operational"),
    transition("2026-07-20T00:00:00Z", C, "degraded"),
    transition("2026-07-20T00:00:30Z", C, "operational"),
  );

  const measured = uptimeSummary(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.equal(measured.uptime, 100);
  assert.equal(measured.delayed, 0.001);
});

test("a component with no degraded time reports exactly zero delayed", () => {
  const spans = spansOf(coverage("2026-07-15T00:00:00Z", C, true, "operational"));

  assert.equal(uptimeSummary(spans, { asOf: AS_OF, days: 90 }).get(C).delayed, 0);
});

test("degraded time is monitored, leaves uptime alone, and shows as delayed", () => {
  const spans = spansOf(
    coverage("2026-07-15T00:00:00Z", C, true, "operational"),
    transition("2026-07-20T00:00:00Z", C, "degraded"),
    transition("2026-07-21T00:00:00Z", C, "operational"),
  );

  const measured = uptimeSummary(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.equal(measured.uptime, 100);
  // One degraded day out of ten and a half monitored.
  assert.ok(
    measured.delayed > 9 && measured.delayed < 10,
    `unexpected delayed ${measured.delayed}`,
  );
  // Degraded time stays in the denominator: it is not a coverage gap.
  assert.ok(
    measured.coverage > 11 && measured.coverage < 12,
    `unexpected coverage ${measured.coverage}`,
  );
});

// --- uptime -----------------------------------------------------------------

test("uptime is derived from the log, so it cannot contradict the bars", () => {
  // The percentage used to come from Sentry's check counts while the strip came
  // from the log, so a green number could sit above a red cell.
  const spans = spansOf(
    coverage("2026-07-15T00:00:00Z", C, true, "operational"),
    transition("2026-07-20T00:00:00Z", C, "down"),
    transition("2026-07-21T00:00:00Z", C, "operational"),
  );

  const { uptime, coverage: covered } = uptimeSummary(spans, {
    asOf: AS_OF,
    days: 90,
  }).get(C);
  const cells = dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C);

  // One day down out of ten and a half observed within the 90-day window.
  assert.ok(uptime > 90 && uptime < 91, `unexpected uptime ${uptime}`);
  assert.ok(covered > 11 && covered < 12, `unexpected coverage ${covered}`);
  assert.equal(cells.filter((cell) => cell.state === "down").length, 1);
});

test("uptime excludes time before the first displayed UTC day", () => {
  const spans = spansOf(
    coverage("2026-01-01T00:00:00Z", C, true, "operational"),
    transition("2026-04-26T18:00:00Z", C, "down"),
    transition("2026-04-27T00:00:00Z", C, "operational"),
  );

  const cells = dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C);
  const summary = uptimeSummary(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.equal(cells[0].date, "2026-04-27");
  assert.equal(cells.filter((cell) => cell.state === "down").length, 0);
  assert.equal(summary.uptime, 100);
});

test("confirmed downtime never presents as a flat 100%", () => {
  const spans = spansOf(
    coverage("2026-01-01T00:00:00Z", C, true, "operational"),
    transition("2026-07-25T11:59:59Z", C, "down"),
  );

  assert.equal(uptimeSummary(spans, { asOf: AS_OF, days: 90 }).get(C).uptime, 99.999);
});

test("a coverage gap lowers coverage rather than uptime", () => {
  // Uptime over monitored time would otherwise quietly shrink its own
  // denominator whenever nobody was watching.
  const spans = spansOf(
    coverage("2026-07-15T00:00:00Z", C, true, "operational"),
    coverage("2026-07-20T00:00:00Z", C, false),
    coverage("2026-07-25T00:00:00Z", C, true, "operational"),
  );

  const { uptime, coverage: covered } = uptimeSummary(spans, {
    asOf: AS_OF,
    days: 90,
  }).get(C);

  assert.equal(uptime, 100);
  assert.ok(covered > 6 && covered < 7, `unexpected coverage ${covered}`);
});

test("an unknown state is excluded from the denominator, not counted either way", () => {
  const spans = spansOf(
    coverage("2026-07-24T00:00:00Z", C, true, "operational"),
    transition("2026-07-25T00:00:00Z", C, "maintenance"),
  );

  const { uptime, coverage: covered } = uptimeSummary(spans, {
    asOf: AS_OF,
    days: 90,
  }).get(C);

  assert.equal(uptime, 100);
  assert.ok(covered < 100, "unknown time must show up as missing coverage");
});

test("an offset-less event timestamp is refused rather than shifted", () => {
  // Date.parse reads it as local time, which is what Python emits without tzinfo.
  const events = parseEvents(
    jsonl(
      { ts: "2026-07-20T00:00:00", kind: "coverage", component: C, monitored: true, state: "operational" },
      coverage("2026-07-21T00:00:00Z", C, true, "operational"),
    ),
  );

  assert.deepEqual(
    events.map((e) => e.ts),
    ["2026-07-21T00:00:00Z"],
  );
});

// --- read scope -----------------------------------------------------------

const READS = "data-product-reads";
const GOLDEN = JSON.parse(
  readFileSync(new URL("./fixtures/read_scope_golden.json", import.meta.url), "utf8"),
);

for (const golden of GOLDEN.cases) {
  test(`read scope golden: ${golden.name}`, () => {
    assert.deepEqual(readScopeView(golden.entry, golden.records), golden.expected);
  });
}

const scopeRecord = (overrides = {}) => ({
  ts: "2026-07-22T00:00:00Z",
  kind: "read_scope",
  component: READS,
  v: 1,
  as_of: "2026-07-22T00:05:00Z",
  final: false,
  ended_at: null,
  since: "a".repeat(64),
  through: "2026-07-21T23:59:00Z",
  scope: "partial",
  failed: [{ id: "noaa-gfs-forecast", name: "NOAA GFS forecast" }],
  unverified: [],
  latest: { at: "2026-07-21T23:59:00Z", passed: 35, failed: 1, unverified: 0 },
  full_witness: null,
  ...overrides,
});
const OPEN_ENTRY = { started_at: "2026-07-22T00:00:00Z", ended_at: null };

test("read scope records ride alongside the events without entering them", () => {
  const health = [
    coverage("2026-07-20T00:00:00Z", READS, true, "operational"),
    transition("2026-07-22T00:00:00Z", READS, "down"),
    transition("2026-07-23T00:00:00Z", READS, "operational"),
  ];
  const record = scopeRecord({ as_of: "2026-07-25T11:00:00Z" });
  const plain = parseEventLog(jsonl(...health));
  const withRecords = parseEventLog(jsonl(...health, record));

  assert.deepEqual(plain.readScopes, []);
  assert.deepEqual(withRecords.readScopes, [record]);
  assert.deepEqual(withRecords.events, plain.events);
  assert.equal(withRecords.recordCount, plain.recordCount + 1);
  const spans = (parsed) => componentSpans(parsed.events, { asOf: AS_OF });
  assert.deepEqual(spans(withRecords), spans(plain));
  assert.deepEqual(
    uptimeSummary(spans(withRecords), { asOf: AS_OF, days: 90 }),
    uptimeSummary(spans(plain), { asOf: AS_OF, days: 90 }),
  );
  assert.deepEqual(incidentLog(withRecords.events), incidentLog(plain.events));
});

test("read scope keeps only the records for this entry's onset", () => {
  const view = readScopeView(OPEN_ENTRY, [
    scopeRecord({ ts: "2026-07-22T00:00:00+00:00" }),
    scopeRecord({
      ts: "2026-07-21T00:00:00Z",
      as_of: "2026-07-22T00:06:00Z",
      failed: [{ id: "other", name: "Other" }],
    }),
    scopeRecord({ component: "stac-catalog", as_of: "2026-07-22T00:07:00Z" }),
  ]);

  assert.equal(view.name, "NOAA GFS forecast reads");
  assert.equal(view.label, "partial outage");
});

test("read scope refuses every malformed field rather than rendering it", () => {
  const malformed = [
    { v: 2 },
    { scope: "minor" },
    { as_of: "2026-07-22T00:05:00" },
    { through: "not a time" },
    // Strict like the publisher's reader: Date.parse would accept both.
    { through: "2026-07-21 23:59:00Z" },
    { through: "2026-07-21T23:59:60Z" },
    { through: "2026-07-21T23:59:00+24:00" },
    { as_of: "2026-07-22T00:05:00+0000" },
    { final: "false" },
    { ended_at: undefined },
    { since: "A".repeat(64) },
    { failed: [{ id: "noaa-gfs-forecast", name: "NOAA\nGFS" }] },
    { failed: [{ id: "noaa-gfs-forecast", name: "x".repeat(121) }] },
    { failed: [{ id: "noaa-gfs-forecast" }] },
    {
      failed: [
        { id: "noaa-gfs-forecast", name: "NOAA GFS forecast" },
        { id: "noaa-gfs-forecast", name: "NOAA GFS forecast" },
      ],
    },
    { unverified: [{ id: "noaa-gfs-forecast", name: "NOAA GFS forecast" }] },
    { latest: { at: "2026-07-21T23:59:00Z", passed: -1, failed: 1, unverified: 0 } },
    { latest: { at: "2026-07-21T23:59:00Z", passed: 1.5, failed: 1, unverified: 0 } },
    { full_witness: { at: "2026-07-21T23:59:00Z", selected: 0 } },
    { full_witness: { selected: 2 } },
  ];
  assert.notEqual(readScopeView(OPEN_ENTRY, [scopeRecord()]), null);
  for (const overrides of malformed) {
    assert.equal(
      readScopeView(OPEN_ENTRY, [scopeRecord(overrides)]),
      null,
      JSON.stringify(overrides),
    );
  }
});

test("a name of 120 code points is accepted even past 120 UTF-16 units", () => {
  const name = "🌀".repeat(120);
  const view = readScopeView(OPEN_ENTRY, [
    scopeRecord({ failed: [{ id: "noaa-gfs-forecast", name }] }),
  ]);
  assert.equal(view.name, `${name} reads`);
});

test("records tied on as-of and scope but differing in content render as today", () => {
  const view = readScopeView(OPEN_ENTRY, [
    scopeRecord(),
    scopeRecord({ failed: [{ id: "noaa-gfs-analysis", name: "NOAA GFS analysis" }] }),
  ]);
  assert.equal(view, null);
});

test("a partial scope with several failed datasets keeps the component name", () => {
  const view = readScopeView(OPEN_ENTRY, [
    scopeRecord({
      failed: [
        { id: "noaa-gfs-forecast", name: "NOAA GFS forecast" },
        { id: "noaa-gfs-analysis", name: "NOAA GFS analysis" },
      ],
    }),
  ]);
  assert.equal(view.name, "Data product reads");
  assert.equal(view.label, "partial outage");
});

// --- read regions ---------------------------------------------------------

const regionsRecord = (overrides = {}) => ({
  ts: "2026-07-22T00:00:00Z",
  kind: "read_regions",
  component: READS,
  v: 1,
  as_of: "2026-07-22T00:05:00Z",
  final: false,
  ended_at: null,
  since: "a".repeat(64),
  through: "2026-07-21T23:59:00Z",
  regions: {
    "us-east": { failed: true, not_verified: false, catalog_failed: false, unobserved: false },
    "us-west": { failed: false, not_verified: false, catalog_failed: false, unobserved: false },
    "eu-west": { failed: false, not_verified: false, catalog_failed: false, unobserved: false },
  },
  latest: {
    at: "2026-07-21T23:59:00Z",
    verdict: "degraded",
    status: { "us-east": "fail", "us-west": "pass", "eu-west": "pass" },
  },
  all_failed_at: null,
  ...overrides,
});
const OPEN_DEGRADED = { ...OPEN_ENTRY, state: "degraded" };

test("read regions records ride alongside the events without entering them", () => {
  const health = [
    coverage("2026-07-20T00:00:00Z", READS, true, "operational"),
    transition("2026-07-22T00:00:00Z", READS, "degraded"),
    transition("2026-07-23T00:00:00Z", READS, "operational"),
  ];
  const record = regionsRecord();
  const plain = parseEventLog(jsonl(...health));
  const withRecords = parseEventLog(jsonl(...health, record, { kind: "read_regions" }));

  assert.deepEqual(plain.readRegions, []);
  assert.deepEqual(withRecords.readRegions, [record, { kind: "read_regions" }]);
  assert.deepEqual(withRecords.readScopes, []);
  assert.deepEqual(withRecords.events, plain.events);
  assert.equal(withRecords.recordCount, plain.recordCount + 2);
  const spans = (parsed) => componentSpans(parsed.events, { asOf: AS_OF });
  assert.deepEqual(spans(withRecords), spans(plain));
  assert.deepEqual(
    uptimeSummary(spans(withRecords), { asOf: AS_OF, days: 90 }),
    uptimeSummary(spans(plain), { asOf: AS_OF, days: 90 }),
  );
  assert.deepEqual(incidentLog(withRecords.events), incidentLog(plain.events));
});

test("read regions name the failing regions from the page's own table", () => {
  const view = readRegionsView(OPEN_DEGRADED, [regionsRecord()]);
  assert.equal(view.label, "regional partial outage");
  assert.equal(view.where, "in US East");
  assert.equal(readRegionsView({ ...OPEN_ENTRY, state: "down" }, [regionsRecord()]).label, "outage");
});

test("read regions render only for down or degraded entries", () => {
  for (const state of [undefined, "operational", "unknown"]) {
    assert.equal(readRegionsView({ ...OPEN_ENTRY, state }, [regionsRecord()]), null);
  }
});

test("read regions keep only the records for this entry's onset", () => {
  const view = readRegionsView(OPEN_DEGRADED, [
    regionsRecord({ ts: "2026-07-22T00:00:00+00:00" }),
    regionsRecord({ ts: "2026-07-21T00:00:00Z", as_of: "2026-07-22T00:06:00Z" }),
    regionsRecord({ component: "stac-catalog", as_of: "2026-07-22T00:07:00Z" }),
    regionsRecord({ kind: "read_scope", as_of: "2026-07-22T00:08:00Z" }),
  ]);
  assert.equal(view.where, "in US East");
});

test("read regions refuse every malformed field rather than rendering it", () => {
  const record = regionsRecord();
  const flags = record.regions["us-east"];
  const malformed = [
    { v: 2 },
    { as_of: "2026-07-22T00:05:00" },
    { through: "2026-07-21T23:59:60Z" },
    { final: "false" },
    { ended_at: undefined },
    { since: "A".repeat(64) },
    { all_failed_at: "yesterday" },
    { regions: null },
    { regions: { ...record.regions, "ap-south": flags } },
    { regions: { "us-east": flags, "us-west": flags } },
    { regions: { ...record.regions, "us-east": { ...flags, failed: 1 } } },
    { regions: { ...record.regions, "us-east": { ...flags, extra: false } } },
    { regions: { ...record.regions, "us-east": { failed: true } } },
    { latest: { ...record.latest, at: "never" } },
    { latest: { ...record.latest, verdict: "ok" } },
    { latest: { ...record.latest, status: { ...record.latest.status, "us-east": "late" } } },
    { latest: { ...record.latest, status: { "us-east": "fail" } } },
  ];
  assert.notEqual(readRegionsView(OPEN_DEGRADED, [record]), null);
  for (const overrides of malformed) {
    assert.equal(
      readRegionsView(OPEN_DEGRADED, [regionsRecord(overrides)]),
      null,
      JSON.stringify(overrides),
    );
  }
});

test("one invalid record for an onset withholds all of them", () => {
  const view = readRegionsView(OPEN_DEGRADED, [
    regionsRecord(),
    regionsRecord({ as_of: "2026-07-22T00:01:00Z", v: 2 }),
  ]);
  assert.equal(view, null);
});

test("a closed entry reads only a final record for its own end", () => {
  const closed = { ...OPEN_DEGRADED, ended_at: "2026-07-22T01:00:00Z" };
  assert.equal(readRegionsView(closed, [regionsRecord()]), null);
  assert.equal(
    readRegionsView(closed, [
      regionsRecord({ final: true, ended_at: "2026-07-22T00:30:00Z" }),
    ]),
    null,
  );
  assert.notEqual(
    readRegionsView(closed, [
      regionsRecord({ final: true, ended_at: "2026-07-22T01:00:00Z" }),
    ]),
    null,
  );
});

test("records tied on as-of but differing in content render as today", () => {
  const record = regionsRecord();
  const view = readRegionsView(OPEN_DEGRADED, [
    record,
    regionsRecord({
      regions: {
        ...record.regions,
        "us-west": { ...record.regions["us-west"], failed: true },
      },
    }),
  ]);
  assert.equal(view, null);
});
