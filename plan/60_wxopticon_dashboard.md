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

These are the concrete calls this plan makes. Flagging any we should revisit before starting the build.

### D1. Build-time fetch, not client-side polling

Rationale: every other data-consuming page on dynamical.org uses `@11ty/eleventy-fetch` at build time. Client-side polling would break that pattern and require a separate JS entry point. The 15-second `max-age` on `summary.json` was originally sized for a "realtime feel" client poller, but since the page rebuilds on every `main` deploy and inits move on the order of **hours**, a build-time snapshot is more than fresh enough for the pattern-recognition use case.

For the **countdown** — which is the one thing that does need per-second freshness — we compute it client-side in JS from `next_expected_init` (which is baked into the HTML at build time). The init time itself is known from the product schedule and doesn't change between builds.

If we later decide we want a "last refreshed N seconds ago" live indicator, a small JS fetch against `summary.json` can layer on top without changing anything else. Not in this plan.

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

Hover on a bar → a small popover with: init time (full), status, completion%, leads_available/leads_expected, first_arrival_at, last_arrival_at, latency_s (if present) formatted as `HH:MM:SS`, and "vs p99" when p99 is available.

CSS-only hover popover first pass; no JS. Keyboard accessibility = `tabindex="0"` on each bar container so it focuses and shows the popover on `:focus-within`.

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
_data/wxopticon.js              NEW — eleventy-fetch wrapper around summary.json
content/wxopticon.njk           NEW — page template, layout: base
public/wxopticon.js             NEW — countdown + time-toggle JS
public/main.css                 MODIFY — new tokens + .wxopticon-* styles
_includes/base.njk              MODIFY — add /wxopticon to nav
.eleventy.js                    NO CHANGE expected
```

No new npm deps. Everything uses what's already in `package.json`.

## Implementation steps

Red/green-ish. Each step has a verify condition; the last two are the visual checks.

1. **Data loader.** Write `_data/wxopticon.js` using `@11ty/eleventy-fetch` with `duration: "10m"` (we don't need the build-to-build caching that catalog uses; rebuilds should see fresh data but repeat fetches within a single build come from cache). Export the whole `summary.json` object.
   - *Verify:* `npm run build` succeeds; a Nunjucks template dump of `{{ wxopticon | dump }}` in a throwaway page shows the full object.

2. **Skeleton page template.** `content/wxopticon.njk`: title, nav entry, a `{% for product in wxopticon.products %}` loop rendering just the product label and `recent_inits | length`. No styling yet.
   - *Verify:* `/wxopticon/` route renders all three products; reading the HTML shows the expected counts.

3. **Status color tokens.** Add `--status-progress`, `--status-late`, `--status-failed` to both `:root` blocks in `public/main.css`. Add a minimal `.wx-bar` block class using the tokens so steps 4/5 don't need CSS backfilling.
   - *Verify:* `:root` inspector shows both light and dark values; no other page changes visually.

4. **Row layout + vertical bars.** Build the grid (CSS grid or flex). Bar fill via `style="--fill: 87%"` on each bar and `height: var(--fill)` in the stylesheet. Render init-time labels under each bar.
   - *Verify:* `npm start`, open `/wxopticon/` locally; three rows visible, bars render, fills match `completion_pct` for the current data. Take screenshot with Playwright MCP.

5. **Latency strip + next-completion.** Right-hand panel of each product row. Null-safe: render dashes when stats are `null`.
   - *Verify:* Current bootstrap data shows dashes for GFS/HRRR/IFS. Swap in a fixture summary.json with populated stats (save as `.cache/wxopticon-fixture.json`, point the loader at `file://` behind an env flag) and confirm it renders real numbers. Revert.

6. **Hover / focus popover.** CSS-only first pass.
   - *Verify:* Hover a bar, popover shows correct fields. Tab through bars with keyboard — popover shows on focus. Screenshot on hover.

7. **Countdown script.** `public/wxopticon.js` with a single `setInterval(1000)` that updates all `[data-next-init]` elements. Handles the `now > next_init` case (flip to "Now running").
   - *Verify:* Watch the countdown decrement for ~10 seconds in Chrome. Manually advance system clock past `next_expected_init` in a throwaway test → flip triggers.

8. **Time toggle.** Button + inline head script + localStorage + `body.time-local` class. All `<time>` elements carry `data-utc` and render both UTC and local variants with CSS visibility toggled.
   - *Verify:* Click toggle, all visible times switch atomically. Reload, state persists. Screenshot in both modes.

9. **Dark mode pass.** Confirm all new tokens have dark-mode values. Screenshot `/wxopticon/` with `prefers-color-scheme: dark` emulation.
   - *Verify:* Playwright screenshot in dark mode, no illegible text, bars still readable.

10. **Build + visual regression.** `npm run build`, confirm `docs/wxopticon/index.html` contains expected content. Open a playwright screenshot side-by-side with the scorecard page to sanity-check typography and spacing match.

## Open questions

Flagged for explicit sign-off before I start step 1. None are blockers — the plan's decisions above are all defensible defaults I'd ship if we don't revisit.

- **Q1. Page title + H1 text.** Options: "wxopticon" (matches the repo/R2/meta-issue name, niche-cute), "Arrival status" (descriptive), "Data arrival monitor" (long but unambiguous). My default: **H1 = "Arrival monitor"**, subtitle = `"wxopticon · updated every 5 minutes"`, browser title = `"dynamical.org - Arrival monitor"`. Lets wxopticon stay the internal/GitHub-facing name without forcing it on casual visitors.

- **Q2. Nav placement.** Between `scorecard` and `podcast`, as label `arrival` or `status` or `monitor`? My default: **`status`**. Short and accurate.

- **Q3. Scope of recent-init tooltip detail.** The current `summary.json` recent_inits entries have enough for: init time, status, completion, leads_available/expected, first/last arrival, latency, completed_at. Do we want the URL for any of these? (We don't — `events.jsonl` is the source of truth for URL-level forensics, and it's private.) My default: **no URLs**, just the summary fields.

- **Q4. Should the page show the NOMADS/FTP product even though it's disabled in production?** Currently `ALL_PRODUCTS` in wxopticon excludes `NOAA_GFS_FTP` pending Phase 4 rate-limiting work. `summary.json` therefore has no entry for it. My default: **match the data** — if it's not in summary.json, it's not on the page. Add it when wxopticon turns it on.

- **Q5. Should we surface `window_days` and `generated_at` anywhere?** `generated_at` is useful as a "last fetched" marker at the bottom of the page. `window_days=30` could go in a small footnote next to the latency strip ("30-day rolling"). My default: **yes to both**, small footer text, no prominent treatment.

## Steps

- [ ] Q1–Q5 resolved (sign off or redirect)
- [ ] Step 1: `_data/wxopticon.js`
- [ ] Step 2: skeleton `content/wxopticon.njk`
- [ ] Step 3: CSS tokens
- [ ] Step 4: grid + bars
- [ ] Step 5: latency strip + next-completion
- [ ] Step 6: hover/focus popover
- [ ] Step 7: countdown JS
- [ ] Step 8: time toggle
- [ ] Step 9: dark mode review
- [ ] Step 10: final build + screenshot
- [ ] Merge to main, watch Cloudflare Pages deploy, verify live page

## Log

### 2026-04-14 — Plan authored

Drafted alongside wxopticon Phase 1 deploy verification. Backend is producing clean summary.json as of commit `a97d3cc` (cold-start latency poisoning fixed). Ready to start step 1 once Q1–Q5 are resolved.
