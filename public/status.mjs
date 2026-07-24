const PUBLIC_STATUSES = new Set(["operational", "degraded", "down"]);
const STALE_AFTER_MS = 20 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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

// uptime_90d is not validated in validateStatusData at all; the load-bearing
// guard is the Number.isFinite check at the call site in renderGroup, without
// which a string value would throw here. Trims trailing zeros, and never lets
// rounding promote an imperfect figure to a flat "100%".
export function formatUptime(uptime) {
  const rounded = uptime.toFixed(3);
  const capped = rounded === "100.000" && uptime < 100 ? "99.999" : rounded;
  return capped.replace(/\.?0+$/, "");
}

function renderGroup(list, entries, kind) {
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

    if (
      kind === "dataset" &&
      Number.isFinite(Date.parse(entry.last_successful_update))
    ) {
      const detail = document.createElement("p");
      const time = document.createElement("time");
      time.dateTime = entry.last_successful_update;
      time.textContent = formatTimestamp(entry.last_successful_update);
      detail.append("Last successful update ", time);
      item.append(detail);
    }
    if (kind === "endpoint" && Number.isFinite(entry.uptime_90d)) {
      const detail = document.createElement("p");
      detail.textContent = `${formatUptime(entry.uptime_90d)}% uptime over the last 90 days`;
      item.append(detail);
    }
    list.append(item);
  }
}

function renderStatus(root, data) {
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
  renderGroup(root.querySelector("#status-platform"), data.endpoints, "endpoint");
  renderGroup(root.querySelector("#status-datasets"), data.datasets, "dataset");
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
    renderStatus(root, validateStatusData(await response.json()));
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
