// wxopticon arrival dashboard — client-side poller.
//
// Fetches https://assets.dynamical.org/wxopticon/summary.json every 15s,
// re-renders the #wx-app container using DOM APIs (no innerHTML, no
// framework), updates countdowns every second, and surfaces a
// stale-backend banner if generated_at is >10min old.

(() => {
  // Production fetches cross-origin from the R2-backed asset host; the R2
  // CORS policy allows https://dynamical.org. Local dev can't use that URL
  // (localhost isn't in the allowlist and shouldn't be — it's a prod bucket),
  // so fall back to a fixture served from the same origin. Run
  // `curl -o public/wxopticon-dev-sample.json https://assets.dynamical.org/wxopticon/summary.json`
  // to refresh the fixture.
  const SUMMARY_URL =
    location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "/wxopticon-dev-sample.json"
      : "https://assets.dynamical.org/wxopticon/summary.json";
  const POLL_INTERVAL_MS = 15_000;
  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min = 2× backend cadence
  const TIME_MODE_KEY = "wxopticon:timeMode";

  const app = document.getElementById("wx-app");
  if (!app) return;

  let latest = null;           // last successful summary payload
  let lastFetchError = null;   // null if the most recent fetch succeeded
  let pollTimer = null;
  let countdownTimer = null;

  // ---- DOM helper -----------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    const kids = children == null ? [] : [].concat(children);
    for (const child of kids) {
      if (child == null || child === false) continue;
      node.appendChild(
        typeof child === "string" || typeof child === "number"
          ? document.createTextNode(String(child))
          : child
      );
    }
    return node;
  }

  // ---- time mode (UTC <-> local toggle) -------------------------------------

  function applyInitialTimeMode() {
    const mode = localStorage.getItem(TIME_MODE_KEY);
    if (mode === "local") document.body.classList.add("wx-time-local");
  }

  function toggleTimeMode() {
    const local = document.body.classList.toggle("wx-time-local");
    localStorage.setItem(TIME_MODE_KEY, local ? "local" : "utc");
  }

  applyInitialTimeMode();

  // ---- formatting -----------------------------------------------------------

  function fmtLatency(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "—";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  function fmtPercent(pct) {
    if (pct == null) return "—";
    return `${Math.round(pct * 100)}%`;
  }

  function fmtUtc(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("en-GB", {
      timeZone: "UTC",
      hour12: false,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }) + " UTC";
  }

  function fmtLocal(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      hour12: false,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  function timeNode(iso) {
    // Returns a span containing two children: a .t-utc and a .t-local.
    // CSS hides whichever doesn't match body.wx-time-local.
    return el("span", null, [
      el("span", { class: "t-utc" }, fmtUtc(iso)),
      el("span", { class: "t-local" }, fmtLocal(iso)),
    ]);
  }

  function initLabel(iso) {
    // Two-line compact label under each bar: MM-DD / HHz
    const d = new Date(iso);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    return el("span", null, [
      el("strong", null, `${mm}-${dd}`),
      `${hh}z`,
    ]);
  }

  function fmtCountdown(targetMs, nowMs) {
    const delta = Math.floor((targetMs - nowMs) / 1000);
    if (delta <= 0) return "running now";
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    const s = delta % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // ---- render ---------------------------------------------------------------

  function renderBar(init) {
    const fill = Math.max(0, Math.min(100, (init.completion_pct ?? 0) * 100));
    const summary = [
      init.init_time.slice(5, 16).replace("T", " ") + "z",
      init.status,
      fmtPercent(init.completion_pct),
      init.latency_s != null ? `latency ${fmtLatency(init.latency_s)}` : null,
    ].filter(Boolean).join(" · ");
    return el(
      "div",
      {
        class: "wx-bar",
        "data-status": init.status,
        tabindex: "0",
        title: summary,
      },
      [
        el("div", { class: "wx-bar-track" }, [
          el("div", { class: "wx-bar-fill", style: `--fill: ${fill}%` }),
        ]),
        el("div", { class: "wx-bar-label" }, initLabel(init.init_time)),
      ]
    );
  }

  function renderLatencyStrip(stats) {
    const cell = (label, v) =>
      el("div", null, [el("dt", null, label), el("dd", null, fmtLatency(v))]);
    const attrs = { class: "wx-latency-strip" };
    if (stats.sample_init_count === 0) {
      attrs.title = "baseline pending — needs completed inits";
    }
    return el("dl", attrs, [
      cell("p50", stats.p50_s),
      cell("p95", stats.p95_s),
      cell("p99", stats.p99_s),
    ]);
  }

  function renderRow(product) {
    const nextCompletionNode = product.next_expected_completion_at
      ? el("div", { class: "wx-stats-meta" }, [
          "next complete ",
          timeNode(product.next_expected_completion_at),
        ])
      : el("div", { class: "wx-stats-meta" }, "next complete —");

    return el("section", { class: "wx-row" }, [
      el("div", { class: "wx-row-label" }, [
        el("div", { class: "wx-row-label-name" }, product.label),
        el(
          "div",
          { class: "wx-row-label-source" },
          `${product.source} · ${product.cadence_hours}h cadence`
        ),
        el(
          "div",
          { class: "wx-stats-meta", "data-next-init": product.next_expected_init },
          "next run —"
        ),
      ]),
      el(
        "div",
        { class: "wx-grid" },
        product.recent_inits.map(renderBar)
      ),
      el("div", { class: "wx-stats" }, [
        renderLatencyStrip(product.latency_stats),
        el(
          "div",
          { class: "wx-stats-meta" },
          `${product.latency_stats.sample_init_count} samples`
        ),
        nextCompletionNode,
      ]),
    ]);
  }

  function renderApp(summary) {
    const generatedAt = new Date(summary.generated_at).getTime();
    const stale = Date.now() - generatedAt > STALE_THRESHOLD_MS;

    const children = [];
    if (stale) {
      children.push(
        el(
          "div",
          { class: "wx-stale-banner" },
          "Backend data is more than 10 minutes old — it may be stalled."
        )
      );
    }
    if (lastFetchError) {
      children.push(
        el(
          "div",
          { class: "wx-error-banner" },
          `Couldn't refresh (${lastFetchError}). Showing last-known state.`
        )
      );
    }

    const toggleBtn = el(
      "button",
      { type: "button", class: "wx-time-toggle", id: "wx-time-toggle" },
      [
        "Toggle time: ",
        el("span", { class: "t-utc" }, "UTC"),
        el("span", { class: "t-local" }, "local"),
      ]
    );
    toggleBtn.addEventListener("click", toggleTimeMode);
    children.push(toggleBtn);

    for (const product of summary.products) {
      children.push(renderRow(product));
    }

    children.push(
      el("footer", { class: "wx-footer" }, [
        el("div", null, ["Updated ", timeNode(summary.generated_at)]),
        el(
          "div",
          null,
          `${summary.window_days}-day rolling window · polls every ${POLL_INTERVAL_MS / 1000}s`
        ),
      ])
    );

    app.replaceChildren(...children);
    updateCountdowns();
  }

  function renderLoadingFailed(error) {
    app.replaceChildren(
      el("div", { class: "wx-error-banner" }, [
        "Couldn't load arrival status from ",
        el("code", null, SUMMARY_URL),
        ": " + String(error),
      ]),
      el(
        "p",
        { class: "wx-loading" },
        `Retrying in ${POLL_INTERVAL_MS / 1000}s…`
      )
    );
  }

  // ---- countdowns -----------------------------------------------------------

  function updateCountdowns() {
    const now = Date.now();
    for (const node of app.querySelectorAll("[data-next-init]")) {
      const iso = node.getAttribute("data-next-init");
      if (!iso) continue;
      const target = new Date(iso).getTime();
      node.textContent = "next run " + fmtCountdown(target, now);
    }
  }

  // ---- poll loop ------------------------------------------------------------

  async function tick() {
    try {
      const resp = await fetch(SUMMARY_URL, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      latest = json;
      lastFetchError = null;
      renderApp(latest);
    } catch (e) {
      lastFetchError = e.message || String(e);
      if (latest) {
        renderApp(latest); // keep last-good data, show error banner
      } else {
        renderLoadingFailed(e);
      }
    }
  }

  function startPolling() {
    if (pollTimer == null) {
      pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    }
    if (countdownTimer == null) {
      countdownTimer = setInterval(updateCountdowns, 1000);
    }
  }

  function stopPolling() {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (countdownTimer != null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // Pause polling when the tab is hidden; immediate refetch when it comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else {
      tick();
      startPolling();
    }
  });

  // Kick off.
  tick();
  startPolling();
})();
