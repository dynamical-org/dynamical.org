import {
  componentSpans,
  dailyBars,
  effectiveAsOf,
  incidentLog,
  parseEventLog,
  uptimeSummary,
} from "./status-log.mjs";

const PUBLIC_STATUSES = new Set(["operational", "degraded", "down"]);
const PUBLIC_GROUPS = new Set(["endpoint", "tool"]);
const STALE_AFTER_MS = 20 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BAR_DAYS = 90;
export const STALE_MESSAGE = "Stale: status page experiencing delayed updates";

function isStatusEntry(entry) {
  return (
    entry && typeof entry.id === "string" && typeof entry.name === "string"
  );
}

function hasUtcOffset(timestamp) {
  return (
    typeof timestamp === "string" &&
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp) &&
    Number.isFinite(Date.parse(timestamp))
  );
}

// Preserve the rest of the page when a separately deployed publisher adds a state.
function normalizeEntry(entry) {
  return PUBLIC_STATUSES.has(entry.status)
    ? entry
    : { ...entry, status: "unknown" };
}

export function validateStatusData(data) {
  if (
    !data ||
    !hasUtcOffset(data.generated_at) ||
    !Array.isArray(data.datasets) ||
    !Array.isArray(data.endpoints)
  ) {
    throw new TypeError("Invalid status document");
  }
  // A contentless document must not read as "all clear".
  if (data.endpoints.length === 0) {
    throw new TypeError("Invalid status document: no components");
  }
  if (![...data.datasets, ...data.endpoints].every(isStatusEntry)) {
    throw new TypeError("Invalid status entry");
  }
  if (!data.endpoints.every((entry) => PUBLIC_GROUPS.has(entry.group))) {
    throw new TypeError("Invalid status entry group");
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
  const incidents = data.endpoints
    .filter((entry) => entry.status !== "operational")
    .map(({ name, status }) => ({ name, status }));
  const statuses = new Set(incidents.map(({ status }) => status));
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

function formatDuration(start, end) {
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) {
    return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
}

function statusMark(status) {
  return { operational: "●", degraded: "▲", down: "×", unknown: "?" }[status];
}

export function uptimeDescription(measured, days) {
  return `${measured.uptime}% uptime over the last ${days} ${
    days === 1 ? "day" : "days"
  }`;
}

function renderGroup(list, entries, bars, uptime, emptyCells) {
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

    const cells = bars?.get(entry.id) ?? emptyCells;
    const measured = uptime?.get(entry.id);
    if (cells?.length && measured) {
      const detail = document.createElement("p");
      detail.textContent = uptimeDescription(measured, cells.length);
      item.append(detail);
    }
    if (cells?.length) item.append(barStrip(cells));
    list.append(item);
  }
}

export function barDescription(cells) {
  const down = cells.filter((cell) => cell.state === "down").length;
  const unknown = cells.filter((cell) => cell.state === "unknown").length;
  const uncovered = cells.filter((cell) => cell.state === "nodata").length;
  const days = cells.length;
  const plural = (n) => (n === 1 ? "day" : "days");
  const parts = [
    down === 0
      ? `No outages recorded in the last ${days} ${plural(days)}`
      : `${down} of the last ${days} ${plural(days)} had an outage`,
  ];
  if (unknown > 0) parts.push(`${unknown} ${plural(unknown)} had an unknown state`);
  if (uncovered > 0) parts.push(`${uncovered} ${plural(uncovered)} not monitored`);
  return parts.join("; ");
}

function barStrip(cells) {
  const strip = document.createElement("div");
  strip.className = "status-bars";
  const days = cells.length;
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", barDescription(cells));
  for (const cell of cells) {
    const incident = cell.incidentIds?.[0];
    const day = document.createElement(incident ? "a" : "span");
    day.dataset.day = cell.state;
    day.title = `${cell.date}: ${cell.state === "nodata" ? "not monitored" : cell.state}`;
    if (incident) {
      day.href = `#${incident}`;
      day.setAttribute(
        "aria-label",
        `${cell.date}: outage; view incident details`,
      );
    } else {
      day.setAttribute("aria-hidden", "true");
    }
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

export function buildHistory(eventsText, metaText) {
  const { events, recordCount } = parseEventLog(eventsText);
  const meta = JSON.parse(metaText);
  if (
    "events_count" in meta &&
    (!Number.isInteger(meta.events_count) ||
      meta.events_count < 0 ||
      meta.events_count !== recordCount)
  ) {
    throw new TypeError("Mismatched event-log revision");
  }
  const asOf = effectiveAsOf(meta.reconciled_at, events);
  if (!asOf) throw new TypeError("Invalid status history metadata");
  const spans = componentSpans(events, { asOf });
  return {
    asOf,
    cells: dailyBars(spans, { asOf, days: BAR_DAYS }),
    incidents: incidentLog(events),
    uptime: uptimeSummary(spans, { asOf, days: BAR_DAYS }),
  };
}

export function isHistoryCurrent(asOf, generatedAt) {
  const snapshot = Date.parse(generatedAt);
  return (
    asOf instanceof Date &&
    Number.isFinite(asOf.getTime()) &&
    Number.isFinite(snapshot) &&
    Math.abs(snapshot - asOf.getTime()) <= STALE_AFTER_MS
  );
}

async function loadHistory(root) {
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
    return buildHistory(events, meta);
  } catch (error) {
    console.warn("Status history unavailable; rendering without bars", error);
    return null;
  }
}

function renderStatus(root, data, loadedHistory) {
  const overall = summarizeOverallStatus(data);
  const overallPanel = root.querySelector("#status-overall");
  const heading = root.querySelector("#status-overall-heading");
  const summary = root.querySelector("#status-summary");
  const incidents = root.querySelector("#status-incidents");
  const asOf = root.querySelector("#status-as-of");
  const historyNotice = root.querySelector("#status-history");
  const groups = root.querySelector("#status-groups");

  overallPanel.className = `status-overall status-${overall.status}`;
  heading.textContent = {
    operational: "All systems operational",
    degraded: "Some services are degraded",
    down: "Service disruption",
  }[overall.status];
  summary.textContent =
    overall.status === "operational"
      ? "All monitored public endpoints and tools are reporting normally."
      : "The affected components are listed below.";

  incidents.replaceChildren();
  incidents.hidden = overall.incidents.length === 0;
  for (const incident of overall.incidents) {
    const item = document.createElement("li");
    item.textContent = `${incident.name} — ${statusLabel(incident.status)}`;
    incidents.append(item);
  }

  const stale = isStatusDataStale(data.generated_at);
  asOf.classList.toggle("status-stale", stale);
  if (stale) {
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚠";
    const label = document.createElement("strong");
    label.textContent = "Stale:";
    asOf.replaceChildren(
      icon,
      " ",
      label,
      STALE_MESSAGE.slice("Stale:".length),
    );
  } else {
    const generatedTime = document.createElement("time");
    generatedTime.dateTime = data.generated_at;
    generatedTime.textContent = formatTimestamp(data.generated_at);
    const asOfLabel = document.createElement("strong");
    asOfLabel.append("As of ", generatedTime);
    asOf.replaceChildren(asOfLabel);
  }
  const history =
    loadedHistory && isHistoryCurrent(loadedHistory.asOf, data.generated_at)
      ? loadedHistory
      : null;
  const emptyCells = dailyBars(new Map([["", []]]), {
    asOf: history?.asOf ?? new Date(data.generated_at),
    days: BAR_DAYS,
  }).get("");
  setHistoryNotice(
    historyNotice,
    history
      ? null
      : loadedHistory
        ? "Uptime history is stale and has been hidden."
        : "Uptime history is temporarily unavailable.",
  );
  groups.hidden = false;
  // Datasets remain in the feed for a later page-side section.
  for (const [selector, group] of [
    ["#status-endpoints", "endpoint"],
    ["#status-tools", "tool"],
  ]) {
    renderGroup(
      root.querySelector(selector),
      data.endpoints.filter((entry) => entry.group === group),
      history?.cells,
      history?.uptime,
      emptyCells,
    );
  }
  renderIncidentLog(root, history, data);
}

function setHistoryNotice(element, message) {
  element.hidden = message === null;
  element.textContent = message ?? "";
}

function renderIncidentLog(root, history, data) {
  const list = root.querySelector("#status-incident-log");
  const empty = root.querySelector("#status-incident-empty");
  list.replaceChildren();
  if (!history) {
    empty.textContent = "Incident history is temporarily unavailable.";
    empty.hidden = false;
    return;
  }

  const names = new Map(data.endpoints.map(({ id, name }) => [id, name]));
  const visible = history.incidents
    .filter((incident) => names.has(incident.component))
    .reverse();
  empty.textContent = "No incidents recorded.";
  empty.hidden = visible.length > 0;

  for (const incident of visible) {
    const item = document.createElement("li");
    const header = document.createElement("header");
    const name = document.createElement("h3");
    const state = document.createElement("strong");
    const timing = document.createElement("p");
    const end = incident.end ?? history.asOf.getTime();

    item.id = incident.id;
    item.className = "status-incident";
    name.textContent = names.get(incident.component);
    state.textContent =
      incident.ending === "resolved"
        ? "Resolved"
        : incident.ending === "observation-ended"
          ? "Observation ended"
          : "Ongoing";
    timing.textContent =
      incident.ending === "observation-ended"
        ? `${formatTimestamp(incident.start)} – ${formatTimestamp(incident.end)} · ${formatDuration(incident.start, end)}. Recovery was not witnessed.`
        : `${formatTimestamp(incident.start)} – ${
            incident.end ? formatTimestamp(incident.end) : "ongoing"
          } · ${formatDuration(incident.start, end)}.`;
    header.append(name, state);
    item.append(header, timing);
    list.append(item);
  }
  if (typeof location !== "undefined" && location.hash) {
    const target = document.getElementById(
      decodeURIComponent(location.hash.slice(1)),
    );
    if (target) requestAnimationFrame(() => target.scrollIntoView());
  }
}

function renderUnavailable(root) {
  const overallPanel = root.querySelector("#status-overall");
  overallPanel.className = "status-overall status-unavailable";
  root.querySelector("#status-overall-heading").textContent =
    "Status temporarily unavailable";
  root.querySelector("#status-summary").textContent =
    "The status feed could not be loaded. Try again shortly.";
  root.querySelector("#status-incidents").hidden = true;
  setHistoryNotice(root.querySelector("#status-history"), null);
  root.querySelector("#status-groups").hidden = true;
  renderIncidentLog(root, null, { endpoints: [] });
  const asOfLabel = document.createElement("strong");
  asOfLabel.textContent = "As of —";
  const asOf = root.querySelector("#status-as-of");
  asOf.classList.remove("status-stale");
  asOf.replaceChildren(asOfLabel);
}

async function loadStatus(root) {
  const history = loadHistory(root);
  try {
    const response = await fetch(root.dataset.statusUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.status}`);
    }
    const data = validateStatusData(await response.json());
    renderStatus(root, data, await history);
  } catch (error) {
    console.error("Unable to load public status", error);
    renderUnavailable(root);
  }
}

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-status-page]");
  if (root) {
    loadStatus(root);
    setInterval(() => loadStatus(root), REFRESH_INTERVAL_MS);
  }
}
