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
- `docs/` - Build output (deployed to GitHub Pages)

### Data Flow

The catalog system (`_data/catalog.js`) defines weather models and their datasets. Each dataset entry includes:
- Zarr archive URLs for cloud storage
- Spatial/temporal domain metadata
- Variables and dimensions (auto-extracted from Zarr metadata)
- Python code examples for data access

Templates in `content/catalog-pages.njk` use Eleventy pagination to generate individual pages for each dataset entry.

### Key Patterns

**External Data Fetching**: Uses `@11ty/eleventy-fetch` with caching (1-day default) for GitHub API calls, CSV data, and Zarr metadata.

**Code Highlighting**: Custom `highlight` filter and `frameHighlight` paired shortcode wrap the syntax highlighting plugin with additional CSS class support.

**Notebook Embedding**: `embedNotebookContent` filter fetches Jupyter notebooks and strips outputs for cleaner embedding.

## Editing the Catalog

1. Edit `_data/catalog.js` to add/modify dataset entries
2. Each entry needs: `modelId`, `descriptionSummary`, Zarr URLs, and domain info
3. The catalog auto-fetches Zarr metadata to build variable/dimension tables

## Deployment

Commits to `main` automatically deploy to GitHub Pages. The `docs/` directory is the build output and is version controlled.
