import assert from "node:assert/strict";
import test from "node:test";

import {
  componentSpans,
  dailyBars,
  effectiveAsOf,
  parseEvents,
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
    dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).map((c) => [c.date, c.state]),
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
    dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).map((c) => [c.date, c.state]),
  );

  assert.equal(byDate.get("2026-07-24"), "nodata");
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

test("the first day is clipped to first coverage, not judged against midnight", () => {
  // Otherwise every strip opens on a permanent grey cell purely because
  // monitoring began part-way through a day.
  const spans = spansOf(coverage("2026-07-24T09:00:00Z", C, true, "operational"));

  assert.deepEqual(dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C), [
    { date: "2026-07-24", state: "operational" },
    { date: "2026-07-25", state: "operational" },
  ]);
});

test("today is judged against the as-of, not against midnight", () => {
  // Otherwise the remainder of the current day always counts as unobserved and
  // the newest cell is permanently "no data".
  const spans = spansOf(coverage("2026-07-25T00:00:00Z", C, true, "operational"));

  const cells = dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C);

  assert.deepEqual(cells, [{ date: "2026-07-25", state: "operational" }]);
});

test("the window caps at the requested number of days", () => {
  const spans = spansOf(coverage("2026-01-01T00:00:00Z", C, true, "operational"));

  assert.equal(dailyBars(spans, { asOf: AS_OF, days: 90 }).get(C).length, 90);
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

  // One day down out of ten and a half observed.
  assert.ok(uptime > 90 && uptime < 91, `unexpected uptime ${uptime}`);
  assert.equal(covered, 100);
  assert.equal(cells.filter((cell) => cell.state === "down").length, 1);
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
  assert.ok(covered > 50 && covered < 60, `unexpected coverage ${covered}`);
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
