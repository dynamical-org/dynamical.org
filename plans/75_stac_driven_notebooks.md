# 75 — STAC-driven notebook URLs, drop Icechunk gating

PR: https://github.com/dynamical-org/dynamical.org/pull/75

## Goal

Pull notebook URLs (`githubUrl`, `colabUrl`) from STAC Collection `links[].rel == "example"` instead of hardcoding per-entry in `_data/catalog.js`. Drop the Icechunk-specific row, disclaimer, and `githubIcechunkUrl` field — Icechunk is becoming the default notebook, so the separate gating no longer applies.

Part of the broader push to make the catalog STAC-driven with minimal local hydration.

## Changes

- `_data/catalog.js`
  - `reshapeStacCollection`: parse `links[].rel == "example"`; `application/x-ipynb+json` → `githubUrl`, `text/html` → `colabUrl`.
  - Remove hardcoded `githubUrl`, `colabUrl`, `githubIcechunkUrl` from every entry.
- `content/catalog-pages.njk`: drop Icechunk row + preview disclaimer.
- `content/earthmover-readmes.njk`:
  - Pagination filter switched from `entry.githubIcechunkUrl` to `entry.githubUrl` (documents intent; 11ty `filter:` is a no-op on array sources).
  - Link targets use STAC-sourced `githubUrl` / `colabUrl`.
  - `## Examples` section guarded so datasets without STAC don't emit empty-href links.
- `content/aws-open-data-registry.njk`: `selectattr` and tutorial URL fields switched from `githubIcechunkUrl` to `githubUrl`.

## Notes

- `dwd-icon-eu-forecast-5-day` (status `coming soon`) has no STAC collection yet; the earthmover README still renders with a mostly-empty body (unchanged from before) but no longer has broken/empty notebook links.
- Colab URLs in STAC are derived from the GitHub URL — same transform the old template did inline with `replace()`. No behavior change in rendered links for STAC'd datasets.
- Icechunk notebooks (`*-icechunk.ipynb` filenames) are not currently linked from STAC. If/when they become the canonical notebooks, the STAC link target changes and this template needs no further work.

## Log

### 2026-04-22 — initial

- Branch `stac-driven-notebooks` created off `icechunk-2`.
- Verified all production datasets have `links[].rel == "example"` in their STAC collection (9/10; dwd coming-soon is the exception).
- Build clean, outputs spot-checked: catalog pages, earthmover READMEs, AWS registry yamls.
