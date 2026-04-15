# wxopticon — build-time skeleton / runtime hydration

Refactor `/status/` so 11ty emits the page shape at build time and JS
hydrates only the time-dependent regions on each poll. Previously the JS
built every DOM node from scratch on every tick.

## Why

- First paint shows product rows immediately — no "Loading…" flash for
  the stable skeleton, no layout shift once the poll resolves.
- Hydration becomes surgical: `querySelector` into fixed slots instead
  of `app.replaceChildren(...)`.
- Single source of truth: the build-time fetch and the runtime poll hit
  the same `summary.json`, so we don't drift a second schema for the
  skeleton.

## What moves where

**Build time (11ty / Nunjucks)**
- `_data/wxopticon.js` fetches `https://assets.dynamical.org/wxopticon/summary.json`
  with `@11ty/eleventy-fetch` (`duration: "1d"`, matching `_data/usage.js`).
- `content/wxopticon.njk` iterates `wxopticon.products` and renders one
  `<section class="wx-row" data-product-id="…">` per product, with the
  label / source / cadence strings filled in. Also renders the banner
  container, time-toggle button, and footer scaffold with a
  `window_days` value baked in.
- Each row emits empty slots the JS will hydrate:
  - `[data-slot="grid"]` — the recent_inits bars
  - `[data-slot="latency"]` — p50/p95/p99 strip
  - `[data-slot="samples"]` — sample count line
  - `[data-slot="next-complete"]` — next-expected-completion line
  - `[data-slot="next-run"]` — countdown to next init

**Runtime (vanilla JS)**
- `public/wxopticon.js` loses `renderApp` / `renderRow` /
  `renderLoadingFailed`. The tick loop iterates `summary.products`,
  looks up `[data-product-id=…]`, and replaces the children of each
  slot in place.
- Banner container gets stale/error banners added/removed per tick.
- The toggle button wiring, polling loop, visibility handling, and
  countdown interval are unchanged in spirit, but attach on
  `DOMContentLoaded` rather than after the first render.

## Plan

1. Add `_data/wxopticon.js`.
2. Rewrite `content/wxopticon.njk` to emit the skeleton.
3. Rewrite `public/wxopticon.js` to hydrate slots.
4. Verify locally: `npm start`, poll succeeds, bars + stats fill in,
   time toggle still works, dev-tools dark-mode emulation looks right.
5. Screenshot both light and dark, attach to PR.

## Risks

- A product added to the backend between site builds won't appear
  until the next build. Acceptable — product list is stable and the
  site rebuilds on push.
- If the build-time fetch fails we fail the build loudly (no fallback).
  `_data/usage.js` has the same property.
