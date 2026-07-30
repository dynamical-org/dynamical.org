import {
  componentSpans,
  dailyBars,
  effectiveAsOf,
  incidentLog,
  parseEventLog,
  uptimeSummary,
} from "./status-log.mjs";
import {
  agencyHealth,
  renderHealth,
  systemHealth,
} from "./status-health.mjs";
import { setupTimeToggle } from "./status-time.mjs";

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

function formatTimestamp(timestamp, local, includeZone = true) {
  const options = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: local ? undefined : "UTC",
  };
  if (includeZone) options.timeZoneName = "short";
  return new Intl.DateTimeFormat(undefined, options).format(
    new Date(timestamp),
  );
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
  const window = `${measured.uptime}% uptime over the last ${days} ${
    days === 1 ? "day" : "days"
  }`;
  // Delay is not downtime, but it must not hide behind a green 100% either.
  return measured.delayed > 0 ? `${window} (${measured.delayed}% degraded)` : window;
}

// What an entry means for a reader, keyed by component id. The impact language
// is the page's job, not the log's: the log records states; this says what the
// state did to the thing you use. A component the publisher adds before this
// page learns it falls back to generic phrasing rather than rendering nothing.
const IMPACT = {
  "dynamical-org": { outage: "The website was unreachable" },
  "stac-catalog": { outage: "The STAC catalog API was unreachable" },
  "data-product-reads": {
    outage: "Reads of dynamical.org data failed their canary checks",
  },
  "wxopticon-pipeline": {
    outage: "Forecast arrival detection stopped",
    delay: "Forecast arrival detection ran behind",
  },
  "wxopticon-webhooks": {
    outage: "Webhook delivery stopped",
    delay: "Webhook delivery ran behind",
  },
  "wxopticon-arrivals": {
    outage: "The arrivals dashboard stopped updating",
    delay: "The arrivals dashboard updated late",
  },
  scorecard: {
    outage: "The scorecard stopped refreshing",
    delay: "The scorecard refreshed late",
  },
};

// Entries whose intervals overlap this one's, for the "coincided with" clause.
// Correlation is the context a status page can derive honestly: it claims two
// things happened together, never that one caused the other.
export function overlappingEntries(entry, entries, asOf) {
  const endOf = (candidate) => candidate.end ?? asOf;
  return entries.filter(
    (candidate) =>
      candidate !== entry &&
      candidate.component !== entry.component &&
      candidate.start < endOf(entry) &&
      entry.start < endOf(candidate),
  );
}

export function incidentDescription(entry, name) {
  const kind = entry.kind ?? "outage";
  const impact =
    IMPACT[entry.component]?.[kind] ??
    (kind === "delay" ? `${name} ran behind` : `${name} was down`);
  return entry.end
    ? `${impact} for ${formatDuration(entry.start, entry.end)}.`
    : `${impact} — ongoing.`;
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
  const degraded = cells.filter((cell) => cell.state === "degraded").length;
  const unknown = cells.filter((cell) => cell.state === "unknown").length;
  const uncovered = cells.filter((cell) => cell.state === "nodata").length;
  const days = cells.length;
  const plural = (n) => (n === 1 ? "day" : "days");
  const parts = [
    down === 0
      ? `No outages recorded in the last ${days} ${plural(days)}`
      : `${down} of the last ${days} ${plural(days)} had an outage`,
  ];
  if (degraded > 0) parts.push(`${degraded} ${plural(degraded)} degraded`);
  if (unknown > 0) parts.push(`${unknown} ${plural(unknown)} had an unknown state`);
  if (uncovered > 0) parts.push(`${uncovered} ${plural(uncovered)} not monitored`);
  return parts.join("; ");
}

function barStrip(cells) {
  const strip = document.createElement("div");
  strip.className = "status-bars";
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", barDescription(cells));
  for (const cell of cells) {
    const anchor = cell.incidentIds?.[0] ?? cell.delayIds?.[0];
    const day = document.createElement(anchor ? "a" : "span");
    day.dataset.day = cell.state;
    day.title = `${cell.date}: ${cell.state === "nodata" ? "not monitored" : cell.state}`;
    if (anchor) {
      day.href = `#${anchor}`;
      day.setAttribute(
        "aria-label",
        `${cell.date}: ${cell.incidentIds?.length ? "outage" : "delay"}; view details`,
      );
    } else {
      day.setAttribute("aria-hidden", "true");
    }
    strip.append(day);
  }
  return strip;
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

function renderStatus(root, data, loadedHistory, local) {
  const overall = summarizeOverallStatus(data);
  const overallPanel = root.querySelector("#status-overall");
  const summary = root.querySelector("#status-summary");
  const incidents = root.querySelector("#status-incidents");
  const asOf = root.querySelector("#status-as-of");
  const updated = asOf.querySelector('[data-slot="status-updated"]');
  const timeControl = asOf.querySelector('[data-slot="time-control"]');
  const historyNotice = root.querySelector("#status-history");
  const groups = root.querySelector("#status-groups");

  renderHealth(root, "system-health", systemHealth(data));
  overallPanel.hidden = overall.status === "operational";
  summary.textContent = "The affected components are listed below.";

  incidents.replaceChildren();
  incidents.hidden = overall.incidents.length === 0;
  for (const incident of overall.incidents) {
    const item = document.createElement("li");
    item.textContent = `${incident.name} — ${statusLabel(incident.status)}`;
    incidents.append(item);
  }

  const stale = isStatusDataStale(data.generated_at);
  asOf.classList.toggle("status-stale", stale);
  timeControl.hidden = stale;
  if (stale) {
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚠";
    const label = document.createElement("strong");
    label.textContent = "Stale:";
    updated.replaceChildren(
      icon,
      " ",
      label,
      STALE_MESSAGE.slice("Stale:".length),
    );
  } else {
    const generatedTime = document.createElement("time");
    generatedTime.dateTime = data.generated_at;
    generatedTime.textContent = formatTimestamp(
      data.generated_at,
      local,
      false,
    );
    updated.replaceChildren("As of ", generatedTime);
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
  renderIncidentLog(root, history, data, local);
}

function setHistoryNotice(element, message) {
  element.hidden = message === null;
  element.textContent = message ?? "";
}

function renderIncidentLog(root, history, data, local) {
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
  empty.textContent = "No incidents or delays recorded.";
  empty.hidden = visible.length > 0;

  for (const incident of visible) {
    const item = document.createElement("li");
    const header = document.createElement("header");
    const name = document.createElement("h3");
    const state = document.createElement("strong");
    const summary = document.createElement("p");
    const timing = document.createElement("p");
    const kind = incident.kind ?? "outage";
    const end = incident.end ?? history.asOf.getTime();

    item.id = incident.id;
    item.className = "status-incident";
    item.dataset.kind = kind;
    name.textContent = names.get(incident.component);
    state.textContent = `${kind} · ${
      incident.ending === "resolved"
        ? "resolved"
        : incident.ending === "observation-ended"
          ? "observation ended"
          : "ongoing"
    }`;
    summary.className = "status-incident-summary";
    summary.textContent = incidentDescription(
      incident,
      names.get(incident.component),
    );
    const overlapping = overlappingEntries(
      incident,
      visible,
      history.asOf.getTime(),
    );
    if (overlapping.length) {
      summary.append(" Coincided with ");
      overlapping.forEach((other, index) => {
        const link = document.createElement("a");
        link.href = `#${other.id}`;
        link.textContent = `the ${names.get(other.component)} ${other.kind ?? "outage"}`;
        if (index > 0) summary.append(", ");
        summary.append(link);
      });
      summary.append(".");
    }
    timing.textContent =
      incident.ending === "observation-ended"
        ? `${formatTimestamp(incident.start, local)} – ${formatTimestamp(incident.end, local)} · ${formatDuration(incident.start, end)}. Recovery was not witnessed.`
        : `${formatTimestamp(incident.start, local)} – ${
            incident.end ? formatTimestamp(incident.end, local) : "ongoing"
          } · ${formatDuration(incident.start, end)}.`;
    header.append(name, state);
    item.append(header, summary, timing);
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
  overallPanel.hidden = false;
  root.querySelector("#status-summary").textContent =
    "The status feed could not be loaded. Try again shortly.";
  root.querySelector("#status-incidents").hidden = true;
  setHistoryNotice(root.querySelector("#status-history"), null);
  root.querySelector("#status-groups").hidden = true;
  renderIncidentLog(root, null, { endpoints: [] }, true);
  const asOf = root.querySelector("#status-as-of");
  asOf.classList.remove("status-stale");
  asOf.querySelector('[data-slot="status-updated"]').textContent = "As of —";
  asOf.querySelector('[data-slot="time-control"]').hidden = true;
  renderHealth(root, "system-health", systemHealth(null));
}

async function loadStatus(root, render) {
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
    render(data, await history);
  } catch (error) {
    console.error("Unable to load public status", error);
    render(null, null);
  }
}

async function loadAgencyHealth(root) {
  const url = root.querySelector(".status-health").dataset.pipelineUrl;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Agency request failed: ${response.status}`);
    const data = await response.json();
    renderHealth(root, "agency-health", agencyHealth(data.advisories));
  } catch {
    renderHealth(root, "agency-health", agencyHealth(null));
  }
}

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-status-page]");
  if (root) {
    let data = null;
    let history = null;
    let local = true;
    const render = (nextData, nextHistory) => {
      data = nextData;
      history = nextHistory;
      if (data) renderStatus(root, data, history, local);
      else renderUnavailable(root);
    };
    local = setupTimeToggle(
      root.querySelector("#status-time-toggle"),
      (nextLocal) => {
        local = nextLocal;
        if (data) renderStatus(root, data, history, local);
      },
    );
    loadStatus(root, render);
    loadAgencyHealth(root);
    setInterval(() => loadStatus(root, render), REFRESH_INTERVAL_MS);
    setInterval(() => loadAgencyHealth(root), REFRESH_INTERVAL_MS);
  }
}
