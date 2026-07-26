const POLL_INTERVAL_MS = 15_000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const TIME_MODE_KEY = "wxopticon:time-mode";
const DASHBOARD_VERSION = 1;

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
    }
  }
  return data;
}

export function agencySummary(advisories) {
  const active = advisories ?? [];
  if (active.length === 0) {
    return { state: "nominal", label: "nominal" };
  }
  const agencies = [...new Set(active.map(({ agency }) => agency.toUpperCase()))];
  return {
    state: "advisory",
    label: `${agencies.join(", ")} advisor${active.length === 1 ? "y" : "ies"}`,
  };
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

function initLabel(timestamp, local) {
  const { date, time } = initParts(timestamp, selectedTimeZone(local));
  return element("span", null, [element("strong", null, date), time]);
}

function formatTime(timestamp, local) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: local ? undefined : "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp));
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
    element("span", { class: "pipeline-time-utc" }, formatTime(timestamp, false)),
    element(
      "span",
      { class: "pipeline-time-local-only" },
      formatTime(timestamp, true),
    ),
  ]);
}

function groupSlices(groups) {
  const total = groups.at(-1)?.leads_expected ?? 0;
  let previousAvailable = 0;
  let previousExpected = 0;
  return groups.map((group) => {
    const expected = group.leads_expected - previousExpected;
    const available = group.leads_available - previousAvailable;
    previousExpected = group.leads_expected;
    previousAvailable = group.leads_available;
    return {
      ...group,
      height: total ? (expected / total) * 100 : 0,
      fill: expected ? Math.max(0, Math.min(100, (available / expected) * 100)) : 0,
    };
  });
}

export function barTooltip(init, local) {
  if (init.status === "unobserved") {
    return `${initShort(init.init_time, local)} · no probe visibility; not a publication failure`;
  }
  const state = init.timing ? `${init.status} · ${init.timing}` : init.status;
  const run = [
    initShort(init.init_time, local),
    state,
    init.completion_pct == null
      ? null
      : `${Math.round(init.completion_pct * 100)}%`,
    init.latency_s == null ? null : `latency ${formatLatency(init.latency_s)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!init.lead_groups?.length) return run;
  const groups = init.lead_groups.map((group) => {
    const groupState = group.timing
      ? `${group.status} · ${group.timing}`
      : group.status;
    const progress =
      group.status === "in_flight" && group.completion_pct != null
        ? ` ${Math.round(group.completion_pct * 100)}%`
        : "";
    return `${group.name} ${groupState}${progress}`;
  });
  return `${run}\n${groups.join(" · ")}`;
}

function renderBar(init, local) {
  const track = element("div", { class: "pipeline-bar-track" });
  if (init.lead_groups?.length) {
    let bottom = 0;
    for (const group of groupSlices(init.lead_groups)) {
      const segment = element(
        "div",
        {
          class: `pipeline-bar-segment g-${group.status}`,
          "data-group": group.name,
          "data-timing": group.timing,
          style: `--band-height:${group.height}%;--band-bottom:${bottom}%;--fill:${group.fill}%`,
          title:
            group.status === "pending"
              ? "Forecast horizon not yet published"
              : null,
        },
        element("div", { class: "pipeline-bar-segment-fill" }),
      );
      track.append(segment);
      bottom += group.height;
    }
  } else {
    track.append(
      element("div", {
        class: "pipeline-bar-fill",
        style: `--fill:${Math.max(0, Math.min(100, (init.completion_pct ?? 0) * 100))}%`,
      }),
    );
  }
  return element(
    "div",
    {
      class: "pipeline-bar",
      "data-init-time": init.init_time,
      "data-status": init.status,
      "data-timing": init.timing,
      title: barTooltip(init, local),
    },
    [
      track,
      element(
        "div",
        { class: "pipeline-bar-label" },
        initLabel(init.init_time, local),
      ),
    ],
  );
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
      const leadLabels = element("div", {
        class: "pipeline-lead-labels",
        "aria-hidden": "true",
      });
      for (const lead of product.lead_groups?.slice(1) ?? []) {
        leadLabels.append(
          element(
            "span",
            { style: `bottom:${lead.center_pct}%` },
            lead.label,
          ),
        );
      }

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
              element("div", null, product.source ?? "—"),
              element("div", null, `${product.cadence_hours ?? "—"}h init cadence`),
              element("div", null, `${product.init_hours?.join("/") || "—"}z`),
              advisory,
            ]),
          ]),
          element("div", { class: "pipeline-row-body" }, [
            leadLabels,
            element("div", { class: "pipeline-grid", "data-slot": "grid" }),
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
  const groups = running?.lead_groups ?? [];
  const initMs = running ? Date.parse(running.init_time) : 0;
  return {
    header: running ? initShort(running.init_time, local) : "waiting for next init",
    rows: product.lead_group_stats.map((stats, index) => {
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
  return element("table", null, [
    element("thead", null, [groupHead, head]),
    body,
  ]);
}

function hydrateRow(row, product, now, local) {
  row.querySelector('[data-slot="grid"]').replaceChildren(
    ...product.recent_inits.slice(-10).map((init) => renderBar(init, local)),
  );
  hydrateEta(row, product, now, local);

  const button = row.querySelector('[data-slot="details-button"]');
  const details = row.querySelector('[data-slot="details"]');
  if (product.lead_group_stats?.length) {
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
  const status = app.querySelector('[data-slot="agency-status"]');
  const summary = agencySummary(advisories);
  status.dataset.state = summary.state;
  status.querySelector("strong").textContent = summary.label;

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
  const timeToggle = app.querySelector("#pipeline-time-toggle");
  const historyButton = app.querySelector("#pipeline-history-toggle");
  const historyPanel = app.querySelector("#pipeline-history-panel");
  const historyRange = app.querySelector("#pipeline-history-range");
  const scrubLabel = app.querySelector('[data-slot="scrub-label"]');
  const scrubError = app.querySelector('[data-slot="scrub-error"]');
  const returnLive = app.querySelector('[data-slot="return-live"]');

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

  function setTimeMode(local, persist) {
    document.body.classList.toggle("pipeline-time-local", local);
    timeToggle.value = local ? "local" : "utc";
    if (persist) localStorage.setItem(TIME_MODE_KEY, local ? "local" : "utc");
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
    app.querySelector('[data-slot="window-days"]').textContent =
      latest.window_days ?? "—";
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

  timeToggle.addEventListener("change", () =>
    setTimeMode(timeToggle.value === "local", true),
  );
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

  setTimeMode(localStorage.getItem(TIME_MODE_KEY) === "local", false);
  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  countdownTimer = setInterval(updateLiveCountdowns, 1000);
}

if (typeof document !== "undefined") {
  const app = document.querySelector("#pipeline-app");
  if (app) start(app);
}
