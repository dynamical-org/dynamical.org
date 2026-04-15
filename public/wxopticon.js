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

  const app = document.getElementById("status-app");
  if (!app) return;

  const bannersSlot = app.querySelector('[data-slot="banners"]');
  const generatedAtSlot = app.querySelector('[data-slot="generated-at"]');
  const toggleSelect = document.getElementById("status-time-toggle");

  const historyToggleBtn = document.getElementById("status-history-toggle");
  const historyPanel = document.getElementById("status-history-panel");
  const historyRange = document.getElementById("status-history-range");
  const scrubLabelSlot = app.querySelector('[data-slot="scrub-label"]');
  const scrubErrorSlot = app.querySelector('[data-slot="scrub-error"]');
  const ribbonSlot = app.querySelector('[data-slot="ribbon"]');
  const returnLiveBtn = app.querySelector('[data-slot="return-live"]');

  let mode = "live";           // "live" = polling summary.json, "scrub" = frozen historical snapshot
  let latest = null;           // last successful live summary payload
  let lastFetchError = null;   // null if the most recent live fetch succeeded
  let pollTimer = null;
  let countdownTimer = null;

  let historyIndex = null;
  let scrubBusy = false;       // true while a historical fetch is in flight
  let scrubPendingTs = null;   // latest ts seen during an in-flight fetch
  let scrubSeq = 0;            // guards against late fetches clobbering newer ones

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
    toggleSelect.addEventListener("change", () => {
      setTimeMode(toggleSelect.value === "local", true);
      // Scrub label is plain text, not a dual-span timeNode, so the
      // body-class toggle doesn't reformat it.
      if (!historyPanel.hidden) {
        const ts = currentSelectedTs();
        if (ts) setScrubLabel(ts);
      }
    });
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
    const initText = init.init_time.slice(5, 16).replace("T", " ") + "z";
    // Unobserved = monitoring-coverage gap, not a publication failure.
    // Give it a plain-English tooltip so it isn't mistaken for "failed".
    const summary = init.status === "unobserved"
      ? `${initText} · no data observed — wxopticon had no probe visibility for this init during its monitoring window (not a publication failure)`
      : [
          initText,
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
    ribbonSlot.hidden = Date.now() - generatedAt <= STALE_THRESHOLD_MS;
    if (lastFetchError) {
      bannersSlot.replaceChildren(
        el(
          "div",
          { class: "status-banner status-banner--error" },
          `Couldn't refresh (${lastFetchError}). Showing last-known state.`
        )
      );
    } else {
      bannersSlot.replaceChildren();
    }
  }

  // Pure render: paint products + generated_at from a fully-loaded summary.
  // Banners, ribbon, and the countdown ticker are owned by the outer shell
  // and differ between live and scrub modes.
  function renderSnapshot(summary) {
    generatedAtSlot.replaceChildren(timeNode(summary.generated_at));
    for (const product of summary.products) {
      hydrateRow(product);
    }
  }

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

  // nowMs is the reference clock: Date.now() in live mode (ticked every
  // second), or the snapshot's generated_at in scrub mode (frozen).
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
      // Mode may have flipped to "scrub" while we were awaiting; abandon the
      // result so we don't stomp the historical snapshot the user just loaded.
      if (mode !== "live") return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (mode !== "live") return;
      latest = json;
      lastFetchError = null;
      applyLive();
    } catch (e) {
      if (mode !== "live") return;
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

  // Pause polling when the tab is hidden; immediate refetch when it comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else if (mode === "live") {
      tick();
      startPolling();
    }
  });

  // ---- scrub (history) mode ------------------------------------------------

  // The history index uses hyphens in place of colons so keys are filesystem-
  // and URL-safe ("2026-04-15T12-30-00Z"); reverse that for Date parsing.
  function fmtScrubLabel(ts) {
    const iso = ts.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
    const useLocal = document.body.classList.contains("status-time-local");
    return useLocal ? fmtLocal(iso) : fmtUtc(iso);
  }

  function setScrubLabel(ts) {
    const text = fmtScrubLabel(ts);
    scrubLabelSlot.textContent = text;
    historyRange.setAttribute("aria-valuetext", text);
    const max = Number(historyRange.max);
    const pct = max === 0 ? 50 : (Number(historyRange.value) / max) * 100;
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

  async function loadHistoricalSnapshot(ts) {
    const seq = ++scrubSeq;
    try {
      const resp = await fetch(HISTORY_PREFIX + ts + ".json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (seq !== scrubSeq || mode !== "scrub") return;
      renderSnapshot(json);
      updateCountdowns(new Date(json.generated_at).getTime());
      clearScrubError();
    } catch (e) {
      if (seq !== scrubSeq || mode !== "scrub") return;
      showScrubError(`snapshot unavailable (${e.message || e})`);
    }
  }

  // Coalescing scheduler: fire immediately so the bars update live as the
  // user drags, but only ever have one fetch in flight. Events that arrive
  // while busy collapse into scrubPendingTs, which fires once the current
  // fetch resolves — guaranteeing we always land on the final drag position.
  async function scheduleScrubFetch(ts) {
    if (scrubBusy) {
      scrubPendingTs = ts;
      return;
    }
    scrubBusy = true;
    scrubPendingTs = null;
    try {
      await loadHistoricalSnapshot(ts);
    } finally {
      scrubBusy = false;
      if (scrubPendingTs != null && mode === "scrub") {
        const next = scrubPendingTs;
        scrubPendingTs = null;
        scheduleScrubFetch(next);
      }
    }
  }

  function currentSelectedTs() {
    if (!historyIndex || historyIndex.length === 0) return null;
    // Slider: 0 = oldest, max = newest. Index is newest-first.
    return historyIndex[historyIndex.length - 1 - Number(historyRange.value)];
  }

  async function openHistoryPanel() {
    historyPanel.hidden = false;
    historyToggleBtn.setAttribute("aria-expanded", "true");
    clearScrubError();
    if (historyIndex == null) {
      try {
        const resp = await fetch(HISTORY_INDEX_URL);
        // User may have closed the panel while we were awaiting. Bail so we
        // don't dirty a hidden slider's state.
        if (historyPanel.hidden) return;
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (historyPanel.hidden) return;
        if (!Array.isArray(json) || json.length === 0) {
          throw new Error("empty history index");
        }
        historyIndex = json;
      } catch (e) {
        if (historyPanel.hidden) return;
        showScrubError(`history index unavailable (${e.message || e})`);
        return;
      }
    }
    historyRange.max = historyIndex.length - 1;
    historyRange.value = historyIndex.length - 1; // newest = live
    historyRange.disabled = false;
    setScrubLabel(currentSelectedTs());
  }

  function closeHistoryPanel() {
    historyPanel.hidden = true;
    historyToggleBtn.setAttribute("aria-expanded", "false");
    scrubPendingTs = null;
    scrubSeq++; // invalidate any in-flight scrub fetch
    clearScrubError();
  }

  // Flip back to live mode without touching the history panel. Used when the
  // user slides the thumb back to the newest entry — the panel stays open so
  // the drag isn't interrupted mid-interaction.
  function resumeLive() {
    mode = "live";
    returnLiveBtn.hidden = true;
    scrubPendingTs = null;
    scrubSeq++; // invalidate any in-flight scrub fetch
    clearScrubError();
    if (latest) applyLive();
    tick();
    startPolling();
  }

  function returnToLive() {
    resumeLive();
    closeHistoryPanel();
  }

  historyToggleBtn.addEventListener("click", () => {
    const expanded = historyToggleBtn.getAttribute("aria-expanded") === "true";
    if (!expanded) {
      openHistoryPanel();
    } else if (mode === "scrub") {
      returnToLive();
    } else {
      closeHistoryPanel();
    }
  });

  returnLiveBtn.addEventListener("click", returnToLive);

  historyRange.addEventListener("input", () => {
    const ts = currentSelectedTs();
    if (!ts) return;
    setScrubLabel(ts);
    // Sliding back to the newest entry resumes live without closing the
    // panel — so an active drag isn't interrupted.
    if (Number(historyRange.value) === Number(historyRange.max)) {
      if (mode !== "live") resumeLive();
      return;
    }
    if (mode !== "scrub") {
      mode = "scrub";
      stopPolling();
      // Live-mode stale/error warnings don't apply to a frozen snapshot.
      ribbonSlot.hidden = true;
      bannersSlot.replaceChildren();
      returnLiveBtn.hidden = false;
    }
    scheduleScrubFetch(ts);
  });

  // Shift + Arrow → ±10 snapshots. Native arrow-only stepping already works.
  historyRange.addEventListener("keydown", (e) => {
    if (!e.shiftKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const max = Number(historyRange.max);
    const cur = Number(historyRange.value);
    const next = Math.max(0, Math.min(max, cur + (e.key === "ArrowLeft" ? -10 : 10)));
    if (next === cur) return;
    historyRange.value = next;
    historyRange.dispatchEvent(new Event("input", { bubbles: true }));
  });

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
