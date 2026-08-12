import {
  agencyHealth,
  renderHealth,
  systemHealth,
} from "./status-health.mjs";
import { setupTimeToggle } from "./status-time.mjs";

const POLL_INTERVAL_MS = 15_000;
const HEALTH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const DASHBOARD_VERSION = 2;

function hasTimestamp(value) {
  return (
    typeof value === "string" &&
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateDashboard(data) {
  if (
    !data ||
    data.v !== DASHBOARD_VERSION ||
    !hasTimestamp(data.generated_at) ||
    !Array.isArray(data.groups) ||
    data.groups.length === 0 ||
    !Array.isArray(data.advisories)
  ) {
    throw new TypeError("Invalid pipeline dashboard");
  }
  let hasFacetGroups = false;
  for (const group of data.groups) {
    if (
      typeof group.id !== "string" ||
      typeof group.label !== "string" ||
      !Array.isArray(group.products) ||
      group.products.length === 0
    ) {
      throw new TypeError("Invalid pipeline group");
    }
    for (const product of group.products) {
      if (
        typeof product.id !== "string" ||
        typeof product.row_label !== "string" ||
        !Array.isArray(product.recent_inits) ||
        product.recent_inits.length > 10
      ) {
        throw new TypeError("Invalid pipeline product");
      }
      if (product.facet_groups != null) {
        if (
          !Array.isArray(product.facet_groups) ||
          product.facet_groups.length === 0 ||
          !product.facet_groups.every(
            (facet) =>
              typeof facet.dimension === "string" &&
              typeof facet.name === "string" &&
              typeof facet.label === "string",
          )
        ) {
          throw new TypeError("Invalid pipeline facet group");
        }
        hasFacetGroups = true;
      }
      for (const init of product.recent_inits) {
        if (init.facets == null) continue;
        if (
          !Array.isArray(init.facets) ||
          !init.facets.every(
            (facet) =>
              typeof facet.dimension === "string" &&
              typeof facet.name === "string" &&
              typeof facet.label === "string" &&
              Number.isInteger(facet.dependencies_available) &&
              facet.dependencies_available >= 0 &&
              Number.isInteger(facet.dependencies_expected) &&
              facet.dependencies_expected > 0 &&
              facet.dependencies_available <= facet.dependencies_expected &&
              Number.isFinite(facet.completion_pct) &&
              facet.completion_pct >= 0 &&
              facet.completion_pct <= 1 &&
              typeof facet.status === "string",
          )
        ) {
          throw new TypeError("Invalid pipeline facet");
        }
      }
    }
  }
  if (!hasFacetGroups) {
    throw new TypeError("Invalid pipeline dashboard");
  }
  return data;
}

export function agencySummary(advisories) {
  const health = agencyHealth(advisories ?? []);
  return { state: health.state, label: health.value };
}

export function displaySource(source) {
  return source?.replace(/^https?:\/\//, "") ?? "—";
}

function productsOf(snapshot) {
  if (Array.isArray(snapshot.products)) return snapshot.products;
  return (snapshot.groups ?? []).flatMap((group) => group.products ?? []);
}

function element(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null) continue;
    if (name === "class") node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of [].concat(children ?? [])) {
    if (child == null || child === false) continue;
    node.append(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child,
    );
  }
  return node;
}

function formatLatency(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDuration(seconds) {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function initParts(timestamp, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date(timestamp));
  const part = (type) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const hour = part("hour");
  return {
    date: `${part("month")}-${part("day")}`,
    time: timeZone === "UTC" ? `${hour}z` : `${hour} ${part("timeZoneName")}`,
  };
}

function selectedTimeZone(local) {
  return local ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
}

function initShort(timestamp, local) {
  const { date, time } = initParts(timestamp, selectedTimeZone(local));
  return `${date} ${time}`;
}

function formatTime(timestamp, local, includeZone = true) {
  const options = {
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

export function clockTime(timestamp, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(timestamp));
}

function timeNode(timestamp) {
  return element("span", null, [
    element(
      "span",
      { class: "pipeline-time-utc" },
      formatTime(timestamp, false, false),
    ),
    element(
      "span",
      { class: "pipeline-time-local-only" },
      formatTime(timestamp, true, false),
    ),
  ]);
}

/* One square per measurement. Lead-group counts arrive cumulative, so a band's
   own share is the difference from the band below it — the same arithmetic the
   bars used for segment heights. */

function leadSlices(groups) {
  let previousAvailable = 0;
  let previousExpected = 0;
  return groups.map((group) => {
    const expected = group.leads_expected - previousExpected;
    const available = group.leads_available - previousAvailable;
    previousExpected = group.leads_expected;
    previousAvailable = group.leads_available;
    return {
      name: group.name,
      status: group.status,
      timing: group.timing,
      available,
      expected,
      completion: expected
        ? Math.max(0, Math.min(1, available / expected))
        : (group.completion_pct ?? 0),
    };
  });
}

/* The bands of a product's field, top row first: longest horizon down to the
   floor, then a band per facet grouped by dimension. Bands come from the
   product rather than a single run so the field keeps its shape as runs
   scroll through it. */

export function bandsOf(product) {
  const newest = product.recent_inits?.at(-1);
  // history snapshots carry the same runs but declare neither list up front
  const labelOf = new Map(
    (product.lead_group_stats ?? []).map((stats) => [stats.name, stats.label]),
  );
  const declaredLeads = product.lead_groups?.length
    ? product.lead_groups
    : (newest?.lead_groups ?? []);
  const leads = declaredLeads.map((group) => ({
    kind: "lead",
    key: group.name,
    label: group.label ?? labelOf.get(group.name) ?? group.name,
  }));
  leads.reverse();

  const declaredFacets = product.facet_groups?.length
    ? product.facet_groups
    : (newest?.facets ?? []);
  const facets = declaredFacets.map((facet) => ({
    kind: "facet",
    key: facet.name,
    label: facet.label,
    dimension: facet.dimension,
  }));
  return [...leads, ...facets];
}

/* What one run measured for one band. A band the run never reported reads as
   unobserved rather than as a failure. */

export function cellOf(band, init) {
  if (!init) return { state: "unobserved" };
  if (init.status === "unobserved") return { state: "unobserved" };

  if (band.kind === "lead") {
    const slice = leadSlices(init.lead_groups ?? []).find(
      (group) => group.name === band.key,
    );
    if (!slice) return { state: "unobserved" };
    return {
      state: slice.status,
      timing: slice.timing,
      completion: slice.completion,
    };
  }

  const facet = (init.facets ?? []).find((entry) => entry.name === band.key);
  if (!facet) return { state: "unobserved" };
  return {
    state: facet.status,
    timing: init.timing,
    completion: facet.completion_pct ?? 0,
    available: facet.dependencies_available,
    expected: facet.dependencies_expected,
  };
}

/* The hover label. What the square stands for comes first, then when, then how
   much of it arrived — a facet names itself and its dimension. */

export function cellTitle(band, init, cell, local) {
  if (!init) return `${band.label} · not reported`;
  const when = initShort(init.init_time, local);
  if (cell.state === "unobserved") {
    return `${band.label} · ${when} · no probe visibility; not a publication failure`;
  }
  const volume =
    cell.expected != null
      ? `${cell.available.toLocaleString("en-US")} / ${cell.expected.toLocaleString("en-US")} files`
      : `${Math.round((cell.completion ?? 0) * 100)}%`;
  return [
    band.kind === "facet" ? `${band.label} (${band.dimension})` : `lead ${band.label}`,
    when,
    volume,
    statusLabel(cell.state),
    cell.timing ? cell.timing.replaceAll("_", " ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderCell(band, init, local) {
  const cell = cellOf(band, init);
  return element(
    "div",
    {
      class: `pipeline-cell g-${cell.state}`,
      "data-init-time": init?.init_time,
      "data-timing": cell.timing,
      title: cellTitle(band, init, cell, local),
    },
    element("div", {
      class: "pipeline-cell-fill",
      style: `--fill:${Math.max(0, Math.min(100, (cell.completion ?? 0) * 100))}%`,
    }),
  );
}

function renderField(product, local) {
  const runs = product.recent_inits.slice(-10);
  const field = element("div", { class: "pipeline-field" });
  let dimension = null;

  for (const band of bandsOf(product)) {
    // name each facet dimension once, where it starts
    if (band.kind === "facet" && band.dimension !== dimension) {
      field.append(
        element("div", { class: "pipeline-dimension" }, band.dimension),
      );
    }
    dimension = band.kind === "facet" ? band.dimension : null;

    const cells = element("div", { class: "pipeline-cells" });
    for (const init of runs) cells.append(renderCell(band, init, local));
    field.append(
      element("div", { class: "pipeline-band", "data-kind": band.kind }, [
        element(
          "span",
          { class: "pipeline-band-label", title: band.label },
          band.label,
        ),
        cells,
      ]),
    );
  }

  const first = runs[0];
  const last = runs.at(-1);
  if (first && last) {
    field.append(
      element("div", { class: "pipeline-axis" }, [
        element("span"),
        element(
          "span",
          null,
          `${initShort(first.init_time, local)} → ${initShort(last.init_time, local)}`,
        ),
      ]),
    );
  }
  return field;
}

function renderStructure(app, dashboard, rows) {
  const groupsSlot = app.querySelector('[data-slot="groups"]');
  groupsSlot.replaceChildren();
  rows.clear();

  for (const group of dashboard.groups) {
    const section = element("section", { class: "pipeline-group" }, [
      element("h3", null, group.label),
    ]);
    for (const product of group.products) {
      const advisory = element("div", {
        class: "pipeline-row-advisory",
        "data-slot": "row-advisory",
        hidden: "",
      });
      const row = element(
        "section",
        { class: "pipeline-row", "data-product-id": product.id },
        [
          element("div", null, [
            element("strong", null, product.row_label),
            element("div", { class: "pipeline-source-meta" }, [
              element("div", null, displaySource(product.source)),
              element("div", null, `${product.cadence_hours ?? "—"}h init cadence`),
              element("div", null, `${product.init_hours?.join("/") || "—"}z`),
              advisory,
            ]),
          ]),
          element("div", { class: "pipeline-row-body" }, [
            element("div", { "data-slot": "field" }),
          ]),
          element("div", { class: "pipeline-stats" }, [
            element("strong", { "data-slot": "eta-init" }, "—"),
            element("span", { "data-slot": "eta-state", hidden: "" }),
            element("span", { "data-slot": "eta-line", hidden: "" }),
            element(
              "button",
              {
                type: "button",
                class: "pipeline-details-button",
                "data-slot": "details-button",
                "aria-expanded": "false",
                hidden: "",
              },
              "more details",
            ),
          ]),
          element("div", {
            class: "pipeline-row-details",
            "data-slot": "details",
            hidden: "",
          }),
        ],
      );
      rows.set(product.id, row);
      section.append(row);
    }
    groupsSlot.append(section);
  }
}

function etaTarget(product) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
  );
  if (running) {
    const p95 = product.latency_stats?.p95_s;
    return {
      init: running,
      initTime: running.init_time,
      target:
        p95 == null
          ? null
          : new Date(Date.parse(running.init_time) + p95 * 1000).toISOString(),
      running: true,
    };
  }
  if (!product.next_expected_init) return null;
  return {
    init: null,
    initTime: product.next_expected_init,
    target: product.next_expected_completion_at ?? null,
    running: false,
  };
}

function statusLabel(status) {
  if (status === "in_flight") return "processing";
  if (status === "unobserved") return "pending";
  return status.replaceAll("_", " ");
}

export function etaLineText(target, now, local) {
  const seconds = Math.floor((Date.parse(target) - now) / 1000);
  const time = clockTime(target, selectedTimeZone(local));
  return seconds <= 0
    ? "ETA any moment"
    : `ETA ${time} (in ${formatDuration(seconds)})`;
}

export function detailRows(product, now, local) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
  );
  const displayed = running ?? product.recent_inits.at(-1);
  const groups = displayed?.lead_groups ?? [];
  const initMs = displayed ? Date.parse(displayed.init_time) : 0;
  return {
    header: running
      ? initShort(running.init_time, local)
      : displayed
        ? `${initShort(displayed.init_time, local)} · previous init`
        : "waiting for next init",
    rows: (product.lead_group_stats ?? []).map((stats, index) => {
      const live = groups[index];
      let time = "—";
      let duration = "—";
      if (live?.status === "complete" && live.latency_s != null) {
        time = clockTime(
          initMs + live.latency_s * 1000,
          selectedTimeZone(local),
        );
        duration = formatLatency(live.latency_s);
      } else if (live?.status === "complete") {
        time = "done";
      } else if (running && stats.p95_s != null) {
        const target = initMs + stats.p95_s * 1000;
        if (target > now) {
          time = `ETA ${clockTime(target, selectedTimeZone(local))}`;
        }
        const elapsed = Math.floor((now - initMs) / 1000);
        if (elapsed > 0) duration = formatDuration(elapsed);
      }
      return {
        label: stats.label,
        status: statusLabel(live?.status ?? "pending"),
        time,
        duration,
        p50: formatLatency(stats.p50_s),
        p95: formatLatency(stats.p95_s),
        p99: formatLatency(stats.p99_s),
      };
    }),
  };
}

export function facetRows(product) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
  );
  const displayed = running ?? product.recent_inits.at(-1);
  return (displayed?.facets ?? []).map((facet) => ({
    dimension: facet.dimension,
    label: facet.label,
    status: statusLabel(facet.status),
    completion: facet.completion_pct,
    count: `${facet.dependencies_available.toLocaleString("en-US")} / ${facet.dependencies_expected.toLocaleString("en-US")} observed`,
  }));
}

function buildDetails(product, now, local) {
  const details = detailRows(product, now, local);
  const groupHead = element("tr", null, [
    element("th"),
    element("th", { colspan: "3" }, details.header),
    element("th", { colspan: "3" }, "time after init"),
  ]);
  const head = element("tr", null, [
    element("th", null, "horizon"),
    element("th", null, "status"),
    element("th", null, "time"),
    element("th", null, "duration"),
    element("th", null, "p50"),
    element("th", null, "p95"),
    element("th", null, "p99"),
  ]);
  const body = element("tbody");
  for (const row of details.rows) {
    body.append(
      element("tr", null, [
        element("td", null, row.label),
        element("td", null, row.status),
        element("td", null, row.time),
        element("td", null, row.duration),
        element("td", null, row.p50),
        element("td", null, row.p95),
        element("td", null, row.p99),
      ]),
    );
  }
  const leadTable = element("table", null, [
    element("thead", null, [groupHead, head]),
    body,
  ]);
  const facets = facetRows(product);
  if (facets.length === 0) return leadTable;

  const facetBody = element("tbody");
  for (const facet of facets) {
    facetBody.append(
      element("tr", null, [
        element("td", null, facet.dimension),
        element("td", null, facet.label),
        element("td", null, facet.status),
        element("td", null, facet.count),
        element("td", null, [
          element("progress", {
            max: "1",
            value: String(facet.completion),
            "aria-label": `${Math.round(facet.completion * 100)}% complete`,
          }),
          ` ${Math.round(facet.completion * 100)}%`,
        ]),
      ]),
    );
  }
  const facetTable = element("table", { class: "pipeline-facets" }, [
    element("thead", null, [
      element("tr", null, [
        element("th", { colspan: "5" }, "arrival coverage"),
      ]),
      element("tr", null, [
        element("th", null, "dimension"),
        element("th", null, "group"),
        element("th", null, "status"),
        element("th", null, "files"),
        element("th", null, "complete"),
      ]),
    ]),
    facetBody,
  ]);
  return element("div", null, [leadTable, facetTable]);
}

function hydrateRow(row, product, now, local) {
  row
    .querySelector('[data-slot="field"]')
    .replaceChildren(renderField(product, local));
  hydrateEta(row, product, now, local);

  const button = row.querySelector('[data-slot="details-button"]');
  const details = row.querySelector('[data-slot="details"]');
  if (product.lead_group_stats?.length || facetRows(product).length) {
    button.hidden = false;
    details.replaceChildren(buildDetails(product, now, local));
  } else {
    button.hidden = true;
    details.hidden = true;
  }
}

function hydrateEta(row, product, now, local) {
  const initSlot = row.querySelector('[data-slot="eta-init"]');
  const stateSlot = row.querySelector('[data-slot="eta-state"]');
  const lineSlot = row.querySelector('[data-slot="eta-line"]');
  const target = etaTarget(product);
  if (!target) {
    initSlot.textContent = "—";
    stateSlot.hidden = true;
    lineSlot.hidden = true;
  } else {
    initSlot.textContent = initShort(target.initTime, local);
    stateSlot.hidden = false;
    if (target.running) {
      const observed = (target.init?.completion_pct ?? 0) > 0;
      stateSlot.textContent = observed ? "processing" : "pending";
      if (target.init?.timing) {
        stateSlot.textContent += ` · ${target.init.timing.replace("_", " ")}`;
        stateSlot.dataset.timing = target.init.timing;
      } else {
        delete stateSlot.dataset.timing;
      }
    } else {
      const seconds = Math.floor((Date.parse(target.initTime) - now) / 1000);
      stateSlot.textContent =
        seconds <= 0 ? "processing" : `init in ${formatDuration(seconds)}`;
    }
    lineSlot.hidden = !target.target;
    if (target.target) {
      lineSlot.textContent = etaLineText(target.target, now, local);
    }
  }
}

function renderAdvisories(app, advisories, rows) {
  renderHealth(app, "agency-health", agencyHealth(advisories));

  for (const row of rows.values()) {
    const marker = row.querySelector('[data-slot="row-advisory"]');
    marker.hidden = true;
    marker.replaceChildren();
  }
  const slot = app.querySelector('[data-slot="advisories"]');
  slot.replaceChildren();
  if (advisories.length === 0) return;

  const container = element("div", { class: "pipeline-advisories" }, [
    element(
      "strong",
      null,
      `${advisories.length} active upstream dissemination advisor${advisories.length === 1 ? "y" : "ies"}`,
    ),
  ]);
  for (const advisory of advisories) {
    const description = `${advisory.agency.toUpperCase()} — ${advisory.title}`;
    container.append(
      element(
        "p",
        null,
        advisory.url
          ? element("a", { href: advisory.url }, description)
          : description,
      ),
    );
    for (const productId of advisory.product_ids ?? []) {
      const marker = rows
        .get(productId)
        ?.querySelector('[data-slot="row-advisory"]');
      if (!marker) continue;
      marker.hidden = false;
      marker.textContent = `⚠ ${advisory.agency.toUpperCase()} advisory`;
    }
  }
  slot.append(container);
}

function renderSnapshot(app, snapshot, rows, now) {
  const local = document.body.classList.contains("pipeline-time-local");
  app.querySelector('[data-slot="time-control"]').hidden = false;
  app
    .querySelector('[data-slot="generated-at"]')
    .replaceChildren(timeNode(snapshot.generated_at));
  for (const product of productsOf(snapshot)) {
    const row = rows.get(product.id);
    if (row) hydrateRow(row, product, now, local);
  }
  renderAdvisories(app, snapshot.advisories ?? [], rows);
}

function historyTimestamp(value) {
  return value.replace(
    /T(\d{2})-(\d{2})-(\d{2})Z$/,
    "T$1:$2:$3Z",
  );
}

function start(app) {
  const base = app.dataset.assetsBase.replace(/\/$/, "");
  const dashboardUrl = `${base}/dashboard.json`;
  const historyIndexUrl = `${base}/history/index.json`;
  const rows = new Map();
  const ribbon = app.querySelector('[data-slot="ribbon"]');
  const banners = app.querySelector('[data-slot="banners"]');
  const timeToggle = app.querySelector("#status-time-toggle");
  const historyButton = app.querySelector("#pipeline-history-toggle");
  const historyPanel = app.querySelector("#pipeline-history-panel");
  const historyRange = app.querySelector("#pipeline-history-range");
  const scrubLabel = app.querySelector('[data-slot="scrub-label"]');
  const scrubError = app.querySelector('[data-slot="scrub-error"]');
  const returnLive = app.querySelector('[data-slot="return-live"]');
  const statusUrl = app.querySelector(".status-health").dataset.statusUrl;

  let latest = null;
  let mode = "live";
  let historyIndex = null;
  let pollTimer = null;
  let countdownTimer = null;
  let structureSignature = null;
  let displayedSnapshot = null;
  let displayedAt = null;

  function displaySnapshot(snapshot, now) {
    displayedSnapshot = snapshot;
    displayedAt = now;
    renderSnapshot(app, snapshot, rows, now);
  }

  function setTimeMode(local) {
    document.body.classList.toggle("pipeline-time-local", local);
    timeToggle.value = local ? "local" : "utc";
    if (displayedSnapshot) {
      displaySnapshot(
        displayedSnapshot,
        mode === "live" ? Date.now() : displayedAt,
      );
    }
    const selected = mode === "scrub" ? selectedTimestamp() : null;
    if (selected) updateScrubLabel(selected);
  }

  function showError(message) {
    banners.replaceChildren(
      element("div", { class: "pipeline-banner pipeline-banner--error" }, message),
    );
  }

  function applyLive() {
    const nextSignature = latest.groups
      .flatMap((group) => [group.id, ...group.products.map(({ id }) => id)])
      .join("\n");
    if (nextSignature !== structureSignature) {
      renderStructure(app, latest, rows);
      structureSignature = nextSignature;
    }
    banners.replaceChildren();
    ribbon.hidden =
      Date.now() - Date.parse(latest.generated_at) <= STALE_AFTER_MS;
    displaySnapshot(latest, Date.now());
  }

  async function fetchJson(url, cache = "default") {
    const response = await fetch(url, {
      cache,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function tick() {
    if (mode !== "live") return;
    try {
      const dashboard = validateDashboard(
        await fetchJson(dashboardUrl, "no-cache"),
      );
      if (mode !== "live") return;
      latest = dashboard;
      applyLive();
    } catch (error) {
      if (latest) {
        applyLive();
        showError(`Couldn't refresh pipeline status (${error.message}). Showing last-known state.`);
      } else {
        showError(`Couldn't load pipeline status (${error.message}).`);
      }
    }
  }

  async function loadSystemHealth() {
    try {
      renderHealth(
        app,
        "system-health",
        systemHealth(await fetchJson(statusUrl, "no-cache")),
      );
    } catch {
      renderHealth(app, "system-health", systemHealth(null));
    }
  }

  function selectedTimestamp() {
    if (!historyIndex?.length) return null;
    return historyIndex[historyIndex.length - 1 - Number(historyRange.value)];
  }

  function updateScrubLabel(timestamp) {
    const date = historyTimestamp(timestamp);
    scrubLabel.textContent = formatTime(
      date,
      document.body.classList.contains("pipeline-time-local"),
    );
    historyRange.setAttribute("aria-valuetext", scrubLabel.textContent);
    const max = Number(historyRange.max);
    const percent = max ? (Number(historyRange.value) / max) * 100 : 50;
    scrubLabel.style.setProperty("--thumb-pct", `${percent}%`);
    historyPanel.style.setProperty("--thumb-pct", `${percent}%`);
  }

  async function showSnapshot(timestamp) {
    try {
      const snapshot = await fetchJson(
        `${base}/history/${timestamp}.json`,
        "no-cache",
      );
      if (mode !== "scrub") return;
      displaySnapshot(snapshot, Date.parse(snapshot.generated_at));
      scrubError.hidden = true;
    } catch (error) {
      scrubError.hidden = false;
      scrubError.textContent = `Snapshot unavailable (${error.message}).`;
    }
  }

  async function openHistory() {
    historyPanel.hidden = false;
    historyButton.setAttribute("aria-expanded", "true");
    if (!historyIndex) {
      try {
        historyIndex = await fetchJson(historyIndexUrl, "no-cache");
        if (!Array.isArray(historyIndex) || historyIndex.length === 0) {
          throw new Error("empty history");
        }
      } catch (error) {
        scrubError.hidden = false;
        scrubError.textContent = `History unavailable (${error.message}).`;
        return;
      }
    }
    historyRange.max = historyIndex.length - 1;
    historyRange.value = historyIndex.length - 1;
    historyRange.disabled = false;
    updateScrubLabel(selectedTimestamp());
  }

  function resumeLive(close = false) {
    mode = "live";
    returnLive.hidden = true;
    ribbon.hidden = false;
    if (close) {
      historyPanel.hidden = true;
      historyButton.setAttribute("aria-expanded", "false");
    }
    tick();
    if (pollTimer == null) pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    if (countdownTimer == null) {
      countdownTimer = setInterval(updateLiveCountdowns, 1000);
    }
  }

  function updateLiveCountdowns() {
    if (mode !== "live" || !latest) return;
    const local = document.body.classList.contains("pipeline-time-local");
    const now = Date.now();
    for (const product of productsOf(latest)) {
      const row = rows.get(product.id);
      if (!row) continue;
      hydrateEta(row, product, now, local);
      const details = row.querySelector('[data-slot="details"]');
      if (!details.hidden) {
        details.replaceChildren(buildDetails(product, now, local));
      }
    }
  }

  historyButton.addEventListener("click", () => {
    if (historyPanel.hidden) openHistory();
    else if (mode === "scrub") resumeLive(true);
    else {
      historyPanel.hidden = true;
      historyButton.setAttribute("aria-expanded", "false");
    }
  });
  historyRange.addEventListener("input", () => {
    const timestamp = selectedTimestamp();
    if (!timestamp) return;
    updateScrubLabel(timestamp);
    if (Number(historyRange.value) === Number(historyRange.max)) {
      resumeLive();
      return;
    }
    mode = "scrub";
    clearInterval(pollTimer);
    pollTimer = null;
    clearInterval(countdownTimer);
    countdownTimer = null;
    ribbon.hidden = true;
    banners.replaceChildren();
    returnLive.hidden = false;
    showSnapshot(timestamp);
  });
  returnLive.addEventListener("click", () => resumeLive(true));
  app.addEventListener("click", (event) => {
    const button = event.target.closest('[data-slot="details-button"]');
    if (!button) return;
    const details = button
      .closest(".pipeline-row")
      .querySelector('[data-slot="details"]');
    details.hidden = !details.hidden;
    button.textContent = details.hidden ? "more details" : "less";
    button.setAttribute("aria-expanded", String(!details.hidden));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(pollTimer);
      pollTimer = null;
      clearInterval(countdownTimer);
      countdownTimer = null;
    } else if (mode === "live") {
      tick();
      pollTimer ??= setInterval(tick, POLL_INTERVAL_MS);
      countdownTimer ??= setInterval(updateLiveCountdowns, 1000);
    }
  });

  setTimeMode(setupTimeToggle(timeToggle, setTimeMode));
  loadSystemHealth();
  tick();
  setInterval(loadSystemHealth, HEALTH_REFRESH_INTERVAL_MS);
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  countdownTimer = setInterval(updateLiveCountdowns, 1000);
}

if (typeof document !== "undefined") {
  const app = document.querySelector("#pipeline-app");
  if (app) start(app);
}
