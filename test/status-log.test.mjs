import assert from "node:assert/strict";
import test from "node:test";

import {
  componentSpans,
  currentState,
  dailyBars,
  effectiveAsOf,
  formatDuration,
  incidents,
  parseEvents,
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
  // Additive annotative kinds are meant to be safe for an old client; a semantic
  // addition is supposed to bump `v` instead.
  const events = parseEvents(
    jsonl(
      coverage("2026-07-20T00:00:00Z", C, true, "operational"),
      { ts: "2026-07-21T00:00:00Z", kind: "annotation", component: C, note: "hi" },
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
      closedBy: "asOf",
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
    spans.get(C).map((s) => [s.state, s.closedBy]),
    [["operational", "coverage"]],
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
  assert.equal(spans.get(C)[0].closedBy, "coverage");
});

test("events after the as-of are clamped rather than extending the window", () => {
  const spans = spansOf(
    coverage("2026-07-24T00:00:00Z", C, true, "operational"),
    transition("2026-07-26T00:00:00Z", C, "down"),
  );

  assert.equal(spans.get(C).at(-1).end, AS_OF.getTime());
});

// --- current state --------------------------------------------------------

test("current state excludes a component whose coverage ended", () => {
  // Reporting its last known state would claim knowledge we stopped having.
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    coverage("2026-07-24T00:00:00Z", C, false),
    coverage("2026-07-24T00:00:00Z", "stac-catalog", true, "down"),
  );

  const current = currentState(spans, { asOf: AS_OF });

  assert.equal(current.has(C), false);
  assert.equal(current.get("stac-catalog"), "down");
});

// --- bars -----------------------------------------------------------------

test("bars start at first coverage, not at the window edge", () => {
  // A 90-cell strip that is 80 cells empty reads as broken rather than as young.
  const spans = spansOf(coverage("2026-07-23T00:00:00Z", C, true, "operational"));

  const cells = dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.deepEqual(
    cells.map((c) => c.date),
    ["2026-07-23", "2026-07-24", "2026-07-25"],
  );
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
    dailyBars(spans, { asOf: AS_OF }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-23"), "operational");
  assert.equal(byDate.get("2026-07-24"), "down");
});

test("a partly uncovered day renders no data rather than operational", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    coverage("2026-07-24T06:00:00Z", C, false),
    coverage("2026-07-24T18:00:00Z", C, true, "operational"),
  );

  const byDate = new Map(
    dailyBars(spans, { asOf: AS_OF }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-24"), "nodata");
});

test("an unknown state does not count as operational coverage", () => {
  const spans = spansOf(coverage("2026-07-24T00:00:00Z", C, true, "maintenance"));

  const byDate = new Map(
    dailyBars(spans, { asOf: AS_OF }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-24"), "nodata");
});

test("today is judged against the as-of, not against midnight", () => {
  // Otherwise the remainder of the current day always counts as unobserved and
  // the newest cell is permanently "no data".
  const spans = spansOf(coverage("2026-07-25T00:00:00Z", C, true, "operational"));

  const cells = dailyBars(spans, { asOf: AS_OF }).get(C);

  assert.deepEqual(cells, [{ date: "2026-07-25", state: "operational" }]);
});

test("the window caps at the requested number of days", () => {
  const spans = spansOf(coverage("2026-01-01T00:00:00Z", C, true, "operational"));

  assert.equal(dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).length, 90);
});

// --- incidents ------------------------------------------------------------

test("a resolved outage reports its measured duration", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    transition("2026-07-24T10:00:00Z", C, "down"),
    transition("2026-07-24T12:30:00Z", C, "operational"),
  );

  assert.deepEqual(incidents(spans, { asOf: AS_OF }), [
    {
      component: C,
      start: new Date("2026-07-24T10:00:00Z"),
      end: new Date("2026-07-24T12:30:00Z"),
      durationMs: 9_000_000,
      ongoing: false,
      truncated: false,
    },
  ]);
});

test("an outage still open at the as-of is ongoing, not resolved", () => {
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    transition("2026-07-25T09:00:00Z", C, "down"),
  );

  const [incident] = incidents(spans, { asOf: AS_OF });

  assert.equal(incident.ongoing, true);
  assert.equal(incident.end.toISOString(), AS_OF.toISOString());
});

test("an outage cut short by its monitor going away is truncated", () => {
  // We know when we stopped watching, not when it recovered, so one real outage
  // spanning a coverage gap honestly surfaces as two incidents.
  const spans = spansOf(
    coverage("2026-07-23T00:00:00Z", C, true, "operational"),
    transition("2026-07-24T00:00:00Z", C, "down"),
    coverage("2026-07-24T06:00:00Z", C, false),
    coverage("2026-07-24T18:00:00Z", C, true, "down"),
    transition("2026-07-24T20:00:00Z", C, "operational"),
  );

  const found = incidents(spans, { asOf: AS_OF });

  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((i) => [i.start.toISOString(), i.truncated]),
    [
      ["2026-07-24T18:00:00.000Z", false],
      ["2026-07-24T00:00:00.000Z", true],
    ],
  );
});

test("incidents are newest first across components", () => {
  const spans = spansOf(
    coverage("2026-07-20T00:00:00Z", C, true, "operational"),
    coverage("2026-07-20T00:00:00Z", "stac-catalog", true, "operational"),
    transition("2026-07-21T00:00:00Z", C, "down"),
    transition("2026-07-21T01:00:00Z", C, "operational"),
    transition("2026-07-24T00:00:00Z", "stac-catalog", "down"),
    transition("2026-07-24T01:00:00Z", "stac-catalog", "operational"),
  );

  assert.deepEqual(
    incidents(spans, { asOf: AS_OF }).map((i) => i.component),
    ["stac-catalog", C],
  );
});

test("a healthy log has no incidents", () => {
  const spans = spansOf(coverage("2026-07-20T00:00:00Z", C, true, "operational"));

  assert.deepEqual(incidents(spans, { asOf: AS_OF }), []);
});

// --- formatting -----------------------------------------------------------

test("durations read plainly at every scale", () => {
  assert.equal(formatDuration(30_000), "1 min");
  assert.equal(formatDuration(9 * 60_000), "9 min");
  assert.equal(formatDuration(90 * 60_000), "1.5 hours");
  assert.equal(formatDuration(60 * 60_000), "1 hour");
  assert.equal(formatDuration(36 * 3_600_000), "1.5 days");
  assert.equal(formatDuration(24 * 3_600_000), "1 day");
});
