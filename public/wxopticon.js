// wxopticon arrival dashboard — client-side hydration.
//
// The row skeleton (one <section> per product, with empty [data-slot=…]
// nodes) is emitted at build time by content/wxopticon.njk from
// _data/wxopticon.js. This script fetches the same summary.json at
// runtime every 15s and hydrates the slots in place.

(() => {
  // R2's CORS policy on the web-assets bucket allows https://dynamical.org
  // and http://localhost:8081 (the default 11ty dev-server port), so both
  // production and local `npm start` can fetch the same URL. If you run
  // `npm start` on a different port, add it to the R2 CORS allowlist via
  // the Cloudflare dashboard.
  const SUMMARY_URL = "https://assets.dynamical.org/wxopticon/summary.json";
  const POLL_INTERVAL_MS = 15_000;
  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min = 2× backend cadence
  const TIME_MODE_KEY = "wxopticon:timeMode";
  const RECENT_INIT_COUNT = 10;

  const app = document.getElementById("wx-app");
  if (!app) return;

  const bannersSlot = app.querySelector('[data-slot="banners"]');
  const generatedAtSlot = app.querySelector('[data-slot="generated-at"]');
  const toggleSelect = document.getElementById("wx-time-toggle");

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
    const local = mode === "local";
    document.body.classList.toggle("status-time-local", local);
    if (toggleSelect) toggleSelect.value = local ? "local" : "utc";
  }

  function onTimeModeChange() {
    const local = toggleSelect.value === "local";
    document.body.classList.toggle("status-time-local", local);
    localStorage.setItem(TIME_MODE_KEY, local ? "local" : "utc");
  }

  if (toggleSelect) {
    const tzAbbr = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "local";
    const localOption = toggleSelect.querySelector('option[value="local"]');
    if (localOption) localOption.textContent = `Local time (${tzAbbr})`;
    toggleSelect.addEventListener("change", onTimeModeChange);
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
    // CSS hides whichever doesn't match body.status-time-local.
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

  // ---- hydration ------------------------------------------------------------

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
        class: "status-bar",
        "data-status": init.status,
        tabindex: "0",
        title: summary,
      },
      [
        el("div", { class: "status-bar-track" }, [
          el("div", { class: "status-bar-fill", style: `--fill: ${fill}%` }),
        ]),
        el("div", { class: "status-bar-label" }, initLabel(init.init_time)),
      ]
    );
  }

  function renderLatencyRows(stats) {
    if (!stats.p99_s || stats.sample_init_count === 0) {
      return el("span", null, "baseline pending");
    }
    return el("dl", { class: "status-latency-rows" }, [
      el("dt", null, "p50"), el("dd", null, fmtLatency(stats.p50_s)),
      el("dt", null, "p95"), el("dd", null, fmtLatency(stats.p95_s)),
      el("dt", null, "p99"), el("dd", null, fmtLatency(stats.p99_s)),
    ]);
  }

  function hydrateRow(product) {
    const row = app.querySelector(`.status-row[data-product-id="${product.id}"]`);
    if (!row) return;

    const grid = row.querySelector('[data-slot="grid"]');
    grid.replaceChildren(...product.recent_inits.slice(-RECENT_INIT_COUNT).map(renderBar));

    const latency = row.querySelector('[data-slot="latency"]');
    latency.replaceChildren(renderLatencyRows(product.latency_stats));

    const samples = row.querySelector('[data-slot="samples"]');
    samples.textContent = `Based on ${product.latency_stats.sample_init_count} records`;

    const nextComplete = row.querySelector('[data-slot="next-complete"]');
    if (product.next_expected_completion_at) {
      nextComplete.replaceChildren(
        "Next complete ",
        timeNode(product.next_expected_completion_at)
      );
    } else {
      nextComplete.textContent = "Next complete —";
    }

    const nextRun = row.querySelector('[data-slot="next-run"]');
    if (product.next_expected_init) {
      nextRun.setAttribute("data-next-init", product.next_expected_init);
    } else {
      nextRun.removeAttribute("data-next-init");
      nextRun.textContent = "Next run —";
    }
  }

  function updateBanners(summary) {
    const generatedAt = new Date(summary.generated_at).getTime();
    const stale = Date.now() - generatedAt > STALE_THRESHOLD_MS;

    const children = [];
    if (stale) {
      children.push(
        el(
          "div",
          { class: "status-banner status-banner--stale" },
          "Backend data is more than 10 minutes old — it may be stalled."
        )
      );
    }
    if (lastFetchError) {
      children.push(
        el(
          "div",
          { class: "status-banner status-banner--error" },
          `Couldn't refresh (${lastFetchError}). Showing last-known state.`
        )
      );
    }
    bannersSlot.replaceChildren(...children);
  }

  function hydrate(summary) {
    updateBanners(summary);
    generatedAtSlot.replaceChildren(timeNode(summary.generated_at));
    for (const product of summary.products) {
      hydrateRow(product);
    }
    updateCountdowns();
  }

  function showLoadError(error) {
    // Leaves the build-time skeleton visible and posts an error banner.
    bannersSlot.replaceChildren(
      el("div", { class: "status-banner status-banner--error" }, [
        "Couldn't load arrival status from ",
        el("code", null, SUMMARY_URL),
        ": " + String(error),
      ])
    );
  }

  // ---- countdowns -----------------------------------------------------------

  function updateCountdowns() {
    const now = Date.now();
    for (const node of app.querySelectorAll("[data-next-init]")) {
      const iso = node.getAttribute("data-next-init");
      if (!iso) continue;
      const target = new Date(iso).getTime();
      node.textContent = "Next run " + fmtCountdown(target, now);
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
      hydrate(latest);
    } catch (e) {
      lastFetchError = e.message || String(e);
      if (latest) {
        hydrate(latest); // keep last-good data, show error banner
      } else {
        showLoadError(e);
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
