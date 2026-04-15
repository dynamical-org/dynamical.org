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

  const LOCAL_TZ_ABBR = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? "local";

  function setTimeMode(local, persist) {
    document.body.classList.toggle("status-time-local", local);
    if (toggleSelect) toggleSelect.value = local ? "local" : "utc";
    if (persist) localStorage.setItem(TIME_MODE_KEY, local ? "local" : "utc");
  }

  if (toggleSelect) {
    const localOption = toggleSelect.querySelector('option[value="local"]');
    if (localOption) localOption.textContent = `Local time (${LOCAL_TZ_ABBR})`;
    toggleSelect.addEventListener("change", () =>
      setTimeMode(toggleSelect.value === "local", true)
    );
  }

  setTimeMode(localStorage.getItem(TIME_MODE_KEY) === "local", false);

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
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${mm}-${dd} @ ${hh}:${mi} UTC`;
  }

  function fmtLocal(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} @ ${hh}:${mi} ${LOCAL_TZ_ABBR}`;
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

  function initShort(iso) {
    // Single-line label: "MM-DD HHz" (always UTC — the z suffix demands it).
    const d = new Date(iso);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    return `${mm}-${dd} ${hh}z`;
  }

  function etaTarget(product) {
    // The "ETA" for a product is whichever init is currently running
    // (init_time + p95), falling back to the next scheduled run's
    // p95-based completion when nothing's in progress.
    const p95 = product.latency_stats.p95_s;
    const inProgress = product.recent_inits.find((i) => i.status === "in_progress");
    if (inProgress && p95 != null) {
      const targetMs = new Date(inProgress.init_time).getTime() + p95 * 1000;
      return {
        initTime: inProgress.init_time,
        targetIso: new Date(targetMs).toISOString(),
        inProgress: true,
      };
    }
    if (product.next_expected_init && product.next_expected_completion_at) {
      return {
        initTime: product.next_expected_init,
        targetIso: product.next_expected_completion_at,
        inProgress: false,
      };
    }
    return null;
  }

  function fmtDuration(seconds) {
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return `${h}h ${m}m`;
    }
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
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

  function hydrateRow(product) {
    const row = app.querySelector(`.status-row[data-product-id="${product.id}"]`);
    if (!row) return;

    const grid = row.querySelector('[data-slot="grid"]');
    grid.replaceChildren(...product.recent_inits.slice(-RECENT_INIT_COUNT).map(renderBar));

    const latency = row.querySelector('[data-slot="latency"]');
    const stats = product.latency_stats;
    if (!stats.p99_s || stats.sample_init_count === 0) {
      latency.textContent = "baseline pending";
    } else {
      latency.replaceChildren(
        `p50 ${fmtLatency(stats.p50_s)}`, el("br"),
        `p95 ${fmtLatency(stats.p95_s)}`, el("br"),
        `p99 ${fmtLatency(stats.p99_s)}`,
      );
    }

    // Right column top: init label, state (processing | init in Xh Ym), ETA.
    // "processing" is static; "init in" ticks down to init_time and flips to
    // "processing" once elapsed (optimistic — next poll confirms).
    const eta = row.querySelector('[data-slot="eta"]');
    const target = etaTarget(product);
    if (target) {
      const stateNode = target.inProgress
        ? el("span", null, "processing")
        : el("span", { "data-init-start": target.initTime }, "init in —");
      eta.replaceChildren(
        el("strong", null, initShort(target.initTime)),
        stateNode,
        el("span", { "data-next-complete": target.targetIso }, "ETA —"),
      );
    } else {
      eta.replaceChildren("—");
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
    for (const node of app.querySelectorAll("[data-init-start]")) {
      const target = new Date(node.getAttribute("data-init-start")).getTime();
      const delta = Math.floor((target - now) / 1000);
      node.textContent = delta <= 0 ? "processing" : "init in " + fmtDuration(delta);
    }
    for (const node of app.querySelectorAll("[data-next-complete]")) {
      const target = new Date(node.getAttribute("data-next-complete")).getTime();
      const delta = Math.floor((target - now) / 1000);
      node.textContent = delta <= 0 ? "ETA any moment" : "ETA " + fmtDuration(delta);
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
