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
      kindRank(a) - kindRank(b) ||
      a.component.localeCompare(b.component),
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
 *
 * `closedBy` records why a span ended, which is what lets an incident be
 * reported as resolved, truncated by a monitor going away, or still open.
 */
export function componentSpans(events, { asOf }) {
  const ceiling = asOf.getTime();
  const spans = new Map();
  const open = new Map();

  const close = (component, end, closedBy) => {
    const current = open.get(component);
    if (!current) return;
    open.delete(component);
    if (end <= current.start) return; // Zero-width spans render as nothing.
    spans.get(component).push({ ...current, end, closedBy });
  };

  for (const event of events) {
    const at = Math.min(Date.parse(event.ts), ceiling);
    const { component } = event;
    if (!spans.has(component)) spans.set(component, []);

    if (event.kind === COVERAGE && event.monitored === false) {
      close(component, at, "coverage");
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
    close(component, at, "transition");
    open.set(component, { start: at, state });
  }

  for (const component of [...open.keys()]) close(component, ceiling, "asOf");
  for (const list of spans.values()) list.sort((a, b) => a.start - b.start);
  return spans;
}

// Current status is the last span, and only if it reaches the as-of: a component
// whose coverage ended is excluded rather than reported at its last known state,
// which would be claiming knowledge we stopped having.
export function currentState(spans, { asOf }) {
  const current = new Map();
  for (const [component, list] of spans) {
    const last = list.at(-1);
    if (last && last.end >= asOf.getTime()) current.set(component, last.state);
  }
  return current;
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
export function dailyBars(spans, { asOf, days = 90 }) {
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
      // The final cell is a partial day, so it ends at the as-of rather than at
      // midnight — otherwise the rest of today counts as unobserved.
      const end = Math.min(start + DAY_MS, asOf.getTime());
      cells.push({
        date: new Date(start).toISOString().slice(0, 10),
        state: dayState(list, start, end),
      });
    }
    result.set(component, cells);
  }
  return result;
}

function dayState(spans, start, end) {
  let operational = 0;
  for (const span of spans) {
    const overlap = Math.min(span.end, end) - Math.max(span.start, start);
    if (overlap <= 0) continue;
    if (span.state === "down") return "down";
    if (span.state === "operational") operational += overlap;
  }
  return operational >= end - start ? "operational" : "nodata";
}

/**
 * Every `down` span, newest first.
 *
 * A span truncated by its monitor going away is reported as such rather than as
 * resolved: we know when we stopped watching, not when it recovered. One real
 * outage spanning a coverage gap therefore surfaces as two incidents, the first
 * truncated, which is honest about what was actually observed.
 */
export function incidents(spans, { asOf }) {
  const out = [];
  for (const [component, list] of spans) {
    for (const span of list) {
      if (span.state !== "down") continue;
      out.push({
        component,
        start: new Date(span.start),
        end: new Date(span.end),
        durationMs: span.end - span.start,
        ongoing: span.closedBy === "asOf" && span.end >= asOf.getTime(),
        truncated: span.closedBy === "coverage",
      });
    }
  }
  return out.sort((a, b) => b.start - a.start);
}

export function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 24) {
    const rounded = Math.round(hours * 10) / 10;
    return `${rounded} ${rounded === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} ${days === 1 ? "day" : "days"}`;
}
