import {
  buildHistory,
  isHistoryCurrent,
  isStatusDataStale,
  summarizeOverallStatus,
  validateStatusData,
} from "../public/status.mjs";
import { validateDashboard } from "../public/pipeline.mjs";

const PIPELINE_STALE_AFTER_MS = 10 * 60 * 1000;
const MAX_PIPELINE_ROWS = 6;
const MAX_PIPELINE_RUNS = 8;
const FETCH_TIMEOUT_MS = 10 * 1000;

const RUN_STATE_RANK = {
  complete: 0,
  pending: 1,
  processing: 2,
  unobserved: 3,
  unknown: 3,
  delayed: 4,
  failed: 5,
};

function timestampLabel(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "snapshot unavailable";
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} · ${iso.slice(11, 16)} UTC`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function statusSummary(overall, componentCount) {
  if (overall.status === "operational") {
    return `${plural(componentCount, "monitored component")}`;
  }
  return `${plural(overall.incidents.length, "affected component")} · ${plural(
    componentCount,
    "monitored component",
  )}`;
}

export function unavailableStatusCardModel() {
  return {
    variant: "status",
    state: "unavailable",
    headline: "Status snapshot unavailable",
    summary: "Visit the status page for the current view.",
    timestamp: "snapshot unavailable",
    components: [],
  };
}

export function createStatusCardModel(data, history, { now = new Date() } = {}) {
  const validated = validateStatusData(data);
  const overall = summarizeOverallStatus(validated);
  const stale = isStatusDataStale(validated.generated_at, now);
  const headlines = {
    operational: "All systems operational",
    degraded: "Service degradation",
    down: "Service disruption",
  };

  return {
    variant: "status",
    state: stale ? "stale" : overall.status,
    headline: stale ? "Status snapshot is stale" : headlines[overall.status],
    summary: statusSummary(overall, validated.endpoints.length),
    timestamp: timestampLabel(validated.generated_at),
    components: validated.endpoints.map((component) => ({
      name: component.name,
      state: component.status,
      history: history?.cells?.get(component.id)?.map(({ state }) => state) ?? [],
    })),
  };
}

function runState(run) {
  if (!run || typeof run !== "object") return "unknown";
  if (run.status === "failed") return "failed";
  if (run.timing === "delayed") return "delayed";
  if (run.status === "in_flight" || run.status === "processing") {
    return "processing";
  }
  if (run.status === "pending") return "pending";
  if (run.status === "complete") return "complete";
  if (run.status === "unobserved") return "unobserved";
  return "unknown";
}

function worseRunState(left, right) {
  return RUN_STATE_RANK[right] > RUN_STATE_RANK[left] ? right : left;
}

function pipelineRow(group) {
  const byInit = new Map();
  for (const product of group.products) {
    for (const run of product.recent_inits) {
      const state = runState(run);
      byInit.set(
        run.init_time,
        byInit.has(run.init_time)
          ? worseRunState(byInit.get(run.init_time), state)
          : state,
      );
    }
  }
  const runs = [...byInit.entries()]
    .sort(([left], [right]) => Date.parse(left) - Date.parse(right))
    .slice(-MAX_PIPELINE_RUNS)
    .map(([, state]) => state);
  return { label: group.label, runs };
}

function latestCounts(groups) {
  const counts = {
    complete: 0,
    pending: 0,
    processing: 0,
    delayed: 0,
    failed: 0,
    unobserved: 0,
    unknown: 0,
  };
  for (const group of groups) {
    for (const product of group.products) {
      const latest = product.recent_inits.at(-1);
      counts[runState(latest)] += 1;
    }
  }
  return counts;
}

function latestSummary(counts) {
  const labels = [
    ["failed", "failed"],
    ["delayed", "delayed"],
    ["processing", "processing"],
    ["pending", "pending"],
    ["complete", "complete"],
    ["unobserved", "unobserved"],
    ["unknown", "unknown"],
  ];
  const parts = labels
    .filter(([state]) => counts[state] > 0)
    .map(([state, label]) => `${counts[state]} ${label}`);
  return parts.length ? `${parts.join(" · ")} · latest source runs` : "No recent runs";
}

function advisoryLabel(advisories) {
  if (advisories.length === 0) return "upstream sources nominal";
  const agencies = [
    ...new Set(advisories.map(({ agency }) => String(agency).toUpperCase())),
  ];
  return `${agencies.join(", ")} advisor${advisories.length === 1 ? "y" : "ies"}`;
}

function pipelineState(counts, advisories) {
  if (counts.failed > 0) return "failed";
  if (advisories.length > 0) return "advisory";
  if (counts.delayed > 0) return "delayed";
  return "operational";
}

export function unavailablePipelineCardModel() {
  return {
    variant: "pipeline",
    state: "unavailable",
    headline: "Pipeline snapshot unavailable",
    summary: "Visit the pipeline page for the current view.",
    timestamp: "snapshot unavailable",
    advisory: "source status unavailable",
    latest: {
      complete: 0,
      pending: 0,
      processing: 0,
      delayed: 0,
      failed: 0,
      unobserved: 0,
      unknown: 0,
    },
    rows: [],
    extraRows: 0,
  };
}

export function createPipelineCardModel(
  data,
  { now = new Date() } = {},
) {
  const dashboard = validateDashboard(data);
  const latest = latestCounts(dashboard.groups);
  const stale =
    now.getTime() - Date.parse(dashboard.generated_at) > PIPELINE_STALE_AFTER_MS;
  const state = pipelineState(latest, dashboard.advisories);
  const headlines = {
    operational: "Recent forecast runs",
    advisory: "Upstream advisory active",
    delayed: "Recent runs delayed",
    failed: "Recent pipeline failure",
  };
  const rows = dashboard.groups.slice(0, MAX_PIPELINE_ROWS).map(pipelineRow);

  return {
    variant: "pipeline",
    state: stale ? "stale" : state,
    headline: stale ? "Pipeline snapshot is stale" : headlines[state],
    summary: latestSummary(latest),
    timestamp: timestampLabel(dashboard.generated_at),
    advisory: advisoryLabel(dashboard.advisories),
    latest,
    rows,
    extraRows: Math.max(0, dashboard.groups.length - rows.length),
  };
}

async function fetchArtifact(url, { fetchImpl }) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

export function statusHistoryFromArtifacts(events, meta) {
  return buildHistory(events, meta);
}

export async function loadStatusCardModel({
  statusUrl,
  logBase,
  fetchImpl = fetch,
  now = new Date(),
}) {
  try {
    const data = await (await fetchArtifact(statusUrl, { fetchImpl })).json();
    let history = null;
    try {
      const [eventsResponse, metaResponse] = await Promise.all([
        fetchArtifact(`${logBase}/events.jsonl`, { fetchImpl }),
        fetchArtifact(`${logBase}/meta.json`, { fetchImpl }),
      ]);
      const candidate = buildHistory(
        await eventsResponse.text(),
        await metaResponse.text(),
      );
      if (isHistoryCurrent(candidate.asOf, data.generated_at)) {
        history = candidate;
      }
    } catch {
      // Current status is independently useful; history can disappear alone.
    }
    return createStatusCardModel(data, history, { now });
  } catch {
    return unavailableStatusCardModel();
  }
}

export async function loadPipelineCardModel({
  assetsBase,
  fetchImpl = fetch,
  now = new Date(),
}) {
  try {
    const response = await fetchArtifact(`${assetsBase}/dashboard.json`, {
      fetchImpl,
    });
    return createPipelineCardModel(await response.json(), { now });
  } catch {
    return unavailablePipelineCardModel();
  }
}
