const PUBLIC_STATUSES = new Set(["operational", "degraded", "down"]);
const ENDPOINT_GROUPS = new Set(["platform", "upstream"]);
const STALE_AFTER_MS = 20 * 60 * 1000;

function isStatusEntry(entry) {
  return (
    entry &&
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    PUBLIC_STATUSES.has(entry.status)
  );
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
  if (![...data.datasets, ...data.endpoints].every(isStatusEntry)) {
    throw new TypeError("Invalid status entry");
  }
  if (!data.endpoints.every((entry) => ENDPOINT_GROUPS.has(entry.group))) {
    throw new TypeError("Invalid endpoint group");
  }
  return data;
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
  const status = statuses.has("down")
    ? "down"
    : statuses.has("degraded")
      ? "degraded"
      : "operational";
  return { status, incidents };
}

export function partitionEndpoints(endpoints) {
  return {
    platform: endpoints.filter((entry) => entry.group === "platform"),
    upstream: endpoints.filter((entry) => entry.group === "upstream"),
  };
}

function statusLabel(status) {
  return {
    operational: "Operational",
    degraded: "Degraded",
    down: "Down",
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
  return { operational: "●", degraded: "▲", down: "×" }[status];
}

function renderGroup(list, entries, kind) {
  list.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("li");
    const header = document.createElement("header");
    const name = document.createElement("h3");
    const state = document.createElement("span");

    item.dataset.status = entry.status;
    name.textContent = entry.name;
    state.className = "status-label";
    state.textContent = `${statusMark(entry.status)} ${statusLabel(entry.status)}`;
    header.append(name, state);
    item.append(header);

    if (kind === "dataset" && entry.last_successful_update) {
      const detail = document.createElement("p");
      const time = document.createElement("time");
      time.dateTime = entry.last_successful_update;
      time.textContent = formatTimestamp(entry.last_successful_update);
      detail.append("Last successful update ", time);
      item.append(detail);
    }
    if (kind === "endpoint" && Number.isFinite(entry.uptime_90d)) {
      const detail = document.createElement("p");
      detail.textContent = `${entry.uptime_90d.toFixed(3).replace(/\.?0+$/, "")}% uptime over the last 90 days`;
      item.append(detail);
    }
    list.append(item);
  }
}

function renderStatus(root, data) {
  const overall = summarizeOverallStatus(data);
  const endpoints = partitionEndpoints(data.endpoints);
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
  asOf.replaceChildren("As of ", generatedTime);

  stale.hidden = !isStatusDataStale(data.generated_at);
  groups.hidden = false;
  renderGroup(
    root.querySelector("#status-platform"),
    endpoints.platform,
    "endpoint",
  );
  renderGroup(root.querySelector("#status-datasets"), data.datasets, "dataset");
  renderGroup(
    root.querySelector("#status-upstream"),
    endpoints.upstream,
    "endpoint",
  );
}

function renderUnavailable(root) {
  const overallPanel = root.querySelector("#status-overall");
  overallPanel.className = "status-overall status-unavailable";
  root.querySelector("#status-overall-heading").textContent =
    "Status temporarily unavailable";
  root.querySelector("#status-summary").textContent =
    "The status feed could not be loaded. Try again shortly.";
  root.querySelector("#status-incidents").hidden = true;
  root.querySelector("#status-stale").hidden = true;
  root.querySelector("#status-groups").hidden = true;
  root.querySelector("#status-as-of").textContent = "As of —";
}

async function loadStatus(root) {
  try {
    const response = await fetch(root.dataset.statusUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
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
  if (root) loadStatus(root);
}
