// Replay of status/events.jsonl into the views /status renders.
//
// The log is the source of truth and everything here is a pure fold over it, so
// the page never has to reimplement the publisher's reduction — that half stays
// where transitions are detected. All this does is walk events in order.
//
// Nothing here reads the clock. Callers pass the effective as-of, because every
// open interval must end there rather than at `now`: a browser opened on Friday
// must not render three green days from a publisher that died on Tuesday.

const COVERAGE = "coverage";
const TRANSITION = "transition";
const PUBLIC_STATES = new Set(["operational", "down"]);
// At equal ts the order is: coverage entry, then transitions, then coverage exit.
// Entry first because a component must be observed before a state change of it
// means anything; exit last because a change recorded at the instant coverage
// ended was observed while coverage still held. Ordering the exit first would
// make an ordinary recovery-then-uncover sequence read as a transition with
// nobody watching. The publisher sorts by the same rule.
function kindRank(event) {
  if (event.kind !== COVERAGE) return 1;
  return event.monitored ? 0 : 2;
}
const DAY_MS = 86_400_000;

// An unrecognized state renders as unknown and never as operational. The
// publisher ships from a separate repo on its own deploy, so the day it adds a
// state this build has never heard of, the failure has to be visible rather than
// silently reassuring.
function publicState(state) {
  return PUBLIC_STATES.has(state) ? state : "unknown";
}

export function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // A truncated tail must not cost us the whole history.
    }
    // Skip unknown kinds rather than failing: additive annotative kinds are
    // meant to be safe for an old client, and a semantic addition bumps `v`.
    if (event?.kind !== COVERAGE && event?.kind !== TRANSITION) continue;
    if (typeof event.component !== "string") continue;
    if (!Number.isFinite(Date.parse(event.ts))) continue;
    events.push(event);
  }
  return events.sort(
    (a, b) =>
      Date.parse(a.ts) - Date.parse(b.ts) ||
      kindRank(a) - kindRank(b),
  );
}

// The log cannot say when it was last checked, only when something changed, so
// freshness comes from meta.json. Taking the max covers the CDN skew where a
// browser holds events newer than the meta it fetched alongside them.
export function effectiveAsOf(reconciledAt, events) {
  const times = [Date.parse(reconciledAt)].filter(Number.isFinite);
  for (const event of events) times.push(Date.parse(event.ts));
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * Per-component spans of observed state. Gaps between spans are periods nobody
 * was watching — deliberately absent rather than represented, since "no data"
 * is not a state a component can be in.
 */
export function componentSpans(events, { asOf }) {
  const ceiling = asOf.getTime();
  const spans = new Map();
  const open = new Map();

  const close = (component, end) => {
    const current = open.get(component);
    if (!current) return;
    open.delete(component);
    if (end <= current.start) return; // Zero-width spans render as nothing.
    spans.get(component).push({ ...current, end });
  };

  for (const event of events) {
    // Unreachable from the page, since effectiveAsOf takes the max over every
    // event. Kept anyway: "no interval extends past the as-of" is an invariant of
    // this function, not a property of one caller's arithmetic, and a caller
    // asking for an earlier as-of is the obvious next use.
    const at = Math.min(Date.parse(event.ts), ceiling);
    const { component } = event;
    if (!spans.has(component)) spans.set(component, []);

    if (event.kind === COVERAGE && event.monitored === false) {
      close(component, at);
      continue;
    }
    const state =
      event.kind === COVERAGE ? publicState(event.state) : publicState(event.to);
    const current = open.get(component);
    // A same-state re-assertion must not split an incident: the publisher may
    // legitimately re-declare coverage without anything having changed.
    if (current && current.state === state) continue;
    // A transition while uncovered violates a writer invariant, but the reader
    // stays tolerant — ignoring it is safer than inventing coverage for it.
    if (!current && event.kind === TRANSITION) continue;
    close(component, at);
    open.set(component, { start: at, state });
  }

  for (const component of [...open.keys()]) close(component, ceiling);
  for (const list of spans.values()) list.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * One cell per UTC day, from the first day the log has coverage for through the
 * as-of, capped at `days`.
 *
 * Starts at first coverage rather than at `asOf - days` on purpose: a 90-cell
 * strip that is 80 cells empty reads as broken rather than as young. The caller
 * labels the strip from `cells.length`, so the claim grows with the evidence
 * instead of being asserted up front.
 *
 * Precedence is down > no data > operational. Hiding a witnessed outage behind
 * "no data" is the wrong direction for this artifact.
 */
export function dailyBars(spans, { asOf, days }) {
  const result = new Map();
  const lastDay = Math.floor(asOf.getTime() / DAY_MS);
  const windowStart = lastDay - days + 1;

  for (const [component, list] of spans) {
    if (!list.length) {
      result.set(component, []);
      continue;
    }
    const firstDay = Math.max(windowStart, Math.floor(list[0].start / DAY_MS));
    const cells = [];
    for (let day = firstDay; day <= lastDay; day += 1) {
      const start = day * DAY_MS;
      // Both edges are partial days and both are clipped, symmetrically. The last
      // ends at the as-of, or the rest of today counts as unobserved; the first
      // begins at first coverage, or every strip opens on a permanent grey cell
      // just because monitoring started mid-day. Interior days are unaffected,
      // since their bounds already sit inside the covered span.
      const from = Math.max(start, list[0].start);
      const end = Math.min(start + DAY_MS, asOf.getTime());
      cells.push({
        date: new Date(start).toISOString().slice(0, 10),
        state: dayState(list, from, end),
      });
    }
    result.set(component, cells);
  }
  return result;
}

// Precedence: down > unknown > no data > operational.
//
// "unknown" outranking "no data" matters. A state this build does not recognize
// is something we were told and could not read, which is not the same as nobody
// watching — and rendering it as a coverage gap would let a state the publisher
// added hide behind "not monitored", the same direction the down-first rule
// exists to prevent.
function dayState(spans, start, end) {
  let operational = 0;
  let unknown = false;
  for (const span of spans) {
    const overlap = Math.min(span.end, end) - Math.max(span.start, start);
    if (overlap <= 0) continue;
    if (span.state === "down") return "down";
    if (span.state === "unknown") unknown = true;
    else operational += overlap;
  }
  if (unknown) return "unknown";
  return operational >= end - start ? "operational" : "nodata";
}
