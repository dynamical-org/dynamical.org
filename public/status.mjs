import {
  componentSpans,
  dailyBars,
  effectiveAsOf,
  parseEvents,
  uptimeSummary,
} from "./status-log.mjs";

const PUBLIC_STATUSES = new Set(["operational", "degraded", "down"]);
const STALE_AFTER_MS = 20 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BAR_DAYS = 90;

function isStatusEntry(entry) {
  return (
    entry && typeof entry.id === "string" && typeof entry.name === "string"
  );
}

// An unrecognized state is never treated as healthy. The publisher ships from a
// separate repo on its own deploy, so the day it adds a fourth state this page
// must keep working — showing that one row as unknown, not blacking out the
// other sixteen that are fine.
function normalizeEntry(entry) {
  return PUBLIC_STATUSES.has(entry.status)
    ? entry
    : { ...entry, status: "unknown" };
}

export function validateStatusData(data) {
  if (
    !data ||
    typeof data.generated_at !== "string" ||
    !Number.isFinite(Date.parse(data.generated_at)) ||
    !Array.isArray(data.datasets) ||
    !Array.isArray(data.endpoints)
  ) {
    throw new TypeError("Invalid status document");
  }
  // A contentless-but-well-formed document must not read as "all clear". If the
  // publisher's enumeration comes back empty during an outage, that is the one
  // direction this page must never fail in.
  if (data.datasets.length === 0 || data.endpoints.length === 0) {
    throw new TypeError("Invalid status document: no components");
  }
  if (![...data.datasets, ...data.endpoints].every(isStatusEntry)) {
    throw new TypeError("Invalid status entry");
  }
  return {
    ...data,
    datasets: data.datasets.map(normalizeEntry),
    endpoints: data.endpoints.map(normalizeEntry),
  };
}

export function isStatusDataStale(generatedAt, now = new Date()) {
  const age = now.getTime() - Date.parse(generatedAt);
  return !Number.isFinite(age) || age > STALE_AFTER_MS;
}

export function summarizeOverallStatus(data) {
  const incidents = [...data.datasets, ...data.endpoints]
    .filter((entry) => entry.status !== "operational")
    .map(({ name, status }) => ({ name, status }));
  const statuses = new Set(incidents.map(({ status }) => status));
  // "unknown" counts as not-operational so the headline can never claim all
  // clear while a component's state is unreadable.
  const status = statuses.has("down")
    ? "down"
    : statuses.has("degraded") || statuses.has("unknown")
      ? "degraded"
      : "operational";
  return { status, incidents };
}

function statusLabel(status) {
  return {
    operational: "Operational",
    degraded: "Degraded",
    down: "Down",
    unknown: "Unknown",
  }[status];
}

function formatTimestamp(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function statusMark(status) {
  return { operational: "●", degraded: "▲", down: "×", unknown: "?" }[status];
}

function renderGroup(list, entries, bars, uptime) {
  list.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("li");
    const header = document.createElement("header");
    const name = document.createElement("h3");
    const state = document.createElement("span");
    // The glyph duplicates the adjacent label, so keep it out of the
    // accessibility tree instead of announcing "black circle Operational".
    const mark = document.createElement("span");

    item.dataset.status = entry.status;
    name.textContent = entry.name;
    state.className = "status-label";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = statusMark(entry.status);
    state.append(mark, ` ${statusLabel(entry.status)}`);
    header.append(name, state);
    item.append(header);

    const cells = bars?.get(entry.id);
    const measured = uptime?.get(entry.id);
    // The figure and the strip describe the same window by construction: the day
    // count comes from the cells the strip renders, not from a separate field
    // that could drift out of step with them.
    if (cells?.length && measured) {
      const days = cells.length;
      const detail = document.createElement("p");
      detail.textContent =
        `${measured.uptime}% uptime over the last ${days} ` +
        `${days === 1 ? "day" : "days"}` +
        // Only when it is not the whole window: a percentage over monitored time
        // otherwise shrinks its own denominator without saying so.
        (measured.coverage < 100 ? `, ${measured.coverage}% monitored` : "");
      item.append(detail);
    }
    if (cells?.length) item.append(barStrip(cells));
    list.append(item);
  }
}

// A flex row of one cell per UTC day. Labelled from cells.length rather than a
// hardcoded 90 so the claim grows with the evidence: a strip captioned "90 days"
// that is mostly empty reads as broken rather than as young.
function barStrip(cells) {
  const strip = document.createElement("div");
  strip.className = "status-bars";
  const down = cells.filter((cell) => cell.state === "down").length;
  const uncovered = cells.filter((cell) => cell.state !== "operational").length - down;
  const days = cells.length;
  const plural = (n) => (n === 1 ? "day" : "days");
  // role="img" is required, not decorative: ARIA forbids naming a role-less
  // element, and a nameless generic is exactly what some screen readers drop —
  // which would leave this strip announcing nothing, since every cell is
  // aria-hidden and the per-cell title is pointer-only.
  strip.setAttribute("role", "img");
  // The label has to carry coverage as well as outages. A sighted reader sees the
  // grey cells; describing only outages would tell a screen reader the record is
  // clean while four days of it are missing.
  const parts = [
    down === 0
      ? `No outages recorded in the last ${days} ${plural(days)}`
      : `${down} of the last ${days} ${plural(days)} had an outage`,
  ];
  if (uncovered > 0) {
    parts.push(`${uncovered} ${plural(uncovered)} not monitored`);
  }
  strip.setAttribute("aria-label", parts.join("; "));
  for (const cell of cells) {
    const day = document.createElement("span");
    day.dataset.day = cell.state;
    // The bars are decorative in aggregate; the aria-label above carries the
    // meaning, so individual cells stay out of the accessibility tree.
    day.setAttribute("aria-hidden", "true");
    day.title = `${cell.date}: ${cell.state === "nodata" ? "not monitored" : cell.state}`;
    strip.append(day);
  }
  const scale = document.createElement("p");
  const first = document.createElement("span");
  first.textContent = `${days} day${days === 1 ? "" : "s"} ago`;
  const last = document.createElement("span");
  last.textContent = "Today";
  scale.append(first, last);
  const wrapper = document.createDocumentFragment();
  wrapper.append(strip, scale);
  return wrapper;
}

// The log is optional. It ships from a separate repo and did not exist when this
// page first deployed, so a missing or malformed log costs the bars and nothing
// else — current status comes from the snapshot either way.
async function loadBars(root) {
  const base = root.dataset.logUrl;
  if (!base) return null;
  try {
    const [events, meta] = await Promise.all(
      [`${base}/events.jsonl`, `${base}/meta.json`].map(async (url) => {
        const response = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        return response.text();
      }),
    );
    const parsed = parseEvents(events);
    const asOf = effectiveAsOf(JSON.parse(meta).reconciled_at, parsed);
    if (!asOf) return null;
    const spans = componentSpans(parsed, { asOf });
    return {
      cells: dailyBars(spans, { asOf, days: BAR_DAYS }),
      uptime: uptimeSummary(spans, { asOf, days: BAR_DAYS }),
    };
  } catch (error) {
    console.warn("Status history unavailable; rendering without bars", error);
    return null;
  }
}

function renderStatus(root, data, bars) {
  const overall = summarizeOverallStatus(data);
  const overallPanel = root.querySelector("#status-overall");
  const heading = root.querySelector("#status-overall-heading");
  const summary = root.querySelector("#status-summary");
  const incidents = root.querySelector("#status-incidents");
  const asOf = root.querySelector("#status-as-of");
  const stale = root.querySelector("#status-stale");
  const groups = root.querySelector("#status-groups");

  overallPanel.className = `status-overall status-${overall.status}`;
  heading.textContent = {
    operational: "All systems operational",
    degraded: "Some services are degraded",
    down: "Service disruption",
  }[overall.status];
  summary.textContent =
    overall.status === "operational"
      ? "All monitored datasets and public endpoints are reporting normally."
      : "The affected components are listed below.";

  incidents.replaceChildren();
  incidents.hidden = overall.incidents.length === 0;
  for (const incident of overall.incidents) {
    const item = document.createElement("li");
    item.textContent = `${incident.name} — ${statusLabel(incident.status)}`;
    incidents.append(item);
  }

  const generatedTime = document.createElement("time");
  generatedTime.dateTime = data.generated_at;
  generatedTime.textContent = formatTimestamp(data.generated_at);
  const asOfLabel = document.createElement("strong");
  asOfLabel.append("As of ", generatedTime);
  asOf.replaceChildren(asOfLabel);

  // Write the text rather than only un-hiding it: screen readers announce a
  // live region on content change, and handling of "already-populated region
  // becomes visible" is inconsistent across NVDA/JAWS/VoiceOver.
  setStale(
    stale,
    isStatusDataStale(data.generated_at)
      ? "The publisher has not refreshed this page in more than 20 minutes."
      : null,
  );
  groups.hidden = false;
  // Datasets are published in the feed but deliberately not rendered yet: this
  // page mirrors the sections the retiring uptime.dynamical.org carried, and
  // per-dataset health was never on it. Re-adding the section later is a page
  // change only, since the feed already carries them.
  for (const [selector, group] of [
    ["#status-endpoints", "endpoint"],
    ["#status-tools", "tool"],
  ]) {
    renderGroup(
      root.querySelector(selector),
      data.endpoints.filter((entry) => entry.group === group),
      bars?.cells,
      bars?.uptime,
    );
  }
}

function setStale(stale, message) {
  stale.replaceChildren();
  stale.hidden = message === null;
  if (message === null) return;
  const label = document.createElement("strong");
  label.textContent = "Status data is stale.";
  stale.append(label, ` ${message}`);
}

function renderUnavailable(root) {
  const overallPanel = root.querySelector("#status-overall");
  overallPanel.className = "status-overall status-unavailable";
  root.querySelector("#status-overall-heading").textContent =
    "Status temporarily unavailable";
  root.querySelector("#status-summary").textContent =
    "The status feed could not be loaded. Try again shortly.";
  root.querySelector("#status-incidents").hidden = true;
  setStale(root.querySelector("#status-stale"), null);
  root.querySelector("#status-groups").hidden = true;
  const asOfLabel = document.createElement("strong");
  asOfLabel.textContent = "As of —";
  root.querySelector("#status-as-of").replaceChildren(asOfLabel);
}

async function loadStatus(root) {
  const bars = loadBars(root);
  try {
    const response = await fetch(root.dataset.statusUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      // Without a deadline a hung CDN connection leaves the page stuck on
      // "Checking current status…" forever instead of the unavailable state.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.status}`);
    }
    // Started before the snapshot is awaited, so a slow log costs only the bars.
    // Awaiting it inside renderStatus's argument list made a hung log hold the
    // whole page on "Checking current status…" for the full fetch deadline.
    const data = validateStatusData(await response.json());
    renderStatus(root, data, await bars);
  } catch (error) {
    console.error("Unable to load public status", error);
    renderUnavailable(root);
  }
}

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-status-page]");
  if (root) {
    loadStatus(root);
    // Matches the publisher's cadence and the feed's max-age, so a tab left
    // open on a wall display keeps current instead of showing one frozen
    // timestamp forever — which would also stop the stale banner ever firing.
    setInterval(() => loadStatus(root), REFRESH_INTERVAL_MS);
  }
}
