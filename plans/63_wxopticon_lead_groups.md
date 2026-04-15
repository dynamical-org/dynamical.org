# wxopticon: stacked lead-group bars + on-track coloring

Frontend counterpart to [wxopticon PR #9](https://github.com/dynamical-org/wxopticon/pull/9)
(Phase 2 of the backend plan in that repo at `plans/9_lead_groups.md`).

## Motivation

The backend now emits per-lead-group latency stats and per-init lead-group
completion. This PR teaches `/status/` to draw each init bar as a vertical
stack of group segments, so you can see which part of the run is dragging
(e.g. short range landed, long range still processing) instead of one
monolithic fill.

While a run is processing, the fill color is now driven by `init.on_track`:
green if every group is still within its historical envelope, amber (the
existing "in progress" shade) when at least one group has blown past p99.

## Success criteria

- [ ] `_data/wxopticon.js` passes through `lead_groups: [{name,
      leads_in_group}]` per product so the build-time skeleton can allocate
      sub-bar nodes before hydration.
- [ ] `renderBar` renders one `.status-bar-fill-group` per `init.lead_groups`
      entry, stacked bottom-up with slice height = share of total leads and
      inner fill = share of leads found in that slice.
- [ ] `.status-bar` carries `data-on-track="true"|"false"` only when the
      init is `in_progress`. CSS picks green vs amber off this attribute.
- [ ] Tooltip keeps the existing run summary and appends per-group status
      lines.
- [ ] Bars without `init.lead_groups` (old snapshots, or during the window
      where prod summary.json hasn't been regenerated yet) still render
      identically to today's single-fill bar.
- [ ] Existing `on_time` / `late` / `failed` / `unobserved` visuals are
      unchanged.
- [ ] Playwright screenshot confirms both live and scrub modes render with
      the new stacked visual.

## Implementation notes

- Backend values are cumulative: group `i` covers leads 0..max_lead[i], so
  the slice for group `i` is diffed from `i-1`.
- Slice height (% of track): `(leads_expected[i] - leads_expected[i-1]) / total_leads`
- Slice fill fraction: `(leads_available[i] - leads_available[i-1]) / (leads_expected[i] - leads_expected[i-1])`
- First group is the undiffed case (use `completion_pct` directly).
- Segment carries a status class (`g-on_time`, `g-in_progress`, …). For the
  in-progress group color we gate on `.status-bar[data-on-track="true"]` so
  on-track runs go green without needing a second class per segment.

## Log

### 2026-04-15 — plan created
