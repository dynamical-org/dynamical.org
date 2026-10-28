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
const READ_SCOPE = "read_scope";
const READ_REGIONS = "read_regions";
const READ_SCOPE_COMPONENT = "data-product-reads";
const SCOPE_SEVERITY = { partial: 0, unknown: 1, full: 2 };
const COLLECTION_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Unicode category Cc, which is what the publisher refuses in a name.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const PUBLIC_STATES = new Set(["operational", "degraded", "down"]);
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

export function parseEventLog(text) {
  const events = [];
  const readScopes = [];
  const readRegions = [];
  let recordCount = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // A truncated tail must not cost us the whole history.
    }
    recordCount += 1;
    // Read-scope records annotate an outage; they never bear state, so they
    // stay out of the fold and are only read by readScopeView.
    if (event?.kind === READ_SCOPE) {
      readScopes.push(event);
      continue;
    }
    // Regional detail annotates the same entries the same way, and is only
    // read by readRegionsView.
    if (event?.kind === READ_REGIONS) {
      readRegions.push(event);
      continue;
    }
    // Skip unknown kinds so additive records remain safe for an old client.
    // A state-bearing semantic addition bumps `v`.
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
  events.sort(
    (a, b) =>
      Date.parse(a.ts) - Date.parse(b.ts) || kindRank(a) - kindRank(b),
  );
  return { events, recordCount, readScopes, readRegions };
}

export function parseEvents(text) {
  return parseEventLog(text).events;
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

export function delayId(component, start) {
  return `delay-${component}-${Math.floor(start / 1000)}`;
}

// Which history class a state opens: outages for down, delays for degraded.
// Operational and unknown open nothing and close whatever is open — a state
// we could not read cannot substantiate that trouble is continuing.
function historyKind(state) {
  if (state === "down") return "outage";
  if (state === "degraded") return "delay";
  return null;
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
      if (current.monitored && historyKind(current.state)) {
        close(component, at, "observation-ended");
      }
      coverage.set(component, { monitored: false, state: null });
      continue;
    }
    if (event.kind === TRANSITION && !current.monitored) continue;

    const state =
      event.kind === COVERAGE ? publicState(event.state) : publicState(event.to);
    const kind = historyKind(state);
    const openKind = current.monitored ? historyKind(current.state) : null;
    // An outage that decays to degraded is over — the delay that follows is
    // its own entry, so the record says both what broke and what lingered.
    if (openKind && openKind !== kind) close(component, at, "resolved");
    if (kind && openKind !== kind) {
      open.set(component, {
        id: (kind === "outage" ? incidentId : delayId)(component, at),
        kind,
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
 * Precedence is down > degraded > unknown > operational > no data. Any
 * observation fills the day; the separate coverage percentage carries
 * partial-day completeness.
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
      // Anchor ids for the day's history entries: outage links on down days,
      // delay links on degraded days. A down day links only its outages —
      // the worse story is the one the click should tell.
      const overlappingStarts = (spanState) =>
        list
          .filter(
            (span) =>
              span.state === spanState &&
              Math.min(span.end, end) - Math.max(span.start, start) > 0,
          )
          .map((span) => span.start);
      const incidentIds =
        state === "down"
          ? overlappingStarts("down").map((s) => incidentId(component, s))
          : [];
      const delayIds =
        state === "degraded"
          ? overlappingStarts("degraded").map((s) => delayId(component, s))
          : [];
      cells.push({
        date: new Date(start).toISOString().slice(0, 10),
        state,
        ...(incidentIds.length ? { incidentIds } : {}),
        ...(delayIds.length ? { delayIds } : {}),
      });
    }
    result.set(component, cells);
  }
  return result;
}

// Precedence: down > degraded > unknown > operational > no data.
//
// "unknown" outranking "no data" matters. A state this build does not recognize
// is something we were told and could not read, which is not the same as nobody
// watching — and rendering it as a coverage gap would let a state the publisher
// added hide behind "not monitored", the same direction the down-first rule
// exists to prevent. "degraded" outranks "unknown" because it is a state we
// were told and could read; a day that was both degraded and unreadable shows
// the stronger claim.
function dayState(spans, start, end) {
  let operational = 0;
  let degraded = false;
  let unknown = false;
  for (const span of spans) {
    const overlap = Math.min(span.end, end) - Math.max(span.start, start);
    if (overlap <= 0) continue;
    if (span.state === "down") return "down";
    if (span.state === "degraded") degraded = true;
    else if (span.state === "unknown") unknown = true;
    else operational += overlap;
  }
  if (degraded) return "degraded";
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
 * `degraded` spans count as monitored time that was *not* down — the component
 * was serving, late, or for data product reads failing in only some monitored
 * regions — so they leave `uptime` untouched. They surface as the separate
 * `delayed` percentage instead, which therefore includes delays and regional
 * partial outages, ceiled rather than floored so even a
 * sub-0.001% delay cannot round itself invisible: a chronically or briefly late
 * component must not hide behind a green 100%.
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
    let degraded = 0;
    for (const span of list) {
      if (span.state === "unknown") continue;
      const overlap = Math.min(span.end, ceiling) - Math.max(span.start, from);
      if (overlap <= 0) continue;
      monitored += overlap;
      if (span.state === "down") down += overlap;
      else if (span.state === "degraded") degraded += overlap;
    }
    if (monitored <= 0) continue;

    summary.set(component, {
      uptime: truncate((100 * (monitored - down)) / monitored),
      coverage: truncate((100 * monitored) / elapsed),
      delayed: inflate((100 * degraded) / monitored),
    });
  }
  return summary;
}

// Floor to three decimals. Flooring is what stops 99.9999 from presenting as 100.
function truncate(percent) {
  return Math.floor(percent * 1000) / 1000;
}

// Ceil to three decimals: the same rule pointed the other way. Degraded time is
// reported against ourselves, so a witnessed delay must never floor to a flat
// 0% — the mirror of confirmed downtime never presenting as 100% uptime.
function inflate(percent) {
  return Math.ceil(percent * 1000) / 1000;
}

// --- read scope ------------------------------------------------------------
//
// How much of a data-product-reads outage the read canary saw fail. The
// publisher writes these records beside the health events and the feed renders
// them with the same rules (the publisher's `read_scope_view`); the golden
// cases in test/fixtures/read_scope_golden.json hold both ends to one answer.
//
// Every doubt resolves to null, which renders the entry exactly as before: a
// plain "outage" of data product reads. Scope may only ever narrow what the
// page says when the record behind it is whole and unambiguous.

// The same strict shape the publisher accepts, so both ends read a record's
// timestamps identically: whole seconds, an explicit offset, and a real
// calendar date (Date.parse would roll February 30 into March).
const RECORD_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|([+-])(\d{2}):(\d{2}))$/;

function utcInstant(value) {
  if (typeof value !== "string") return null;
  const match = RECORD_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, sign, offH, offM] = match;
  const fields = [year, month, day, hour, minute, second].map(Number);
  // Date.UTC remaps years 0-99 into the 1900s; both readers accept 1970 on.
  if (fields[0] < 1970) return null;
  const local = Date.UTC(fields[0], fields[1] - 1, fields[2], ...fields.slice(3));
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== fields[0] ||
    check.getUTCMonth() !== fields[1] - 1 ||
    check.getUTCDate() !== fields[2] ||
    check.getUTCHours() !== fields[3] ||
    check.getUTCMinutes() !== fields[4] ||
    check.getUTCSeconds() !== fields[5] ||
    Number(offH ?? 0) > 23 ||
    Number(offM ?? 0) > 59
  ) {
    return null;
  }
  const offsetMinutes = sign
    ? (sign === "-" ? -1 : 1) * (Number(offH) * 60 + Number(offM))
    : 0;
  const instant = local - offsetMinutes * 60_000;
  // The same supported range once the offset is applied, as the publisher.
  const utcYear = new Date(instant).getUTCFullYear();
  return utcYear >= 1970 && utcYear <= 9999 ? instant : null;
}

// An entry's own instants come from the page's Date, with milliseconds.
function entryInstant(value) {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

// Exact in a JavaScript Number, as the publisher's reader also requires.
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCollectionList(list) {
  return (
    Array.isArray(list) &&
    list.every(
      (item) =>
        isPlainObject(item) &&
        typeof item.id === "string" &&
        COLLECTION_ID.test(item.id) &&
        typeof item.name === "string" &&
        [...item.name].length <= 120 &&
        !CONTROL_CHARACTER.test(item.name),
    )
  );
}

function isReadScopeRecord(record) {
  if (
    record.v !== 1 ||
    typeof record.scope !== "string" ||
    !Object.hasOwn(SCOPE_SEVERITY, record.scope) ||
    utcInstant(record.as_of) === null ||
    utcInstant(record.through) === null ||
    utcInstant(record.ts) === null ||
    typeof record.final !== "boolean" ||
    (record.ended_at !== null && utcInstant(record.ended_at) === null) ||
    typeof record.since !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.since) ||
    !isCollectionList(record.failed) ||
    !isCollectionList(record.unverified)
  ) {
    return false;
  }
  const ids = [...record.failed, ...record.unverified].map(({ id }) => id);
  if (new Set(ids).size !== ids.length) return false;
  const { latest, full_witness: witness } = record;
  if (
    latest !== null &&
    !(
      isPlainObject(latest) &&
      utcInstant(latest.at) !== null &&
      isCount(latest.passed) &&
      isCount(latest.failed) &&
      isCount(latest.unverified) &&
      Number.isSafeInteger(latest.passed + latest.failed)
    )
  ) {
    return false;
  }
  return (
    witness === null ||
    (isPlainObject(witness) &&
      utcInstant(witness.at) !== null &&
      isCount(witness.selected) &&
      witness.selected > 0)
  );
}

// Key-order-independent, so two records equal as JSON compare equal here.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// The publisher's utc_iso: whole seconds, Z.
function utcIso(value) {
  return `${new Date(utcInstant(value)).toISOString().slice(0, 19)}Z`;
}

/**
 * The scope view for one data-product-reads outage entry, or null to render it
 * as today. `entry` is `{started_at, ended_at}` as ISO strings (ended_at null
 * while open); `records` may hold any read-scope records from the log.
 */
export function readScopeView(entry, records) {
  const start = entryInstant(entry.started_at);
  if (start === null) return null;
  const forOnset = records.filter(
    (record) =>
      isPlainObject(record) &&
      record.kind === READ_SCOPE &&
      record.component === READ_SCOPE_COMPONENT &&
      utcInstant(record.ts) === start,
  );
  if (!forOnset.every(isReadScopeRecord)) return null;

  const end = entry.ended_at == null ? null : entryInstant(entry.ended_at);
  if (entry.ended_at != null && end === null) return null;
  const candidates =
    end === null
      ? forOnset
      : forOnset.filter(
          (record) => record.final && utcInstant(record.ended_at) === end,
        );
  if (!candidates.length) return null;
  const rank = (record) => [
    utcInstant(record.as_of),
    SCOPE_SEVERITY[record.scope],
  ];
  const best = candidates.reduce((a, b) => {
    const [aAt, aSeverity] = rank(a);
    const [bAt, bSeverity] = rank(b);
    return bAt > aAt || (bAt === aAt && bSeverity > aSeverity) ? b : a;
  });
  const [bestAt, bestSeverity] = rank(best);
  // At most one record per onset per poll, so a tie that disagrees is a fault.
  const tied = candidates.filter(
    (record) =>
      rank(record)[0] === bestAt && rank(record)[1] === bestSeverity,
  );
  if (new Set(tied.map(canonical)).size > 1) return null;

  const { scope, failed, unverified, latest, full_witness: witness } = best;
  if (scope === "unknown" && !failed.length && !unverified.length) return null;
  const names = (list) => list.map(({ name }) => name).join("; ");
  const sentences = [];
  if (end === null) sentences.push(`Scope as of ${utcIso(best.as_of)}.`);
  if (scope === "full" && witness) {
    sentences.push(
      `All ${witness.selected} checked collections failed at ${utcIso(witness.at)}.`,
    );
  }
  if (failed.length) {
    sentences.push(
      scope === "unknown"
        ? `Affected during this incident (scope unknown): ${names(failed)}.`
        : `Affected during this incident: ${names(failed)}.`,
    );
  }
  if (unverified.length) {
    sentences.push(`Readability could not be verified: ${names(unverified)}.`);
  }
  if (latest) {
    sentences.push(
      `Latest available detail (${utcIso(latest.at)}): ${latest.failed} of ${
        latest.passed + latest.failed
      } checked collections failed.`,
    );
  }
  return scope === "partial"
    ? {
        name:
          failed.length === 1 ? `${failed[0].name} reads` : "Data product reads",
        label: "partial outage",
        sentences,
      }
    : { name: "Data product reads", label: "outage", sentences };
}

// --- read regions ----------------------------------------------------------
//
// Which monitored regions a data-product-reads entry, down or degraded, failed
// in. The publisher writes these records beside the read-scope records and the
// feed renders them with the same rules (its `read_regions_view`); the golden
// cases in test/fixtures/read_regions_golden.json hold both ends to one answer.
//
// Every doubt resolves to null, as for read scope. A degraded entry without a
// readable record then renders as a delay, the way it always has.

// Display names come from this table, never from the record.
const READ_REGION_NAMES = new Map([
  ["us-east", "US East"],
  ["us-west", "US West"],
  ["eu-west", "Europe West"],
]);
const REGION_IDS = [...READ_REGION_NAMES.keys()];
const REGION_FLAGS = ["failed", "not_verified", "catalog_failed", "unobserved"];
const REGION_STATUSES = new Set(["pass", "fail", "unobserved"]);
// "ok" is never reported, so it never appears in a record.
const REPORTED_VERDICTS = new Set(["degraded", "down", "gap"]);
const REGIONS_RECORD_FIELDS = [
  "ts",
  "v",
  "as_of",
  "final",
  "ended_at",
  "since",
  "through",
  "regions",
  "latest",
  "all_failed_at",
];
// What the current status row says when no readable record names the regions.
export const READ_REGIONS_FALLBACK_WHERE = "in some monitored regions";

function hasExactKeys(value, keys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

// The publisher's regional_verdict, with only failures and gaps reading down.
function regionalVerdict(statuses) {
  const count = (value) => statuses.filter((status) => status === value).length;
  if (count("fail") === 0) return count("unobserved") === 0 ? "ok" : "gap";
  return count("pass") > 0 ? "degraded" : "down";
}

function regionFailing(flags) {
  return flags.failed || flags.not_verified || flags.catalog_failed;
}

function isReadRegionsRecord(record) {
  const { regions, latest, all_failed_at: witness } = record;
  if (
    !REGIONS_RECORD_FIELDS.every((field) => Object.hasOwn(record, field)) ||
    record.v !== 1 ||
    utcInstant(record.ts) === null ||
    utcInstant(record.as_of) === null ||
    utcInstant(record.through) === null ||
    typeof record.final !== "boolean" ||
    (record.ended_at !== null && utcInstant(record.ended_at) === null) ||
    typeof record.since !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.since) ||
    !hasExactKeys(regions, REGION_IDS) ||
    !REGION_IDS.every(
      (id) =>
        hasExactKeys(regions[id], REGION_FLAGS) &&
        REGION_FLAGS.every((flag) => typeof regions[id][flag] === "boolean"),
    )
  ) {
    return false;
  }
  if (latest !== null) {
    const statuses = isPlainObject(latest) ? latest.status : null;
    if (
      !hasExactKeys(statuses, REGION_IDS) ||
      utcInstant(latest.at) === null ||
      !REGION_IDS.every((id) => REGION_STATUSES.has(statuses[id])) ||
      !REPORTED_VERDICTS.has(latest.verdict) ||
      latest.verdict !== regionalVerdict(REGION_IDS.map((id) => statuses[id]))
    ) {
      return false;
    }
    // The latest run is one of the entry's runs, so its results are in the
    // accumulated flags.
    for (const id of REGION_IDS) {
      if (statuses[id] === "fail" && !regionFailing(regions[id])) return false;
      if (statuses[id] === "unobserved" && !regions[id].unobserved) return false;
    }
  }
  return (
    witness === null ||
    (utcInstant(witness) !== null &&
      REGION_IDS.every((id) => regionFailing(regions[id])))
  );
}

function regionList(ids) {
  const names = ids.map((id) => READ_REGION_NAMES.get(id));
  if (names.length < 3) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * The regional view for one data-product-reads entry, or null to render it as
 * today. `entry` is `{started_at, ended_at, state}` with `state` "down" or
 * "degraded"; `records` may hold any read-regions records from the log.
 */
export function readRegionsView(entry, records) {
  if (entry.state !== "down" && entry.state !== "degraded") return null;
  const start = entryInstant(entry.started_at);
  if (start === null) return null;
  const forOnset = records.filter(
    (record) =>
      isPlainObject(record) &&
      record.kind === READ_REGIONS &&
      record.component === READ_SCOPE_COMPONENT &&
      utcInstant(record.ts) === start,
  );
  if (!forOnset.every(isReadRegionsRecord)) return null;

  const end = entry.ended_at == null ? null : entryInstant(entry.ended_at);
  if (entry.ended_at != null && end === null) return null;
  const candidates =
    end === null
      ? forOnset
      : forOnset.filter(
          (record) => record.final && utcInstant(record.ended_at) === end,
        );
  if (!candidates.length) return null;
  const newest = Math.max(...candidates.map((record) => utcInstant(record.as_of)));
  const tied = candidates.filter((record) => utcInstant(record.as_of) === newest);
  // At most one record per onset per poll, so a tie that disagrees is a fault.
  if (new Set(tied.map(canonical)).size > 1) return null;
  const { regions, latest, all_failed_at: witness, as_of: asOf } = tied[0];

  const flagged = Object.fromEntries(
    REGION_FLAGS.map((flag) => [flag, REGION_IDS.filter((id) => regions[id][flag])]),
  );
  if (latest === null && !REGION_FLAGS.some((flag) => flagged[flag].length)) {
    return null;
  }
  const withStatus = (value) =>
    REGION_IDS.filter((id) => latest.status[id] === value);
  let failing = REGION_IDS.filter((id) => regionFailing(regions[id]));
  // The latest run says where reads are failing now, when it saw any fail.
  if (latest !== null && withStatus("fail").length) failing = withStatus("fail");
  const where =
    witness !== null
      ? "in every monitored region"
      : failing.length
        ? `in ${regionList(failing)}`
        : READ_REGIONS_FALLBACK_WHERE;

  const sentences = [];
  if (end === null) sentences.push(`Regional detail as of ${utcIso(asOf)}.`);
  // Only a same-run witness supports "every monitored region".
  if (witness !== null) {
    sentences.push(`Reads failed in every monitored region at ${utcIso(witness)}.`);
  } else if (flagged.failed.length) {
    sentences.push(`Reads failed in ${regionList(flagged.failed)}.`);
  }
  if (flagged.catalog_failed.length) {
    sentences.push(
      `The STAC catalog could not be loaded in ${regionList(flagged.catalog_failed)}.`,
    );
  }
  if (flagged.not_verified.length) {
    sentences.push(
      `Some reads could not be verified in ${regionList(flagged.not_verified)}.`,
    );
  }
  if (flagged.unobserved.length) {
    sentences.push(`${regionList(flagged.unobserved)} could not be checked.`);
  }
  if (latest !== null) {
    const parts = [
      ["failed in", "fail"],
      ["passed in", "pass"],
      ["could not be checked in", "unobserved"],
    ]
      .filter(([, value]) => withStatus(value).length)
      .map(([phrase, value]) => `${phrase} ${regionList(withStatus(value))}`);
    sentences.push(
      `Latest regional detail (${utcIso(latest.at)}): ${parts.join("; ")}.`,
    );
  }
  return {
    name: "Data product reads",
    label: entry.state === "degraded" ? "regional partial outage" : "outage",
    where,
    sentences,
  };
}
