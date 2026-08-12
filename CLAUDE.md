# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the website for dynamical.org - a public catalog of cloud-optimized weather and climate datasets. It's a static site built with Eleventy (11ty) that showcases weather/climate data from models like NOAA GFS, GEFS, HRRR, and ECMWF IFS as accessible Zarr archives.

## Commands

```bash
npm install        # Install dependencies
npm start          # Dev server on port 8081 with live reload
npm run build      # Build static site to docs/
npm run clean      # Remove docs/ and .cache/
npm test           # Offline unit tests (test/*.test.mjs), milliseconds
npm run test:e2e   # Browser specs (test/e2e/) — starts its own dev server
```

`npm run test:e2e` needs a browser once: `npx playwright install chromium`. Two kinds
of spec live there. The scorecard ones render its charts for real, so they hit CDNs and
the published parquet files and take about a minute; they are the only check that
catches the data those charts read drifting out from under them. `pipeline.spec.mjs`
instead stubs every request from `test/fixtures/pipeline-dashboard.json`, so it is
offline and finishes in seconds — it exists because `/status/pipeline/` is laid out by
measurement (lead rows sized by group, init columns sized by their label, views sharing
one reserved height), and `npm test` has no layout engine to catch that class of bug.
Keep both out of `npm test`, which stays offline and instant.

## Architecture

### Directory Structure

- `content/` - Main content pages (Nunjucks templates, Markdown posts)
- `_data/` - Global data sources consumed by templates
  - `catalog.js` - Primary dataset catalog with model definitions and entries
  - `scorecard/index.js` - Weather station scorecard data (fetches from external CSV)
- `_includes/` - Reusable Nunjucks templates (layouts, partials)
- `public/` - Static assets copied directly to output
- `docs/` - Build output (deployed to Cloudflare Pages, not checked in)

### Data Flow

The catalog system (`_data/catalog.js`) defines weather models and their datasets. Each dataset entry includes:
- Zarr archive URLs for cloud storage
- Spatial/temporal domain metadata
- Variables and dimensions (fetched from the STAC Collection at `stac.dynamical.org/{slug}/collection.json`)
- Python code examples for data access

Templates in `content/catalog-pages.njk` use Eleventy pagination to generate individual pages for each dataset entry.

### Key Patterns

**External Data Fetching**: Uses `@11ty/eleventy-fetch` with caching (1-day default) for GitHub API calls, CSV data, and STAC Collection JSON from `stac.dynamical.org`.

**Code Highlighting**: Custom `highlight` filter and `frameHighlight` paired shortcode wrap the syntax highlighting plugin with additional CSS class support.

**Notebook Embedding**: `embedNotebookContent` filter fetches Jupyter notebooks and strips outputs for cleaner embedding.

**Social Cards**: An `eleventy.after` hook renders a 1200×630 PNG per page into
`assets/og/` (`lib/og-card.js`, section chip from `lib/og-card-label.js`). The card shows
only what the page provides — chip, title, subtitle, thumbnail, URL — with the subtitle
coming from `og:description`. Set `socialDescription` in front matter to give link previews
a terser line than the SEO `description` (catalog and model pages pass their fact line).
Review them all at **`/dev/cards/`**, a contact sheet written by the same hook on local and
preview builds but never on `main`.

## Styling & markup conventions

Write lean, semantic markup with as few classes and declarations as possible. The catalog list in `content/catalog.njk` is the reference example. Before adding a class or a rule, ask whether an existing element, selector, or inherited value already covers it.

- **Semantic elements over `div` soup.** A list of things is a `<ul>`/`<li>`; use the element that already means the thing before reaching for `<div class="…">`. (The catalog rows are `<li>`, not `<div class="cat-row">`.)
- **One container class; select children contextually.** Give the wrapper a single class and reach inward with element/descendant selectors (`.cat-section li`, `.cat-section li a`) instead of inventing a class for every node (`.cat-row`, `.cat-row-head`, …).
- **Structural pseudo-classes, not template conditionals or modifier classes.** Use `:not(:last-of-type)`, `:first-child`, etc. for edge cases like separators rather than `loop.last` checks or extra classes.
- **Inherit; don't restate.** Only write a declaration if it changes something. Let color, size, and weight cascade from the base stylesheet unless a specific override is genuinely needed.
- **Name only what you target directly.** A class earns its place when you actually select or reuse it (`.cat-name`, `.cat-meta`). Nodes reached only contextually don't need one.
- **Colocate styles with their markup; promote only when shared.** The ladder: a truly one-off tweak goes inline on the element (`style="margin-top: 4rem;"`); page-scoped styling with any structure goes in a `<style>` block at the top of that template (see `catalog.njk`, `status.njk`); `public/main.css` is reserved for genuinely shared rules and the design tokens. "Shared" means used by more than one page or by a shared include — a class that one page uses does not earn a home in `main.css`, and when you touch styles, prefer moving them *down* this ladder over up.
- **No single-use classes.** Before minting a class, check whether an element, structural, or descendant selector already reaches the node (`.status-incident header + p`, not `.status-incident-summary`). A class that exists to target one node one time is ceremony; delete it.
- **Reuse the design tokens.** Pull colors, borders, and radii from the `:root` custom properties in `main.css` (`var(--link-color)`, `var(--border-muted-color)`, `var(--radius-sm)`, …) so light/dark themes keep working — never hardcode hex values in a page.
- **Shared list pattern.** Vertical lists of linked rows (the catalog, `/updates`, featured work) share the `.index-list` base in `main.css` — a `<ul>` reset, row separators, link reset, and focus ring. To add a list, use `<ul class="index-list …">`, tune `--index-row-padding` / `--index-row-border`, and layer on the title/meta styles; don't rebuild the skeleton.

## Editing the Catalog

1. Edit `_data/catalog.js` to add/modify dataset entries
2. Each entry needs: `modelId`, `descriptionSummary`, Zarr URLs, and domain info
3. The catalog auto-fetches the STAC Collection from `stac.dynamical.org` to build variable/dimension tables

## Deployment

Commits to `main` automatically deploy to Cloudflare Pages. The `docs/` directory is the build output and is regenerated each build and is not checked in.
