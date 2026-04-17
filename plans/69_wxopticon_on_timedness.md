# Plan: consume wxopticon `on_timedness` from the backend

## Context

Companion to [dynamical-org/wxopticon#14](https://github.com/dynamical-org/wxopticon/pull/14), which moves the "on track / delayed / unobserved" decision out of this frontend and into `summary.py`. See that PR's `plans/14_centralize_status_timedness.md` for the full design and data-model rationale. This plan covers the dynamical.org side only.

Closes dynamical-org/dynamical.org#66.

## Approach

Drive presentation purely off the new `status` + `on_timedness` pair. Delete all client-side re-derivation in `public/wxopticon.js`. CSS keys off a single composite value (`on_timedness ?? status`) instead of the old `data-on-track="true|false"` attribute.

### JS — `public/wxopticon.js`

1. `etaTarget` / `buildRowDetails`: `i.status === "in_progress"` → `"processing"`.
2. `groupSlices` / `renderGroupSegments`: segment class is `g-${timednessKey(g)}` where `timednessKey = on_timedness ?? status`.
3. `applyOnTrack` renamed → `applyOnTimedness`; sets `data-on-timedness` on the bar (or removes it). No more "only in_progress" guard — the backend field is already scoped.
4. ETA state-slot text: drive suffix directly off `inProgress.on_timedness` (`on_track` / `delayed` get qualifiers; `insufficient_data` / `unobserved` show plain "processing" — the #66 fix).
5. `buildRowDetails`: delete the `if (gStatus === "in_progress")` re-derivation block. Use `g.on_timedness ?? g.status`.
6. `statusLabel` rewritten for the new vocabulary: `on_time`/`late` → "complete", `on_track`/`insufficient_data` → "processing", `unobserved`/`not_started` → "pending".
7. `barTooltip` / `g.status === "in_progress"` → `"processing"`; tooltip includes `on_timedness` when present.

### CSS — `public/main.css`

- `[data-status="on_time"|"in_progress"|"late"]` single-fill rules rewritten for the new `status` + `on_timedness` pair.
- `[data-on-track="true|false"]` replaced with `[data-on-timedness=...]` analogs covering all five processing/complete values.
- `g-on_track` / `g-delayed` / `g-insufficient_data` added; `g-in_progress` removed.
- `eta-g-on_track` / `eta-g-insufficient_data` / `eta-g-unobserved` added; `eta-g-in_progress` removed.

## Critical files

- `/Users/marsh/workspace/dynamical-org/dynamical.org/public/wxopticon.js`
- `/Users/marsh/workspace/dynamical-org/dynamical.org/public/main.css`
- Reference only: `/Users/marsh/workspace/dynamical-org/dynamical.org/_data/wxopticon.js` (build-time skeleton — doesn't touch `status` or `on_track`; no changes needed).

## Sequencing

**Must merge after** the wxopticon PR has deployed AND `scripts/reprocess_history.py` has backfilled historical snapshots in R2. The plan's principle: "the simplified frontend never has to handle mixed schemas." Between the two deploys, there's a short window where the old frontend reads new JSON — that's fine (brief stale render, plan accepts this). Merging PR 69 before wxopticon PR 14 is the opposite direction and would break production.

## Verification

1. `npm run build` — succeeds, no template errors.
2. `npm start` → open `/status/`:
   - In-progress rows with `on_timedness: on_track` show "· on track" in green.
   - In-progress rows with `on_timedness: delayed` show "· delayed" in yellow.
   - In-progress rows with `on_timedness: insufficient_data` or `unobserved` show plain muted "processing" (#66).
   - Complete rows with `on_timedness: late` show red; `on_time` shows green.
3. Scrub through historical snapshots — every reprocessed epoch renders consistently.
4. Close `gh:dynamical-org/dynamical.org#66` after deploy confirms #66's visual fix.

## Out of scope

- Removing the legacy `on_track: bool` field — that's a follow-up PR in wxopticon (PR 3 in the sequence) after this has baked.
