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
      // Scrub label and the ETA absolute-time prefix are plain text, not
      // dual-span timeNodes, so the body-class toggle doesn't reformat them.
      if (!historyPanel.hidden) {
        const ts = currentSelectedTs();
        if (ts) setScrubLabel(ts);
      }
      updateCountdowns(lastCountdownNow);
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
    //
    // Below-threshold products (n < min_samples → null p95) still get an
    // entry with a null targetIso so the init label and "processing" /
    // "pending" text render — just without an ETA line.
    const p95 = product.latency_stats.p95_s;
    const inProgress = product.recent_inits.findLast((i) => i.status === "processing");
    if (inProgress) {
      const targetIso = p95 != null
        ? new Date(new Date(inProgress.init_time).getTime() + p95 * 1000).toISOString()
        : null;
      return { initTime: inProgress.init_time, targetIso, inProgress: true };
    }
    if (product.next_expected_init) {
      return {
        initTime: product.next_expected_init,
        targetIso: product.next_expected_completion_at ?? null,
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

  function barFill(init) {
    return Math.max(0, Math.min(100, (init.completion_pct ?? 0) * 100));
  }

  // Backend values in lead_groups are cumulative (group i covers leads
  // 0..max_lead[i]). Diff consecutive groups to get the per-slice heights
  // (share of total leads) and fills (share of leads arrived in that slice).
  function groupSlices(leadGroups) {
    const total = leadGroups[leadGroups.length - 1].leads_expected;
    let prevAvail = 0;
    let prevExp = 0;
    return leadGroups.map((g) => {
      const sliceExp = g.leads_expected - prevExp;
      const sliceAvail = g.leads_available - prevAvail;
      prevAvail = g.leads_available;
      prevExp = g.leads_expected;
      const heightPct = total > 0 ? (sliceExp / total) * 100 : 0;
      const fillPct = sliceExp > 0 ? Math.max(0, Math.min(100, (sliceAvail / sliceExp) * 100)) : 0;
      return { name: g.name, key: timednessKey(g), heightPct, fillPct };
    });
  }

  // Collapses the (status, on_timedness) pair into a single string used as
  // both the segment CSS class suffix (`g-${key}`) and the details-table
  // class suffix (`eta-g-${key}`). One of:
  //   on_time, late, on_track, delayed, insufficient_data, unobserved,
  //   not_started, failed.
  function timednessKey(node) {
    return node.on_timedness ?? node.status;
  }

  function renderGroupSegments(init) {
    const slices = groupSlices(init.lead_groups);
    let bottom = 0;
    return slices.map((s) => {
      const seg = el("div", {
        class: `status-bar-fill-group g-${s.key}`,
        "data-group": s.name,
        style: `--band-height: ${s.heightPct}%; --band-bottom: ${bottom}%; --fill: ${s.fillPct}%;`,
      }, [
        el("div", { class: "status-bar-fill-inner" }),
      ]);
      bottom += s.heightPct;
      return seg;
    });
  }

  function renderTrackContents(init) {
    if (init.lead_groups && init.lead_groups.length > 0) {
      return renderGroupSegments(init);
    }
    return [el("div", { class: "status-bar-fill", style: `--fill: ${barFill(init)}%` })];
  }

  // Unobserved = monitoring-coverage gap, not a publication failure.
  // Give it a plain-English tooltip so it isn't mistaken for "failed".
  function barTooltip(init) {
    const initText = init.init_time.slice(5, 16).replace("T", " ") + "z";
    if (init.status === "unobserved") {
      return `${initText} · no data observed — wxopticon had no probe visibility for this init during its monitoring window (not a publication failure)`;
    }
    const stateText = init.on_timedness ? `${init.status} · ${init.on_timedness}` : init.status;
    const base = [
      initText,
      stateText,
      fmtPercent(init.completion_pct),
      init.latency_s != null ? `latency ${fmtLatency(init.latency_s)}` : null,
    ].filter(Boolean).join(" · ");
    if (!init.lead_groups || init.lead_groups.length === 0) return base;
    const groupParts = init.lead_groups.map((g) => {
      const gState = g.on_timedness ?? g.status;
      return g.status === "processing"
        ? `${g.name} ${gState} ${fmtPercent(g.completion_pct)}`
        : `${g.name} ${gState}`;
    });
    return `${base}\n${groupParts.join(" · ")}`;
  }

  function applyOnTimedness(bar, init) {
    if (init.on_timedness) {
      bar.setAttribute("data-on-timedness", init.on_timedness);
    } else {
      bar.removeAttribute("data-on-timedness");
    }
  }

  function renderBar(init) {
    const bar = el(
      "div",
      {
        class: "status-bar",
        "data-init-time": init.init_time,
        "data-status": init.status,
        title: barTooltip(init),
      },
      [
        el("div", { class: "status-bar-track" }, renderTrackContents(init)),
        el("div", { class: "status-bar-label" }, initLabel(init.init_time)),
      ]
    );
    applyOnTimedness(bar, init);
    return bar;
  }

  // Mutate an existing bar in place so CSS transitions animate the fill
  // height instead of the bar flashing fresh on every poll.
  function updateBar(bar, init) {
    bar.setAttribute("data-status", init.status);
    bar.setAttribute("title", barTooltip(init));
    applyOnTimedness(bar, init);

    const segments = bar.querySelectorAll(".status-bar-fill-group");
    const hasGroups = init.lead_groups && init.lead_groups.length > 0;
    if (hasGroups && segments.length === init.lead_groups.length) {
      const slices = groupSlices(init.lead_groups);
      segments.forEach((seg, i) => {
        const s = slices[i];
        seg.style.setProperty("--fill", `${s.fillPct}%`);
        seg.className = `status-bar-fill-group g-${s.key}`;
      });
      return;
    }

    const singleFill = bar.querySelector(".status-bar-fill");
    if (!hasGroups && singleFill) {
      singleFill.style.setProperty("--fill", `${barFill(init)}%`);
      return;
    }

    // Structure changed (old→new snapshot shape) — rebuild the track contents.
    const track = bar.querySelector(".status-bar-track");
    if (track) track.replaceChildren(...renderTrackContents(init));
  }

  function hydrateRow(product) {
    const row = app.querySelector(`.status-row[data-product-id="${product.id}"]`);
    if (!row) return;

    const grid = row.querySelector('[data-slot="grid"]');
    const inits = product.recent_inits.slice(-RECENT_INIT_COUNT);
    const bars = grid.querySelectorAll(".status-bar");
    // Fall back to a full rebuild on first hydration (still showing skeletons)
    // or if the bar count changed. Otherwise update in place — but recreate
    // any bar whose init_time rotated so the new init appears fresh rather
    // than shrinking-and-relabeling out of the old one.
    if (bars.length !== inits.length || grid.querySelector("[data-skeleton]")) {
      grid.replaceChildren(...inits.map(renderBar));
    } else {
      inits.forEach((init, i) => {
        if (bars[i].dataset.initTime === init.init_time) {
          updateBar(bars[i], init);
        } else {
          bars[i].replaceWith(renderBar(init));
        }
      });
    }

    // const latency = row.querySelector('[data-slot="latency"]');
    // const stats = product.latency_stats;
    // if (!stats.p99_s || stats.sample_init_count === 0) {
    //   latency.textContent = "baseline pending";
    // } else {
    //   latency.replaceChildren(
    //     `p50 ${fmtLatency(stats.p50_s)}`, el("br"),
    //     `p95 ${fmtLatency(stats.p95_s)}`, el("br"),
    //     `p99 ${fmtLatency(stats.p99_s)}`,
    //   );
    // }

    // "init in" ticks down to init_time and flips to "processing" once
    // elapsed (optimistic — next poll confirms). The eta-line slot is
    // updated by updateCountdowns on the next tick.
    const initSlot = row.querySelector('[data-slot="eta-init"]');
    const stateSlot = row.querySelector('[data-slot="eta-state"]');
    const lineSlot = row.querySelector('[data-slot="eta-line"]');
    const detailsBtn = row.querySelector('[data-slot="row-details-btn"]');
    const detailsSlot = row.querySelector('[data-slot="row-details"]');
    const target = etaTarget(product);
    if (!target) {
      initSlot.textContent = "—";
      stateSlot.hidden = true;
      stateSlot.removeAttribute("data-init-start");
      lineSlot.hidden = true;
      lineSlot.removeAttribute("data-next-complete");
      // Keep details button visible for latency stats even without an ETA target.
    }
    if (target) {
      initSlot.textContent = initShort(target.initTime);
      stateSlot.hidden = false;
      const inProgress = product.recent_inits.findLast((i) => i.status === "processing");
      if (target.inProgress) {
        // "processing" vs "pending" mirrors the details-table labels: if no
        // lead has arrived yet the run reads as "pending" even though the
        // backend status is `processing`. Once any group observes progress
        // we flip to "processing", with a `· on track` / `· delayed`
        // qualifier when on_timedness is decisive. insufficient_data
        // (baseline missing) always reads as plain "processing" — we know
        // the run is in flight, we just can't judge timeliness.
        const observed = (inProgress?.completion_pct ?? 0) > 0;
        const label = observed ? "processing" : "pending";
        const suffix = {
          on_track: " · on track",
          delayed: " · delayed",
        }[inProgress?.on_timedness] ?? "";
        stateSlot.textContent = `${label}${suffix}`;
        stateSlot.removeAttribute("data-init-start");
        if (inProgress?.on_timedness) {
          stateSlot.setAttribute("data-on-timedness", inProgress.on_timedness);
        } else {
          stateSlot.removeAttribute("data-on-timedness");
        }
      } else {
        stateSlot.textContent = "init in —";
        stateSlot.setAttribute("data-init-start", target.initTime);
        stateSlot.removeAttribute("data-on-timedness");
      }
      if (target.targetIso) {
        lineSlot.hidden = false;
        lineSlot.textContent = "ETA —";
        lineSlot.setAttribute("data-next-complete", target.targetIso);
      } else {
        // Below-threshold product with a live init — no baseline to
        // extrapolate from, so hide the ETA line rather than showing a
        // stuck "ETA —".
        lineSlot.hidden = true;
        lineSlot.removeAttribute("data-next-complete");
      }
    }

    // "more details" is always available when the product has lead_group_stats.
    const groupStats = product.lead_group_stats;
    if (groupStats?.length) {
      if (detailsBtn.hidden) {
        // Transitioning from disabled → enabled (e.g. scrubbing from a pre-lead-groups
        // snapshot); reset the reveal to its default closed state.
        detailsBtn.textContent = "more details";
        detailsBtn.setAttribute("aria-expanded", "false");
        detailsSlot.hidden = true;
      }
      detailsBtn.hidden = false;
      buildRowDetails(detailsSlot, product);
    } else {
      detailsBtn.hidden = true;
      detailsSlot.hidden = true;
      detailsSlot.replaceChildren();
    }
  }

  // Maps the composite `on_timedness ?? status` key to a short human label.
  // Processing sub-states (on_track / insufficient_data) collapse to
  // "processing"; unobserved/not_started → "pending"; complete sub-states
  // (on_time / late) collapse to "complete". Delayed and failed pass
  // through unchanged.
  function statusLabel(key) {
    if (key === "on_time" || key === "late") return "complete";
    if (key === "on_track" || key === "insufficient_data") return "processing";
    if (key === "unobserved" || key === "not_started") return "pending";
    if (key === "delayed") return "delayed";
    return key.replace(/_/g, " ");
  }

  function buildRowDetails(container, product) {
    const stats = product.lead_group_stats;
    const inProgress = product.recent_inits.findLast((i) => i.status === "processing");
    const groups = inProgress?.lead_groups;
    const initMs = inProgress ? new Date(inProgress.init_time).getTime() : 0;
    const hasLive = !!(groups?.length);

    // Header: two-row group header over the p-columns.
    const initHeaderLabel = hasLive ? initShort(inProgress.init_time) : "waiting for next init";
    const groupHeadCols = [
      el("th"),
      el("th", { colspan: "3", style: "text-align: center;" }, initHeaderLabel),
      el("th", { colspan: "3", style: "text-align: center;" }, "time after init"),
    ];
    const subHeadCols = [
      el("th"),
      el("th", { class: "right" }, "status"),
      el("th", { class: "right" }, "time"),
      el("th", { class: "right" }, "duration"),
      el("th", { class: "right" }, "p50"),
      el("th", { class: "right" }, "p95"),
      el("th", { class: "right" }, "p99"),
    ];
    const thead = el("thead", null, [
      el("tr", null, groupHeadCols),
      el("tr", null, subHeadCols),
    ]);

    // Per-group rows. The backend already collapses (status, on_timedness)
    // into the right presentation state, so no client-side re-derivation.
    const groupRows = stats.map((s, i) => {
      const g = hasLive ? groups[i] : null;
      const gKey = g ? (g.on_timedness ?? g.status) : "not_started";

      const cols = [el("td", null, s.label)];
      cols.push(el("td", { class: `right eta-g-${gKey}` }, statusLabel(gKey)));
      const etaCell = el("td", { class: "right" });
      const durCell = el("td", { class: "right" });
      const completed = g?.status === "complete";
      if (completed && g.latency_s != null) {
        const completedIso = new Date(initMs + g.latency_s * 1000).toISOString();
        etaCell.setAttribute("data-completed-at", completedIso);
        durCell.textContent = fmtLatency(g.latency_s);
      } else if (completed) {
        etaCell.textContent = "done";
        durCell.textContent = "—";
      } else if (hasLive && s.p95_s != null) {
        const targetIso = new Date(initMs + s.p95_s * 1000).toISOString();
        etaCell.setAttribute("data-next-complete", targetIso);
        etaCell.setAttribute("data-clock-only", "");
        durCell.setAttribute("data-duration-since", inProgress.init_time);
      } else {
        etaCell.textContent = "—";
        durCell.textContent = "—";
      }
      cols.push(etaCell, durCell);
      cols.push(
        el("td", { class: "right" }, fmtLatency(s.p50_s)),
        el("td", { class: "right" }, fmtLatency(s.p95_s)),
        el("td", { class: "right" }, fmtLatency(s.p99_s)),
      );
      return el("tr", null, cols);
    });

    const table = el("table", { class: "data small" }, [
      thead,
      el("tbody", null, groupRows),
    ]);
    const wrapper = el("div", { class: "table-container" }, [table]);
    container.replaceChildren(wrapper);
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
  // and differ between live and scrub modes. nowMs is set first so the
  // countdown ticker picks up the snapshot's reference clock on the next
  // tick (rather than lagging behind the previous one).
  function renderSnapshot(summary, nowMs) {
    lastCountdownNow = nowMs;
    generatedAtSlot.replaceChildren(timeNode(summary.generated_at));
    for (const product of summary.products) {
      hydrateRow(product);
    }
  }

  function applyLive() {
    updateBanners(latest);
    const nowMs = Date.now();
    renderSnapshot(latest, nowMs);
    updateCountdowns(nowMs);
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

  // HH:MM in the user's current time-mode (UTC or local). The TZ suffix is
  // omitted since the stats column is narrow and the header select already
  // makes the active mode obvious.
  function fmtClock(iso) {
    const d = new Date(iso);
    const local = document.body.classList.contains("status-time-local");
    const hh = String(local ? d.getHours() : d.getUTCHours()).padStart(2, "0");
    const mi = String(local ? d.getMinutes() : d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mi}`;
  }

  // nowMs is the reference clock: Date.now() in live mode (ticked every
  // second), or the snapshot's generated_at in scrub mode (frozen). We
  // remember it so toggle handlers can re-render without recomputing.
  let lastCountdownNow = Date.now();
  function updateCountdowns(nowMs) {
    lastCountdownNow = nowMs;
    for (const node of app.querySelectorAll("[data-init-start]")) {
      const target = new Date(node.getAttribute("data-init-start")).getTime();
      const delta = Math.floor((target - nowMs) / 1000);
      node.textContent = delta <= 0 ? "processing" : "init in " + fmtDuration(delta);
    }
    for (const node of app.querySelectorAll("[data-next-complete]")) {
      const iso = node.getAttribute("data-next-complete");
      const delta = Math.floor((new Date(iso).getTime() - nowMs) / 1000);
      const clockOnly = node.hasAttribute("data-clock-only");
      if (clockOnly) {
        node.textContent = delta <= 0 ? "—" : `ETA ${fmtClock(iso)}`;
      } else if (delta <= 0) {
        node.textContent = "ETA any moment";
      } else {
        node.textContent = `ETA ${fmtClock(iso)} (in ${fmtDuration(delta)})`;
      }
    }
    for (const node of app.querySelectorAll("[data-duration-since]")) {
      const iso = node.getAttribute("data-duration-since");
      const delta = Math.floor((nowMs - new Date(iso).getTime()) / 1000);
      node.textContent = delta <= 0 ? "—" : fmtDuration(delta);
    }
    for (const node of app.querySelectorAll("[data-completed-at]")) {
      node.textContent = fmtClock(node.getAttribute("data-completed-at"));
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
      const snapMs = new Date(json.generated_at).getTime();
      renderSnapshot(json, snapMs);
      updateCountdowns(snapMs);
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

  // Details toggle: event delegation so hydrateRow doesn't re-wire per poll.
  app.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-slot="row-details-btn"]');
    if (!btn) return;
    const row = btn.closest(".status-row");
    const details = row.querySelector('[data-slot="row-details"]');
    const show = details.hidden;
    details.hidden = !show;
    btn.textContent = show ? "less" : "more details";
    btn.setAttribute("aria-expanded", String(show));
    // Kick a countdown update so ETA cells in the table are filled immediately.
    if (show) updateCountdowns(lastCountdownNow);
  });

  // Kick off.
  tick();
  startPolling();
})();
