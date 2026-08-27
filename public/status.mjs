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
// Group kinds that reframe what their days mean on the 90-day strip: planned
// work is not an unplanned outage, and a gap in our monitoring is not a
// confirmed one. An "outage" group has no entry here, so its days stay red.
const GROUP_DAY_STATES = { observation: "observation", planned: "planned" };
const REFRAMED_DAYS = new Set(Object.values(GROUP_DAY_STATES));
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

function isIncidentGroup(group) {
  return (
    group &&
    typeof group.id === "string" &&
    ["observation", "outage", "planned"].includes(group.kind) &&
    typeof group.summary === "string" &&
    (group.description == null || typeof group.description === "string") &&
    (group.kind !== "observation" || typeof group.description === "string") &&
    hasUtcOffset(group.started_at) &&
    hasUtcOffset(group.ended_at) &&
    Date.parse(group.ended_at) > Date.parse(group.started_at) &&
    Array.isArray(group.components) &&
    group.components.length > 0 &&
    group.components.every((component) => typeof component === "string")
  );
}

function isComponentAliases(aliases) {
  return (
    aliases &&
    typeof aliases === "object" &&
    !Array.isArray(aliases) &&
    Object.entries(aliases).every(
      ([alias, target]) =>
        typeof alias === "string" && typeof target === "string",
    )
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
  if (
    data.component_aliases != null &&
    !isComponentAliases(data.component_aliases)
  ) {
    throw new TypeError("Invalid component aliases");
  }
  if (!data.endpoints.every((entry) => PUBLIC_GROUPS.has(entry.group))) {
    throw new TypeError("Invalid status entry group");
  }
  if (
    data.incident_groups != null &&
    (!Array.isArray(data.incident_groups) ||
      !data.incident_groups.every(isIncidentGroup))
  ) {
    throw new TypeError("Invalid incident group");
  }
  return {
    ...data,
    datasets: data.datasets.map(normalizeEntry),
    endpoints: data.endpoints.map(normalizeEntry),
  };
}

// wxopticon keeps publishing into the feed — we still measure it — but it is
// experimental, so its components stay off this page until they are stable
// enough to sit behind an uptime claim.
const EXPERIMENTAL_PREFIX = "wxopticon";

export function withoutExperimentalComponents(data) {
  return {
    ...data,
    endpoints: data.endpoints.filter(
      (entry) => !entry.id.startsWith(EXPERIMENTAL_PREFIX),
    ),
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

export function statusLabel(entry) {
  if (
    entry.status === "down" &&
    entry.maintenance?.kind === "planned"
  ) {
    return "Planned outage";
  }
  return {
    operational: "Operational",
    degraded: "Degraded",
    down: "Down",
    unknown: "Unknown",
  }[entry.status];
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

function statusMark(entry) {
  if (entry.status === "down" && entry.maintenance?.kind === "planned") {
    return "▲";
  }
  return { operational: "●", degraded: "▲", down: "×", unknown: "?" }[entry.status];
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
  "dynamical-org": { outage: "The status page was unreachable" },
  "stac-catalog": { outage: "The STAC catalog API was unreachable" },
  "data-product-reads": {
    outage: "Reads of dynamical.org data failed their canary checks",
  },
  "wxopticon-pipeline": {
    outage: "Forecast arrival detection stopped",
    delay: "Forecast arrival detection ran behind",
  },
  "wxopticon-webhooks": {
    outage: "Pipeline webhook delivery stopped",
    delay: "Pipeline webhook delivery ran behind",
  },
  "wxopticon-arrivals": {
    outage: "Pipeline observability stopped updating",
    delay: "Pipeline observability updated late",
  },
  scorecard: {
    outage: "The scorecard stopped refreshing",
    delay: "The scorecard refreshed late",
  },
};

// Explicit publisher metadata, not time overlap alone, determines which events
// share an incident.
export function applyIncidentGroups(history, incidentGroups = []) {
  if (!history || incidentGroups.length === 0) return history;

  let ungrouped = [...history.incidents];
  const grouped = [];
  const aliases = new Map();
  const dayStates = new Map();
  const observationWindows = [];
  const dayOverlaps = (cell, start, end) => {
    const dayStart = Date.parse(`${cell.date}T00:00:00Z`);
    return (
      Number.isFinite(dayStart) &&
      dayStart < end &&
      start < dayStart + 86_400_000
    );
  };

  for (const configured of incidentGroups) {
    const windowStart = Date.parse(configured.started_at);
    const windowEnd = Date.parse(configured.ended_at);
    const components = new Set(configured.components);
    const matches = ungrouped.filter(
      (incident) =>
        components.has(incident.component) &&
        windowStart <= incident.start &&
        incident.start < windowEnd,
    );
    if (matches.length === 0) {
      if (configured.kind !== "observation") continue;
      const id = `incident-group-${configured.id}`;
      const componentsWithGaps = configured.components.filter((component) =>
        (history.cells?.get(component) ?? []).some(
          (cell) =>
            cell.state === "nodata" &&
            dayOverlaps(cell, windowStart, windowEnd),
        ),
      );
      if (componentsWithGaps.length === 0) continue;
      observationWindows.push({
        id,
        start: windowStart,
        end: windowEnd,
        components: new Set(componentsWithGaps),
      });
      grouped.push({
        id,
        kind: configured.kind,
        summary: configured.summary,
        ...(configured.description
          ? { description: configured.description }
          : {}),
        components: componentsWithGaps,
        memberIds: [],
        start: windowStart,
        end: windowEnd,
        ending: "resolved",
      });
      continue;
    }

    const matched = new Set(matches);
    ungrouped = ungrouped.filter((incident) => !matched.has(incident));
    const id = `incident-group-${configured.id}`;
    const memberIds = matches.map((incident) => incident.id);
    const dayState = GROUP_DAY_STATES[configured.kind];
    for (const memberId of memberIds) {
      aliases.set(memberId, id);
      if (dayState) dayStates.set(memberId, dayState);
    }
    const allEnded = matches.every((incident) => incident.end != null);
    grouped.push({
      id,
      kind: configured.kind,
      summary: configured.summary,
      ...(configured.description ? { description: configured.description } : {}),
      components: configured.components.filter((component) =>
        matches.some((incident) => incident.component === component),
      ),
      memberIds,
      start: Math.min(...matches.map((incident) => incident.start)),
      end: allEnded
        ? Math.max(...matches.map((incident) => incident.end))
        : null,
      ending:
        allEnded && matches.every((incident) => incident.ending === "resolved")
          ? "resolved"
          : allEnded
            ? "observation-ended"
            : null,
    });
  }

  const cells = new Map(
    [...history.cells.entries()].map(([component, componentCells]) => [
      component,
      componentCells.map((cell) => {
        const standalone = observationWindows.filter(
          (window) =>
            cell.state === "nodata" &&
            window.components.has(component) &&
            dayOverlaps(cell, window.start, window.end),
        );
        if (standalone.length > 0) {
          return {
            ...cell,
            displayState: "observation",
            incidentIds: [
              ...new Set([
                ...(cell.incidentIds ?? []),
                ...standalone.map((window) => window.id),
              ]),
            ],
          };
        }
        if (!cell.incidentIds?.length) return { ...cell };
        const incidentIds = [
          ...new Set(cell.incidentIds.map((id) => aliases.get(id) ?? id)),
        ];
        // Only a day whose every incident agrees on one reframing takes it.
        // A day that mixes reframed and unreframed incidents keeps the
        // stronger claim, which is the one the strip should not soften.
        const claimed = new Set(cell.incidentIds.map((id) => dayStates.get(id)));
        const displayState =
          claimed.size === 1 && !claimed.has(undefined)
            ? [...claimed][0]
            : cell.displayState;
        return {
          ...cell,
          ...(displayState ? { displayState } : {}),
          incidentIds,
        };
      }),
    ]),
  );

  return {
    ...history,
    cells,
    incidents: [...ungrouped, ...grouped].sort((a, b) => a.start - b.start),
  };
}

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
    if (entry.maintenance?.kind) item.dataset.kind = entry.maintenance.kind;
    name.textContent = entry.name;
    state.className = "status-label";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = statusMark(entry);
    state.append(mark, ` ${statusLabel(entry)}`);
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
  const planned = cells.filter(
    (cell) => cell.displayState === "planned",
  ).length;
  const gaps = cells.filter(
    (cell) => cell.displayState === "observation",
  ).length;
  const down = cells.filter(
    (cell) => cell.state === "down" && !REFRAMED_DAYS.has(cell.displayState),
  ).length;
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
  if (planned > 0) {
    parts.push(`${planned} ${plural(planned)} had a planned outage`);
  }
  if (gaps > 0) parts.push(`${gaps} ${plural(gaps)} had a monitoring gap`);
  if (degraded > 0) parts.push(`${degraded} ${plural(degraded)} degraded`);
  if (unknown > 0) parts.push(`${unknown} ${plural(unknown)} had an unknown state`);
  if (uncovered > 0) parts.push(`${uncovered} ${plural(uncovered)} not monitored`);
  return parts.join("; ");
}

const DAY_LABELS = {
  nodata: "not monitored",
  observation: "monitoring gap",
  planned: "planned outage",
};

function barStrip(cells) {
  const strip = document.createElement("div");
  strip.className = "status-bars";
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", barDescription(cells));
  for (const cell of cells) {
    const anchor = cell.incidentIds?.[0] ?? cell.delayIds?.[0];
    const dayState = cell.displayState ?? cell.state;
    const dayLabel = DAY_LABELS[dayState] ?? dayState;
    const day = document.createElement(anchor ? "a" : "span");
    day.dataset.day = dayState;
    day.title = `${cell.date}: ${dayLabel}`;
    if (anchor) {
      day.href = `#${anchor}`;
      day.setAttribute(
        "aria-label",
        `${cell.date}: ${dayLabel}; view details`,
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
  const overallPanel = root.querySelector("#status-overall");
  const asOf = root.querySelector("#status-as-of");
  const updated = asOf.querySelector('[data-slot="status-updated"]');
  const timeControl = asOf.querySelector('[data-slot="time-control"]');
  const historyNotice = root.querySelector("#status-history");
  const groups = root.querySelector("#status-groups");

  renderHealth(root, "system-health", systemHealth(data));
  overallPanel.hidden = true;

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
  const currentHistory =
    loadedHistory && isHistoryCurrent(loadedHistory.asOf, data.generated_at)
      ? loadedHistory
      : null;
  const history = applyIncidentGroups(
    currentHistory,
    data.incident_groups ?? [],
  );
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

function sentenceList(items) {
  if (items.length < 2) return items.join("");
  if (items.length === 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function incidentName(incident, names) {
  return incident.summary ?? names.get(incident.component);
}

export function groupedIncidentDescription(incident, names, end) {
  if (incident.description) return incident.description;
  const affected = sentenceList([
    ...new Set(
      incident.components
        .map((component) => names.get(component))
        .filter(Boolean),
    ),
  ]);
  const impact =
    incident.kind === "planned"
      ? `Planned work affected ${affected}`
      : `Related outages affected ${affected}`;
  return incident.end
    ? `${impact} for ${formatDuration(incident.start, incident.end)}.`
    : `${impact} — ongoing for ${formatDuration(incident.start, end)}.`;
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
  for (const [alias, target] of Object.entries(data.component_aliases ?? {})) {
    if (names.has(target)) names.set(alias, names.get(target));
  }
  const visible = history.incidents
    .filter((incident) =>
      incident.components
        ? incident.components.some((component) => names.has(component))
        : names.has(incident.component),
    )
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
    const label =
      kind === "planned"
        ? "planned outage"
        : kind === "observation"
          ? "observation gap"
          : kind;
    const end = incident.end ?? history.asOf.getTime();

    item.id = incident.id;
    item.className = "status-incident";
    item.dataset.kind = kind;
    // The name wears a <mark> that stays invisible until this entry is the
    // :target — arriving from a day cell lights up the header rather than
    // boxing the whole entry.
    const highlight = document.createElement("mark");
    highlight.textContent = incidentName(incident, names);
    name.append(highlight);
    state.textContent = `${label} · ${
      incident.ending === "resolved"
        ? "resolved"
        : incident.ending === "observation-ended"
          ? "observation ended"
          : "ongoing"
    }`;
    summary.textContent = incident.components
      ? groupedIncidentDescription(incident, names, end)
      : incidentDescription(incident, names.get(incident.component));
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
        const otherKind =
          other.kind === "planned" ? "planned outage" : other.kind ?? "outage";
        link.textContent = `the ${incidentName(other, names)} ${otherKind}`;
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
    // Re-run the fragment navigation rather than scrollIntoView: the entry
    // rendered after the page navigated, so :target never matched and the
    // header's <mark> would stay dormant on a shared link. replace() scrolls
    // and re-evaluates :target without adding a history entry.
    if (target) requestAnimationFrame(() => location.replace(location.hash));
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
    const data = withoutExperimentalComponents(
      validateStatusData(await response.json()),
    );
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
