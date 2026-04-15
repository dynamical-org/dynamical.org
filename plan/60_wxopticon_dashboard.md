# Plan: wxopticon arrival dashboard

PR: https://github.com/dynamical-org/dynamical.org/pull/60
Related: dynamical-org/meta#68, dynamical-org/wxopticon#1

## Context

[wxopticon](https://github.com/dynamical-org/wxopticon) is now running on Modal every 5 minutes, producing `https://assets.dynamical.org/wxopticon/summary.json`. It HEAD-probes NOAA GFS (AWS), NOAA HRRR 48h (AWS), and ECMWF IFS oper 0.25° (AWS) across every active init × lead coordinate, and rolls the event log into a per-product completion summary.

What's missing: a public page that renders it. Phase 2 of the original monitoring-dashboard plan.

The page needs to answer, at a glance:

- **Is the currently-running init on schedule?** (most important question)
- **How are recent inits tracking?** (pattern recognition)
- **Is anything outright failing?**

The `plan/1_monitoring_dashboard.md` file in the wxopticon repo sketched the Phase 2 shape (row-per-product × vertical bars per init, Healthchecks-inspired countdown, UTC/local toggle). This plan makes the concrete decisions.

## The data

A fresh sample from today (bootstrap state, so stats are all `null` — that's expected and will stabilize over ~48h as real init cycles complete):

```json
{
  "generated_at": "2026-04-14T19:40:04.683553+00:00",
  "window_days": 30,
  "products": [
    {
      "id": "noaa-gfs-aws",
      "label": "NOAA GFS 0.25° (AWS)",
      "source": "s3://noaa-gfs-bdp-pds",
      "cadence_hours": 6,
      "expected_lead_count": 209,
      "latency_stats": {
        "p50_s": null, "p95_s": null, "p99_s": null,
        "avg_s": null, "sample_init_count": 0
      },
      "next_expected_init": "2026-04-15T00:00:00+00:00",
      "next_expected_completion_at": null,
      "recent_inits": [
        {
          "init_time": "2026-04-14T18:00:00+00:00",
          "status": "in_progress",
          "completion_pct": 0.0,
          "leads_available": 0,
          "leads_expected": 209,
          "first_arrival_at": null,
          "last_arrival_at": null
        }
      ]
    }
  ]
}
```

Key fields the frontend will consume:

- `products[].label`, `source`, `cadence_hours` — row header text.
- `products[].latency_stats.{p50_s, p95_s, p99_s, avg_s, sample_init_count}` — may all be `null` during bootstrap; template must handle that.
- `products[].next_expected_init` — always populated; the "next run" anchor for the countdown.
- `products[].next_expected_completion_at` — `null` until p95 is populated; render "—" or "pending baseline" in that case.
- `products[].recent_inits[]` — up to 8 entries, one per init; each has `status` ∈ `{on_time, late, in_progress, failed}`, `completion_pct`, `leads_available`, `leads_expected`, optionally `latency_s`, `first_arrival_at`, `last_arrival_at`, `completed_at`.

## How the frontend works today (short tour)

- Eleventy 11ty, Nunjucks templates, `_data/*` files consumed globally.
- `_data/scorecard/index.js` is the closest analogue: async module, uses `@11ty/eleventy-fetch` (already in package.json) with a cache duration, returns data that the Nunjucks template iterates over.
- Pages live in `content/*.njk` with `layout: base`. Existing example: `content/scorecard.njk`.
- Design tokens in `public/main.css` under `:root` and `@media (prefers-color-scheme: dark)`. Both themes defined. Font is IBM Plex Mono. `html { font-size: 62.5% }` so `1rem = 10px`.
- Nav is hard-coded in `_includes/base.njk`. New routes need to be added there if they should appear in nav.
- Deployment: commits to `main` auto-deploy to Cloudflare Pages.

## Decisions

These are the concrete calls this plan makes. All resolved with the user on 2026-04-14.

### D1. Client-side polling, no build-time fetch

We do **not** want to rebuild + redeploy the site every 5 minutes just to surface fresh arrival data. The whole point of the dashboard is to be live, and Cloudflare Pages rebuilds are a heavyweight side effect.

So: the page template ships with an empty `<main>` shell (plus an initial loading state), and a single `public/wxopticon.js` module owns fetching and rendering:

- **On load**: fetch `https://assets.dynamical.org/wxopticon/summary.json`, render.
- **Then**: `setInterval(fetchAndRender, 15_000)`. Matches the `max-age=15` on the R2 object — polling faster just hits the CDN edge cache.
- **Error handling**: keep displaying the last successful render; show a small unobtrusive "couldn't refresh" banner. If the *first* fetch fails, show a more prominent loading-failed state with a retry button.
- **Stale detection**: if `now - generated_at > 10 min` (2× the backend 5-min cadence), overlay a "backend may be stalled" warning on the header. Doesn't hide the data — just flags that it might be old.
- **Page visibility**: pause polling when `document.hidden === true`, resume + immediate fetch on `visibilitychange` when the tab comes back. Keeps background tabs from burning requests.

Rendering is vanilla JS + template literals. No framework. The whole module should be well under 200 lines.

### D2. Route: `/wxopticon/`

- Matches the R2 key (`wxopticon/summary.json`) and the repo name.
- Add to primary nav in `_includes/base.njk` between `scorecard` and `podcast`.

### D3. Recent-inits window: whatever the backend sends (up to 8)

wxopticon already caps `recent_inits` at `DEFAULT_RECENT_INITS = 8`. Frontend renders them as-is, oldest-to-newest left-to-right. No frontend-side slicing.

### D4. Status → color mapping

Reuse existing CSS custom properties where possible. New ones only where needed.

| status        | color token                    | fallback hex  | rationale |
|---------------|--------------------------------|---------------|-----------|
| `on_time`     | `--pill-available-bg` (#78fa64) | green         | existing token used for "available" catalog entries |
| `in_progress` | new: `--status-progress`       | amber #f4b942 | distinct from on_time but not alarming |
| `late`        | new: `--status-late`           | orange #ff8c3e | pre-failure signal |
| `failed`      | new: `--status-failed`         | red #e5484d   | terminal |

The three new tokens go in both the `:root` and `@media (prefers-color-scheme: dark)` blocks of `public/main.css` (dark-mode variants use slightly desaturated values).

### D5. Time display: UTC by default, local-time toggle

A small `<button>` in the page header toggles a class on `<body>` (`body.time-local` vs default UTC). All timestamps rendered with a `data-utc="<iso>"` attribute and two inline `<span>`s (one UTC, one local) — CSS hides the other based on the class. No date library needed; use `toLocaleString()`.

Toggle state persists in `localStorage` (`wxopticon:timeMode` ∈ `{utc, local}`), read at page load by a tiny inline script in the `<head>` to avoid flash.

### D6. Bars are vertical, layout is a grid

Row = product, columns = recent inits. Each "bar" is a flex column that fills from the bottom to `completion_pct * 100%`. Under each bar, the init-time label rendered in 2 lines (`MM-DD` / `HHz`).

**Keep v1 popover simple.** Native `title` attribute on each bar with a single-line summary: `"2026-04-14 18z · in_progress · 87%"`. That's it — no custom popover, no latency/p99 comparison, no hover-and-focus interplay. The bar's fill height already communicates the most important info visually; the tooltip is just "what am I looking at". Richer popovers are a v2 follow-up if the page gets real usage and someone asks for them.

### D7. Countdown

The right side of each product row shows "Next run in H:MM:SS" counting down to `next_expected_init`. When that time passes, it flips to "Now running" (or similar) and the row's rightmost bar (the new in-progress init) begins filling as the next build lands.

A single global `setInterval(1000)` updates all countdowns — one JS module in `public/wxopticon.js`, ~30 lines.

If `next_expected_completion_at` is set (post-baseline), show it below the countdown as "expected complete at HH:MM UTC".

### D8. Empty / bootstrap state is first-class

Since the page will ship during bootstrap when `latency_stats` is `null`, the template must render gracefully:

- Latency strip: `p50 / p95 / p99` → dashes with a "baseline pending — 48h needed" tooltip.
- `next_expected_completion_at` null → "—".
- Recent-init bars render normally (status/pct are valid even without stats).

## Files to create / modify

```
content/wxopticon.njk           NEW — page template, layout: base, empty shell + loading state
public/wxopticon.js             NEW — fetch loop, render, countdown, time toggle
public/main.css                 MODIFY — new status tokens + .wx-* styles
_includes/base.njk              MODIFY — add /status to nav
```

No `_data/wxopticon.js` (everything is client-side now). No new npm deps.

## Implementation steps

Each step has a verify condition. Visual checks use Playwright MCP screenshots.

1. **Skeleton template + nav.** `content/wxopticon.njk`: `layout: base`, empty `<main id="wx-app">` containing a loading placeholder (`<p>Loading…</p>`). Add `<script type="module" src="/wxopticon.js"></script>` at the end. Add `<li><a href="/status">status</a></li>` to the nav list in `_includes/base.njk` between `scorecard` and `podcast`. Decide the permalink (`permalink: /status/` so the URL matches the nav label, even though the filename is `wxopticon.njk`).
   - *Verify:* `npm start`, `/status/` renders and shows "Loading…". Nav link appears in header.

2. **CSS tokens + base layout.** Add `--status-progress`, `--status-late`, `--status-failed` to both `:root` blocks in `public/main.css` (light and dark). Add `.wx-grid`, `.wx-row`, `.wx-bar`, `.wx-bar-fill`, `.wx-legend`, `.wx-header` classes. Bar fill via `--fill` custom property on the bar element. No data yet — just the shell styles.
   - *Verify:* `public/main.css` compiles (no syntax errors), page still renders, inspector shows the new CSS custom properties.

3. **Fetch + render loop.** `public/wxopticon.js`:
   - `async function fetchSummary()` → GET `https://assets.dynamical.org/wxopticon/summary.json`, throws on non-OK.
   - `function render(summary)` → builds HTML via template literals, swaps into `#wx-app`. Render function is idempotent — full tree replacement on each tick is fine at this data size.
   - `async function tick()` → fetch, render, catch + show banner.
   - `document.addEventListener('DOMContentLoaded', ...)` → initial tick, then `setInterval(tick, 15_000)`.
   - Visibility pause: `document.addEventListener('visibilitychange', ...)` → clear interval when hidden, resume + immediate fetch when visible.
   - *Verify:* Open `/status/` locally, see three product rows within one tick. Throttle network in DevTools → confirm error banner shows. Open in background tab, wait a minute, foreground → confirms resume works.

4. **Row layout: label + bars + init labels.** Render function emits `.wx-row` per product: left column = product label + source + cadence; middle = `.wx-grid` with one `.wx-bar` per `recent_inits` entry, `--fill: {completion_pct*100}%`, `data-status="{status}"`, native `title` attribute with the v1 tooltip text (D6).
   - *Verify:* Current bootstrap data shows 6 bars per GFS/HRRR row, varying heights, colors match statuses. Screenshot with Playwright.

5. **Latency strip + generated_at footer.** Right column of each row: three-up display showing `p50 / p95 / p99`. Null-safe — render `—` with a `title="baseline pending — needs ~48h of completed inits"` attribute. Add a page footer showing `Updated {generated_at}` and `{window_days}-day rolling window` (per D8 + Q5).
   - *Verify:* Bootstrap data shows all dashes. Hover a dash → tooltip explains. Footer shows timestamps.

6. **Countdown.** Separate `setInterval(updateCountdowns, 1000)` that updates each `[data-next-init]` element with `Next run in H:MM:SS`. When `next > now`, show the countdown; when `next <= now`, show "Now running". No need to re-fetch; the next scheduled fetch will update `next_expected_init` when wxopticon publishes.
   - *Verify:* Watch countdown decrement live for 10s.

7. **Time toggle.** A single `<button id="wx-time-toggle">` in the page header. On click, toggle a class `time-local` on `document.body`, persist to `localStorage['wxopticon:timeMode']`. On initial load, read localStorage and apply before first render to avoid flash. Render function emits every timestamp as two inline `<span>`s (`.t-utc` and `.t-local`), one hidden by CSS based on the body class.
   - *Verify:* Toggle switches all visible timestamps instantly. Reload preserves state.

8. **Stale-detection banner.** After each render, compare `now - generated_at`; if `> 10 min`, add a warning banner at the top of `#wx-app`.
   - *Verify:* Manually hack `generated_at` to an old value in a local fixture (e.g., patch response in DevTools) → banner appears.

9. **Dark mode pass.** Verify all new tokens are defined in both `:root` blocks; screenshot `/status/` with `prefers-color-scheme: dark` emulation. Fix any low-contrast regressions.
   - *Verify:* Playwright screenshot in dark mode, bars readable, text legible.

10. **Final build + visual QA.** `npm run build`, confirm `docs/status/index.html` exists and renders the shell + loading state (the actual data fills in client-side, so the build output is static). Side-by-side screenshot with `/scorecard/` to sanity-check typography and spacing match. Run CI locally (whatever `npm test` or equivalent exists).
    - *Verify:* Build succeeds. Screenshots captured. Ready to merge.

## Resolved questions

All resolved on 2026-04-14.

- **Q1. Page title.** ~~H1 = "Arrival monitor"?~~ → **Skip the page H1 for v1.** The nav link and content are enough. If we want a title later, we add it in a follow-up. Browser `<title>` still set ("dynamical.org - status") so it's bookmarkable.

- **Q2. Nav label.** → **`status`** (route: `/status/`, filename: `content/wxopticon.njk` with `permalink: /status/`).

- **Q3. Tooltip detail.** → **Keep v1 simple.** Native `title` attribute with a single-line summary per bar: `"<init> · <status> · <pct>%"`. No custom popover. v2 can add richer info if real users ask for it.

- **Q4. Which products to show.** → **Match what reformatters actively uses.** The frontend renders whatever products `summary.json` contains (no filter, no special cases), but there's a backend-side audit needed before wxopticon's product list matches reformatters. This is a **wxopticon-side task**, flagged below, not part of this PR.

  Current drift between wxopticon `ALL_PRODUCTS` and reformatters active sources (as of 2026-04-14):

  | Reformatters dataset | wxopticon product | Status |
  |---|---|---|
  | `noaa-gfs-forecast` (S3 + NOMADS fallback) | `noaa-gfs-aws` | ✓ S3 covered; **missing NOMADS side** (reformatters uses it for inits <12h old) |
  | `noaa-gfs-analysis` | — | Same URL shape as forecast; covered by monitoring the same S3 keys |
  | `noaa-hrrr-forecast-48-hour` (S3 + NOMADS fallback) | `noaa-hrrr-aws` | ✓ S3 covered; **missing NOMADS side** |
  | `noaa-hrrr-analysis` | — | Same URL shape |
  | `ecmwf-aifs-deterministic-forecast` | — | **missing entirely** |
  | `ecmwf-ifs-ens-forecast-15-day-0-25-degree` | — | **missing entirely** |
  | — | `ecmwf-ifs-aws` (IFS physics oper) | **not used by reformatters** — remove |

  Follow-up wxopticon tasks (separate PR, tracked there):
  1. Replace `ECMWF_IFS_AWS` with `ECMWF_AIFS_DETERMINISTIC` + `ECMWF_IFS_ENS` in `products.py`.
  2. Add `NOAA_GFS_NOMADS` and `NOAA_HRRR_NOMADS` to `ALL_PRODUCTS` once the per-host rate limiter is in place (the NOMADS Akamai 302 issue that blocked Phase 1).
  3. Update `scripts/check_reformatters_sync.py` PAIRINGS to match.

  The frontend work in this PR doesn't block on that — we'll just see different products in `summary.json` as the backend catches up, and render them.

- **Q5. Surface `window_days` and `generated_at`.** → **Yes.** Small footer text, no prominent treatment. Step 5 covers it.

## Steps

- [x] Q1–Q5 resolved (2026-04-14)
- [ ] Step 1: skeleton `content/wxopticon.njk` + nav entry
- [ ] Step 2: CSS tokens + shell classes
- [ ] Step 3: `public/wxopticon.js` fetch + render loop
- [ ] Step 4: row layout — label + bars + init labels + `title` tooltip
- [ ] Step 5: latency strip + `generated_at` footer
- [ ] Step 6: countdown
- [ ] Step 7: time toggle (UTC / local)
- [ ] Step 8: stale-detection banner
- [ ] Step 9: dark mode review
- [ ] Step 10: final build + screenshot
- [ ] Merge to main, watch Cloudflare Pages deploy, verify live page

## Log

### 2026-04-14 — Plan authored

Drafted alongside wxopticon Phase 1 deploy verification. Backend is producing clean summary.json as of commit `a97d3cc` (cold-start latency poisoning fixed). Ready to start step 1 once Q1–Q5 are resolved.

### 2026-04-14 — Q1–Q5 resolved, strategy revised

- **D1 flipped**: client-side polling (15s interval, visibility-aware), not build-time fetch. User's point: rebuilding + redeploying the static site every 5 min is a bad idea; polling summary.json directly from the browser is the whole reason we set `max-age=15` on the R2 object.
- **Q1**: skip the page H1 for v1; browser `<title>` only.
- **Q2**: nav = `status`, route = `/status/`.
- **Q3**: popover simplified to a native `title` attribute (one-liner per bar). No custom popover for v1.
- **Q4**: frontend stays product-agnostic (renders whatever summary.json contains). Audit vs reformatters revealed drift: wxopticon currently monitors `ecmwf-ifs-aws` (IFS oper) which reformatters doesn't use, and is missing `ecmwf-aifs-deterministic`, `ecmwf-ifs-ens`, and the NOMADS fallback side of GFS/HRRR. These are follow-up wxopticon tasks; frontend work doesn't block on them.
- **Q5**: yes — `generated_at` + `window_days` in a small footer.
- Removed `_data/wxopticon.js` from the file list. All rendering is client-side now.
- Rewrote implementation steps (1–10) around the polling architecture.
