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
  const ASSETS_BASE = "https://assets.dynamical.org/wxopticon";
  const SUMMARY_URL = `${ASSETS_BASE}/summary.json`;
  const POLL_INTERVAL_MS = 15_000;
  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min = 2× backend cadence
  const TIME_MODE_KEY = "wxopticon:timeMode";
  const RECENT_INIT_COUNT = 10;

  const HISTORY_INDEX_URL = `${ASSETS_BASE}/history/index.json`;
  const HISTORY_PREFIX = `${ASSETS_BASE}/history/`;
  const SCRUB_DEBOUNCE_MS = 200;

  const app = document.getElementById("wx-app");
  if (!app) return;

  const bannersSlot = app.querySelector('[data-slot="banners"]');
  const generatedAtSlot = app.querySelector('[data-slot="generated-at"]');
  const toggleSelect = document.getElementById("wx-time-toggle");

  const historyToggleBtn = document.getElementById("wx-history-toggle");
  const historyPanel = document.getElementById("wx-history-panel");
  const historyRange = document.getElementById("wx-history-range");
  const scrubLabelSlot = app.querySelector('[data-slot="scrub-label"]');
  const scrubErrorSlot = app.querySelector('[data-slot="scrub-error"]');
  const ribbonSlot = app.querySelector('[data-slot="ribbon"]');
  const ribbonTsSlot = app.querySelector('[data-slot="ribbon-ts"]');
  const ribbonReturnBtn = app.querySelector('[data-slot="ribbon-return"]');

  // mode is "live" (polling summary.json) or "scrub" (rendering a historical
  // snapshot picked via the slider). The render path is identical in both
  // modes; only the outer shell — polling, banners, countdown ticker, ribbon —
  // differs.
  let mode = "live";
  let latest = null;           // last successful live summary payload
  let lastFetchError = null;   // null if the most recent live fetch succeeded
  let pollTimer = null;
  let countdownTimer = null;

  // Scrub-mode state. historyIndex is loaded once per toggle-open session;
  // scrubSeq guards against late fetches overwriting newer ones during a
  // rapid drag.
  let historyIndex = null;
  let scrubDebounceTimer = null;
  let scrubSeq = 0;

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

  // Pure render: paint products + generated_at from a fully-loaded summary.
  // Does not touch banners, ribbons, or the countdown ticker — those are
  // owned by the outer shell and differ between live and scrub modes.
  function renderSnapshot(summary) {
    generatedAtSlot.replaceChildren(timeNode(summary.generated_at));
    for (const product of summary.products) {
      hydrateRow(product);
    }
  }

  // Live-mode render pass: banners + snapshot + countdowns against wall clock.
  function applyLive() {
    updateBanners(latest);
    renderSnapshot(latest);
    updateCountdowns(Date.now());
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

  // nowMs is the reference "now" against which countdowns tick. In live
  // mode the outer shell passes Date.now() each second; in scrub mode it's
  // called once with the snapshot's generated_at so the view is frozen to
  // that historical moment.
  function updateCountdowns(nowMs) {
    for (const node of app.querySelectorAll("[data-init-start]")) {
      const target = new Date(node.getAttribute("data-init-start")).getTime();
      const delta = Math.floor((target - nowMs) / 1000);
      node.textContent = delta <= 0 ? "processing" : "init in " + fmtDuration(delta);
    }
    for (const node of app.querySelectorAll("[data-next-complete]")) {
      const target = new Date(node.getAttribute("data-next-complete")).getTime();
      const delta = Math.floor((target - nowMs) / 1000);
      node.textContent = delta <= 0 ? "ETA any moment" : "ETA " + fmtDuration(delta);
    }
  }

  // ---- poll loop ------------------------------------------------------------

  async function tick() {
    if (mode !== "live") return;
    try {
      const resp = await fetch(SUMMARY_URL, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      latest = json;
      lastFetchError = null;
      applyLive();
    } catch (e) {
      lastFetchError = e.message || String(e);
      if (latest) {
        applyLive(); // keep last-good data, show error banner
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
      countdownTimer = setInterval(() => updateCountdowns(Date.now()), 1000);
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

  // Pause polling when the tab is hidden; immediate refetch when it comes
  // back (only in live mode — scrub mode owns its own DOM state).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else if (mode === "live") {
      tick();
      startPolling();
    }
  });

  // ---- scrub (history) mode ------------------------------------------------

  // URL-safe ISO "2026-04-15T12-30-00Z" -> real ISO "2026-04-15T12:30:00Z".
  // The history index uses hyphens in place of colons so keys are filesystem-
  // and URL-safe; reverse that for Date parsing and aria-valuetext display.
  function tsToIso(ts) {
    return ts.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
  }

  function fmtScrubLabel(ts) {
    const d = new Date(tsToIso(ts));
    // Respect the existing UTC/local toggle so the label reads the same as
    // the generated_at timestamp in the dashboard footer.
    const useLocal = document.body.classList.contains("status-time-local");
    return useLocal ? fmtLocal(d.toISOString()) : fmtUtc(d.toISOString());
  }

  function setScrubLabel(ts) {
    const text = fmtScrubLabel(ts);
    scrubLabelSlot.textContent = text;
    historyRange.setAttribute("aria-valuetext", text);
    const max = Number(historyRange.max) || 0;
    const value = Number(historyRange.value) || 0;
    const pct = max === 0 ? 50 : (value / max) * 100;
    scrubLabelSlot.style.setProperty("--thumb-pct", `${pct}%`);
  }

  function clearScrubError() {
    scrubErrorSlot.hidden = true;
    scrubErrorSlot.textContent = "";
  }

  function showScrubError(msg) {
    scrubErrorSlot.hidden = false;
    scrubErrorSlot.textContent = msg;
  }

  function showRibbon(ts) {
    ribbonTsSlot.textContent = fmtScrubLabel(ts);
    ribbonSlot.hidden = false;
  }

  function hideRibbon() {
    ribbonSlot.hidden = true;
  }

  // Fetch-and-render a historical snapshot, guarded by a sequence number so
  // a late response from an earlier drag position can't overwrite a newer
  // one. On failure the previous view is left in place.
  async function loadHistoricalSnapshot(ts) {
    const seq = ++scrubSeq;
    try {
      const resp = await fetch(HISTORY_PREFIX + ts + ".json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (seq !== scrubSeq || mode !== "scrub") return;
      renderSnapshot(json);
      updateCountdowns(new Date(json.generated_at).getTime());
      showRibbon(ts);
      clearScrubError();
    } catch (e) {
      if (seq !== scrubSeq || mode !== "scrub") return;
      showScrubError(`snapshot unavailable (${e.message || e})`);
    }
  }

  function scheduleScrubFetch(ts) {
    clearTimeout(scrubDebounceTimer);
    scrubDebounceTimer = setTimeout(() => loadHistoricalSnapshot(ts), SCRUB_DEBOUNCE_MS);
  }

  function currentSelectedTs() {
    if (!historyIndex || historyIndex.length === 0) return null;
    // Slider: 0 = oldest, max = newest. Index is newest-first.
    const idxFromEnd = Number(historyRange.value);
    return historyIndex[historyIndex.length - 1 - idxFromEnd];
  }

  async function openHistoryPanel() {
    historyPanel.hidden = false;
    historyToggleBtn.setAttribute("aria-expanded", "true");
    clearScrubError();
    if (historyIndex == null) {
      try {
        const resp = await fetch(HISTORY_INDEX_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (!Array.isArray(json) || json.length === 0) {
          throw new Error("empty history index");
        }
        historyIndex = json;
      } catch (e) {
        showScrubError(`history index unavailable (${e.message || e})`);
        return;
      }
    }
    historyRange.max = String(historyIndex.length - 1);
    historyRange.value = String(historyIndex.length - 1); // newest = live
    historyRange.disabled = false;
    setScrubLabel(currentSelectedTs());
  }

  function closeHistoryPanel() {
    historyPanel.hidden = true;
    historyToggleBtn.setAttribute("aria-expanded", "false");
    clearTimeout(scrubDebounceTimer);
    scrubDebounceTimer = null;
    scrubSeq++; // invalidate any in-flight scrub fetch
    clearScrubError();
  }

  function enterScrubMode() {
    if (mode === "scrub") return;
    mode = "scrub";
    stopPolling();
  }

  function returnToLive() {
    mode = "live";
    hideRibbon();
    closeHistoryPanel();
    if (latest) applyLive();
    tick();
    startPolling();
  }

  // History toggle: open panel (loads index once) or close it. Closing from
  // scrub mode also returns to live; closing from a no-op (just-opened and
  // not scrubbed away) is a visual no-op.
  historyToggleBtn.addEventListener("click", () => {
    const expanded = historyToggleBtn.getAttribute("aria-expanded") === "true";
    if (expanded) {
      if (mode === "scrub") {
        returnToLive();
      } else {
        closeHistoryPanel();
      }
    } else {
      openHistoryPanel();
    }
  });

  ribbonReturnBtn.addEventListener("click", returnToLive);

  // Slider input: update label immediately, schedule a debounced fetch.
  historyRange.addEventListener("input", () => {
    const ts = currentSelectedTs();
    if (!ts) return;
    setScrubLabel(ts);
    // Sliding back to the newest entry is "return to live"; treat it as a
    // live render (no scrub fetch) so the user can slam right to resume.
    const atNewest = Number(historyRange.value) === Number(historyRange.max);
    if (atNewest) {
      clearTimeout(scrubDebounceTimer);
      if (mode !== "live") returnToLive();
      return;
    }
    enterScrubMode();
    scheduleScrubFetch(ts);
  });

  // Shift + Arrow → ±10 snapshots. Native arrow-only stepping already works.
  historyRange.addEventListener("keydown", (e) => {
    if (!e.shiftKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const max = Number(historyRange.max);
    const cur = Number(historyRange.value);
    const delta = e.key === "ArrowLeft" ? -10 : 10;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    historyRange.value = String(next);
    historyRange.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Escape anywhere on the page returns to live (only meaningful while
  // scrubbed — no-op otherwise).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mode === "scrub") {
      e.preventDefault();
      returnToLive();
    }
  });

  // Kick off.
  tick();
  startPolling();
})();
