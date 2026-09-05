import {
  Fragment,
  html,
  render,
  useEffect,
  useMemo,
  useRef,
} from "./vendor/preact-htm.mjs";
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
    entry &&
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    (entry.observation == null ||
      (entry.observation.kind === "observation" &&
        typeof entry.observation.summary === "string"))
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
  const endpointIds = data.endpoints.map(({ id }) => id);
  if (
    endpointIds.some((id) => id.length === 0) ||
    new Set(endpointIds).size !== endpointIds.length
  ) {
    throw new TypeError("Invalid status entry id");
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
  const incidentGroupIds =
    data.incident_groups?.map(({ id }) => id) ?? [];
  if (new Set(incidentGroupIds).size !== incidentGroupIds.length) {
    throw new TypeError("Invalid incident group id");
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

export function statusLabel(entry) {
  if (entry.status === "degraded" && entry.observation?.kind === "observation") {
    return "Monitoring gap";
  }
  if (
    entry.status === "down" &&
    entry.maintenance?.kind === "planned"
  ) {
    return "Planned outage";
  }
  const componentLabel = LABELS[entry.id]?.[entry.status];
  if (componentLabel) return componentLabel;
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

// Row labels that say what a state means for a particular component, keyed by
// component id then status. The scorecard updater is a cron whose late or failed
// run leaves dynamical.org/scorecard serving stale data: a delay, not a
// degradation of the page. Colour and data-status stay with the state.
const LABELS = {
  scorecard: { degraded: "Delayed" },
};

// What an entry means for a reader, keyed by component id. The impact language
// is the page's job, not the log's: the log records states; this says what the
// state did to the thing you use. A component the publisher adds before this
// page learns it falls back to generic phrasing rather than rendering nothing.
// An `<kind>Ongoing` variant replaces the generic "— ongoing." for an open entry
// where forward-looking copy is more useful than a dash.
const IMPACT = {
  "dynamical-org": { outage: "The status page was unreachable" },
  "scorecard-site": { outage: "The scorecard page was unreachable" },
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
    delay: "The scorecard updater missed a refresh, leaving its data stale",
    delayOngoing:
      "The scorecard updater missed a refresh; data will be delayed until the next successful run",
  },
};

// A publisher emits one group per window it detects, so a single upstream
// episode — a cron-monitoring outage flickering for an hour — reaches the page
// as a run of identical groups minutes apart.
const NEARBY_GROUP_GAP_MS = 2 * 60 * 60 * 1000;

function sameEpisode(a, b) {
  return (
    a.kind === b.kind &&
    a.summary === b.summary &&
    a.description === b.description &&
    a.components.length === b.components.length &&
    a.components.every((component) => b.components.includes(component))
  );
}

// Fold such a run into one entry that keeps every window, so the log reads as
// one episode while its duration still counts only the windows themselves.
export function coalesceIncidentGroups(incidentGroups) {
  const coalesced = [];
  const sorted = [...incidentGroups].sort(
    (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
  );
  for (const group of sorted) {
    const window = {
      start: Date.parse(group.started_at),
      end: Date.parse(group.ended_at),
    };
    const previous = coalesced.at(-1);
    if (
      previous &&
      sameEpisode(previous, group) &&
      window.start - previous.windows.at(-1).end <= NEARBY_GROUP_GAP_MS
    ) {
      previous.windows.push(window);
    } else {
      coalesced.push({ ...group, windows: [window] });
    }
  }
  return coalesced;
}

// A coalesced entry spans more than it lost: the minutes between its windows
// were observed. Duration claims count the windows, never the span.
function measuredDuration(entry, end) {
  return entry.windows
    ? entry.windows.reduce(
        (total, window) => total + window.end - window.start,
        0,
      )
    : (entry.end ?? end) - entry.start;
}

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
  const hasCoverageGap = (component, start, end) => {
    const spans = history.spans?.get(component);
    if (!spans) {
      return (history.cells?.get(component) ?? []).some(
        (cell) => cell.state === "nodata" && dayOverlaps(cell, start, end),
      );
    }
    const observed = spans.reduce(
      (total, span) =>
        total + Math.max(0, Math.min(span.end, end) - Math.max(span.start, start)),
      0,
    );
    return observed < end - start;
  };

  for (const configured of coalesceIncidentGroups(incidentGroups)) {
    const windows = configured.windows;
    const windowStart = windows[0].start;
    const windowEnd = windows.at(-1).end;
    const spread = windows.length > 1 ? { windows } : {};
    const components = new Set(configured.components);
    // Each window matches on its own: an outage in the observed minutes
    // between two windows is not part of the episode.
    const matches = ungrouped.filter(
      (incident) =>
        components.has(incident.component) &&
        windows.some(
          ({ start, end }) => start <= incident.start && incident.start < end,
        ),
    );
    if (matches.length === 0) {
      if (configured.kind !== "observation") continue;
      const id = `incident-group-${configured.id}`;
      const componentsWithGaps = configured.components.filter((component) =>
        windows.some(({ start, end }) => hasCoverageGap(component, start, end)),
      );
      if (componentsWithGaps.length === 0) continue;
      observationWindows.push({
        id,
        windows,
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
        ...spread,
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
      ...spread,
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
          (gap) =>
            ["operational", "nodata"].includes(cell.state) &&
            gap.components.has(component) &&
            gap.windows.some(({ start, end }) => dayOverlaps(cell, start, end)),
        );
        if (standalone.length > 0) {
          return {
            ...cell,
            displayState: "observation",
            incidentIds: [
              ...new Set([
                ...(cell.incidentIds ?? []),
                ...standalone.map((gap) => gap.id),
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
  const ongoingImpact = IMPACT[entry.component]?.[`${kind}Ongoing`];
  if (!entry.end && ongoingImpact) return `${ongoingImpact}.`;
  return entry.end
    ? `${impact} for ${formatDuration(entry.start, entry.end)}.`
    : `${impact} — ongoing.`;
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

function Day({ cell }) {
  const anchor = cell.incidentIds?.[0] ?? cell.delayIds?.[0];
  const dayState = cell.displayState ?? cell.state;
  const dayLabel = DAY_LABELS[dayState] ?? dayState;
  const Tag = anchor ? "a" : "span";
  return html`<${Tag}
    data-day=${dayState}
    title=${`${cell.date}: ${dayLabel}`}
    href=${anchor ? `#${anchor}` : null}
    aria-label=${anchor
      ? `${cell.date}: ${dayLabel}; view details`
      : null}
    aria-hidden=${anchor ? null : "true"}
  />`;
}

function BarStrip({ cells }) {
  return html`<div
    class="status-bars"
    role="group"
    aria-label=${barDescription(cells)}
  >
    ${cells.map((cell) => html`<${Day} key=${cell.date} cell=${cell} />`)}
  </div>`;
}

function StatusRow({ entry, bars, uptime, emptyCells }) {
  const cells = bars?.get(entry.id) ?? emptyCells;
  const measured = uptime?.get(entry.id);
  const strip = useMemo(
    () => (cells?.length ? html`<${BarStrip} cells=${cells} />` : null),
    [cells],
  );
  return html`<li
    data-status=${entry.status}
    data-kind=${entry.observation?.kind ?? entry.maintenance?.kind ?? null}
  >
    <header>
      <h3>${entry.name}</h3>
      <span class="status-label">
        <span aria-hidden="true">${statusMark(entry)}</span>${` ${statusLabel(entry)}`}
      </span>
    </header>
    ${cells?.length && measured
      ? html`<p>${uptimeDescription(measured, cells.length)}</p>`
      : null}
    ${strip}
  </li>`;
}

function StatusGroup({ entries, bars, uptime, emptyCells }) {
  return entries.map(
    (entry) => html`<${StatusRow}
      key=${entry.id}
      entry=${entry}
      bars=${bars}
      uptime=${uptime}
      emptyCells=${emptyCells}
    />`,
  );
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
    spans,
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

function Updated({ data, local, stale }) {
  if (!data) return "As of —";
  if (stale) {
    return html`<span aria-hidden="true">⚠</span>${" "}<strong>Stale:</strong>${STALE_MESSAGE.slice("Stale:".length)}`;
  }
  return html`${"As of "}<time datetime=${data.generated_at}
    >${formatTimestamp(data.generated_at, local, false)}</time>`;
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
  const measured = formatDuration(0, measuredDuration(incident, end));
  return incident.end
    ? `${impact} for ${measured}.`
    : `${impact} — ongoing for ${measured}.`;
}

function incidentView(history, data) {
  if (!history) {
    return {
      empty: "Incident history is temporarily unavailable.",
      names: new Map(),
      visible: [],
    };
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
  return {
    empty: "No incidents or delays recorded.",
    names,
    visible,
  };
}

function Incident({ incident, visible, names, asOf, local }) {
  const kind = incident.kind ?? "outage";
  const kindLabel =
    kind === "planned"
      ? "planned outage"
      : kind === "observation"
        ? "observation gap"
        : kind;
  // A coalesced entry stands for several windows, so it says so twice over:
  // a plural state line, and a timing line that counts them.
  const label = incident.windows ? `${kindLabel}s` : kindLabel;
  const end = incident.end ?? asOf;
  const measured = formatDuration(0, measuredDuration(incident, end));
  const description = incident.components
    ? groupedIncidentDescription(incident, names, end)
    : incidentDescription(incident, names.get(incident.component));
  const overlapping = overlappingEntries(incident, visible, asOf);
  const spent = incident.windows
    ? `${incident.windows.length} ${label} totaling ${measured}`
    : measured;
  const timing =
    incident.ending === "observation-ended"
      ? `${formatTimestamp(incident.start, local)} – ${formatTimestamp(incident.end, local)} · ${spent}. Recovery was not witnessed.`
      : `${formatTimestamp(incident.start, local)} – ${incident.end ? formatTimestamp(incident.end, local) : "ongoing"} · ${spent}.`;

  return html`<li
    id=${incident.id}
    class="status-incident"
    data-kind=${kind}
  >
    <header>
      <h3><mark>${incidentName(incident, names)}</mark></h3>
      <strong>${`${label} · ${
        incident.ending === "resolved"
          ? "resolved"
          : incident.ending === "observation-ended"
            ? "observation ended"
            : "ongoing"
      }`}</strong>
    </header>
    <p>
      ${description}${overlapping.length
        ? html`${" Coincided with "}${overlapping.map((other, index) => {
            const otherKind =
              other.kind === "planned"
                ? "planned outage"
                : other.kind ?? "outage";
            return html`<${Fragment} key=${other.id}
              >${index > 0 ? ", " : null}<a
                href=${`#${other.id}`}
              >${`the ${incidentName(other, names)} ${otherKind}`}</a><//>`;
          })}${"."}`
        : null}
    </p>
    <p>${timing}</p>
  </li>`;
}

function IncidentLog({ visible, names, asOf, local }) {
  const handledHash = useRef(null);
  const signature = visible.map(({ id }) => id).join("\n");

  useEffect(() => {
    const handleHashChange = () => {
      const hash = location.hash;
      if (!hash) {
        handledHash.current = hash;
        return;
      }
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      handledHash.current = target ? hash : null;
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    const hash = location.hash;
    if (!hash || handledHash.current === hash) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!target) return;
    // Record before replace: its hashchange, when a browser emits one for the
    // same fragment, must not leave this navigation pending again.
    handledHash.current = hash;
    requestAnimationFrame(() => location.replace(hash));
  }, [signature]);

  return visible.map(
    (incident) => html`<${Incident}
      key=${incident.id}
      incident=${incident}
      visible=${visible}
      names=${names}
      asOf=${asOf}
      local=${local}
    />`,
  );
}

async function loadStatus(root, update) {
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
    const loadedHistory = await history;
    const currentHistory =
      loadedHistory && isHistoryCurrent(loadedHistory.asOf, data.generated_at)
        ? loadedHistory
        : null;
    update({
      data,
      loadedHistory,
      history: applyIncidentGroups(currentHistory, data.incident_groups ?? []),
      error: null,
      unavailable: false,
      loaded: true,
    });
  } catch (error) {
    console.error("Unable to load public status", error);
    update({
      data: null,
      loadedHistory: null,
      history: null,
      error,
      unavailable: true,
      loaded: true,
      overallSummary: "The status feed could not be loaded. Try again shortly.",
    });
  }
}

async function loadAgencyHealth(root, update) {
  const url = root.querySelector(".status-health").dataset.pipelineUrl;
  let health;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Agency request failed: ${response.status}`);
    const data = await response.json();
    health = agencyHealth(data.advisories);
  } catch {
    health = agencyHealth(null);
  }
  update({ agencyHealth: health });
}

function createStore(initial, paint) {
  let state = initial;
  let queued = false;
  return {
    update(patch) {
      state = {
        ...state,
        ...(typeof patch === "function" ? patch(state) : patch),
      };
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        paint(state);
      });
    },
  };
}

function start(root) {
  const asOf = root.querySelector("#status-as-of");
  const overallPanel = root.querySelector("#status-overall");
  const timeControl = asOf.querySelector('[data-slot="time-control"]');
  const timeToggle = root.querySelector("#status-time-toggle");
  const groups = root.querySelector("#status-groups");
  const slots = {
    updated: asOf.querySelector('[data-slot="status-updated"]'),
    summary: root.querySelector("#status-summary"),
    incidents: root.querySelector("#status-incidents"),
    historyNotice: root.querySelector("#status-history"),
    endpoints: root.querySelector("#status-endpoints"),
    tools: root.querySelector("#status-tools"),
    incidentEmpty: root.querySelector("#status-incident-empty"),
    incidentLog: root.querySelector("#status-incident-log"),
  };

  function paint(state) {
    timeToggle.value = state.local ? "local" : "utc";
    if (state.agencyHealth) {
      renderHealth(root, "agency-health", state.agencyHealth);
    }
    if (!state.loaded) return;

    const { data, history, loadedHistory } = state;
    const stale = data ? isStatusDataStale(data.generated_at) : false;
    asOf.classList.toggle("status-stale", stale);
    timeControl.hidden = !data || stale;
    overallPanel.hidden = !state.unavailable;
    slots.incidents.hidden = true;
    groups.hidden = !data;
    render(state.overallSummary, slots.summary);
    render(null, slots.incidents);
    render(
      html`<${Updated} data=${data} local=${state.local} stale=${stale} />`,
      slots.updated,
    );
    renderHealth(root, "system-health", systemHealth(data));

    const historyMessage = state.unavailable
      ? null
      : history
        ? null
        : loadedHistory
          ? "Uptime history is stale and has been hidden."
          : "Uptime history is temporarily unavailable.";
    slots.historyNotice.hidden = historyMessage === null;
    render(historyMessage ?? "", slots.historyNotice);

    if (data) {
      const emptyCells = dailyBars(new Map([["", []]]), {
        asOf: history?.asOf ?? new Date(data.generated_at),
        days: BAR_DAYS,
      }).get("");
      for (const [slot, group] of [
        [slots.endpoints, "endpoint"],
        [slots.tools, "tool"],
      ]) {
        render(
          html`<${StatusGroup}
            entries=${data.endpoints.filter((entry) => entry.group === group)}
            bars=${history?.cells}
            uptime=${history?.uptime}
            emptyCells=${emptyCells}
          />`,
          slot,
        );
      }
    }

    const incidents = incidentView(history, data ?? { endpoints: [] });
    slots.incidentEmpty.hidden = incidents.visible.length > 0;
    render(incidents.empty, slots.incidentEmpty);
    render(
      html`<${IncidentLog}
        visible=${incidents.visible}
        names=${incidents.names}
        asOf=${history?.asOf.getTime()}
        local=${data ? state.local : true}
      />`,
      slots.incidentLog,
    );
  }

  const store = createStore(
    {
      data: null,
      loadedHistory: null,
      history: null,
      error: null,
      unavailable: false,
      loaded: false,
      local: true,
      agencyHealth: null,
      overallSummary: "Loading the latest monitor results.",
    },
    paint,
  );
  const update = (patch) => store.update(patch);

  store.update({
    local: setupTimeToggle(timeToggle, (local) => store.update({ local })),
  });
  loadStatus(root, update);
  loadAgencyHealth(root, update);
  setInterval(() => loadStatus(root, update), REFRESH_INTERVAL_MS);
  setInterval(() => loadAgencyHealth(root, update), REFRESH_INTERVAL_MS);
}

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-status-page]");
  if (root) start(root);
}
