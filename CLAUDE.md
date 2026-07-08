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
```

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

## Styling & markup conventions

Write lean, semantic markup with as few classes and declarations as possible. The catalog list in `content/catalog.njk` is the reference example. Before adding a class or a rule, ask whether an existing element, selector, or inherited value already covers it.

- **Semantic elements over `div` soup.** A list of things is a `<ul>`/`<li>`; use the element that already means the thing before reaching for `<div class="…">`. (The catalog rows are `<li>`, not `<div class="cat-row">`.)
- **One container class; select children contextually.** Give the wrapper a single class and reach inward with element/descendant selectors (`.cat-section li`, `.cat-section li a`) instead of inventing a class for every node (`.cat-row`, `.cat-row-head`, …).
- **Structural pseudo-classes, not template conditionals or modifier classes.** Use `:not(:last-of-type)`, `:first-child`, etc. for edge cases like separators rather than `loop.last` checks or extra classes.
- **Inherit; don't restate.** Only write a declaration if it changes something. Let color, size, and weight cascade from the base stylesheet unless a specific override is genuinely needed.
- **Name only what you target directly.** A class earns its place when you actually select or reuse it (`.cat-name`, `.cat-meta`). Nodes reached only contextually don't need one.
- **Page-scoped CSS lives in the template.** Styles used by a single page go in a `<style>` block at the top of that template (see `catalog.njk`, `catalog-pages.njk`) — not in global `public/main.css`. Reserve `main.css` for genuinely shared rules and the design tokens.
- **Reuse the design tokens.** Pull colors, borders, and radii from the `:root` custom properties in `main.css` (`var(--link-color)`, `var(--border-muted-color)`, `var(--radius-sm)`, …) so light/dark themes keep working — never hardcode hex values in a page.

## Editing the Catalog

1. Edit `_data/catalog.js` to add/modify dataset entries
2. Each entry needs: `modelId`, `descriptionSummary`, Zarr URLs, and domain info
3. The catalog auto-fetches the STAC Collection from `stac.dynamical.org` to build variable/dimension tables

## Deployment

Commits to `main` automatically deploy to Cloudflare Pages. The `docs/` directory is the build output and is regenerated each build and is not checked in.
