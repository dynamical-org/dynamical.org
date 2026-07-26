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

function utcDayWindowStart(asOf, days) {
  return (Math.floor(asOf.getTime() / DAY_MS) - days + 1) * DAY_MS;
}

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
    // A UTC offset is required. Date.parse treats an offset-less date-time as
    // *local*, which is exactly what Python's datetime.isoformat() emits without
    // tzinfo — so a naive timestamp would silently shift every derived interval
    // by the viewer's offset. The publisher refuses to write one; this end
    // verifies rather than trusts, since the repos deploy independently.
    if (typeof event.ts !== "string") continue;
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(event.ts)) continue;
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

export function incidentId(component, start) {
  return `incident-${component}-${Math.floor(start / 1000)}`;
}

export function incidentLog(events) {
  const coverage = new Map();
  const open = new Map();
  const result = [];

  const close = (component, end, ending) => {
    const current = open.get(component);
    open.delete(component);
    if (!current || end <= current.start) return;
    result.push({ ...current, end, ending });
  };

  for (const event of events) {
    const at = Date.parse(event.ts);
    const { component } = event;
    const current = coverage.get(component) ?? {
      monitored: false,
      state: null,
    };

    if (event.kind === COVERAGE && event.monitored === false) {
      if (current.monitored && current.state === "down") {
        close(component, at, "observation-ended");
      }
      coverage.set(component, { monitored: false, state: null });
      continue;
    }
    if (event.kind === TRANSITION && !current.monitored) continue;

    const state =
      event.kind === COVERAGE ? publicState(event.state) : publicState(event.to);
    if (current.monitored && current.state === "down" && state !== "down") {
      close(component, at, "resolved");
    }
    if ((!current.monitored || current.state !== "down") && state === "down") {
      open.set(component, {
        id: incidentId(component, at),
        component,
        start: at,
      });
    }
    coverage.set(component, { monitored: true, state });
  }

  for (const current of open.values()) {
    result.push({ ...current, end: null, ending: null });
  }
  return result.sort((a, b) => a.start - b.start);
}

/**
 * One cell per UTC day in the rolling window.
 *
 * Precedence is down > unknown > operational > no data. Any observation fills
 * the day; the separate coverage percentage carries partial-day completeness.
 */
export function dailyBars(spans, { asOf, days }) {
  const result = new Map();
  const lastDay = Math.floor(asOf.getTime() / DAY_MS);
  const windowStart = utcDayWindowStart(asOf, days) / DAY_MS;

  for (const [component, list] of spans) {
    const cells = [];
    for (let day = windowStart; day <= lastDay; day += 1) {
      const start = day * DAY_MS;
      const end = Math.min(start + DAY_MS, asOf.getTime());
      const state = dayState(list, start, end);
      const incidentIds =
        state === "down"
          ? list
              .filter(
                (span) =>
                  span.state === "down" &&
                  Math.min(span.end, end) - Math.max(span.start, start) > 0,
              )
              .map((span) => incidentId(component, span.start))
          : [];
      cells.push({
        date: new Date(start).toISOString().slice(0, 10),
        state,
        ...(incidentIds.length ? { incidentIds } : {}),
      });
    }
    result.set(component, cells);
  }
  return result;
}

// Precedence: down > unknown > operational > no data.
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
  return operational > 0 ? "operational" : "nodata";
}


/**
 * Uptime and coverage over the same window the bars cover.
 *
 * Derived from the log rather than from Sentry's check counts, so the percentage
 * and the strip beneath it cannot disagree — a green number over a red cell would
 * discredit both. It also means one methodology across every component, whether a
 * 60-second HTTP probe or a daily cron backs it.
 *
 * Truncated rather than rounded, so a window containing confirmed downtime can
 * never present as a flat 100%.
 *
 * `unknown` spans are excluded from the denominator rather than counted either
 * way: a state we could not read is no basis for a claim, the same as a coverage
 * gap. That makes them visible in `coverage` instead of silently averaged away.
 *
 * Uniform method is not uniform precision. A transition's onset is only as sharp
 * as its monitor's cadence, so a daily cron's figure is inherently coarser than an
 * HTTP detector's. That is a property of the measurement, not the arithmetic.
 */
export function uptimeSummary(spans, { asOf, days }) {
  const ceiling = asOf.getTime();
  const windowStart = utcDayWindowStart(asOf, days);
  const summary = new Map();

  for (const [component, list] of spans) {
    if (!list.length) continue;
    const from = windowStart;
    const elapsed = ceiling - from;
    if (elapsed <= 0) continue;

    let monitored = 0;
    let down = 0;
    for (const span of list) {
      if (span.state === "unknown") continue;
      const overlap = Math.min(span.end, ceiling) - Math.max(span.start, from);
      if (overlap <= 0) continue;
      monitored += overlap;
      if (span.state === "down") down += overlap;
    }
    if (monitored <= 0) continue;

    summary.set(component, {
      uptime: truncate((100 * (monitored - down)) / monitored),
      coverage: truncate((100 * monitored) / elapsed),
    });
  }
  return summary;
}

// Floor to three decimals. Flooring is what stops 99.9999 from presenting as 100.
function truncate(percent) {
  return Math.floor(percent * 1000) / 1000;
}
