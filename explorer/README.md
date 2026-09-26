# Catalog explorer

A map of one variable, read in the browser straight from a dataset's published
Icechunk store: no tile server, proxy or pre-rendered images. The site mounts it on
catalog pages; this package builds it.

```sh
npm --prefix explorer ci            # exact versions from explorer/package-lock.json
npm --prefix explorer run build     # → public/explorer/explorer.js + lazy chunks
```

The site build does this itself. An `eleventy.before` hook in `.eleventy.js`
builds the explorer once per Eleventy process, so after editing `explorer/`,
restart `npm start`. The hook reruns `npm ci` when `explorer/package.json` or
`package-lock.json` changes. The bundle in `public/explorer/` is build output
and is not committed.

## API

```js
const { mount } = await import("/explorer/explorer.js");
const handle = mount(element, {
  id: "noaa-gfs-forecast",                     // STAC collection id (keys the colour ranges)
  href: "https://…/v0.2.7.icechunk",           // icechunk-https asset
  variables: [{ path, name, long_name, units, dims }],
  defaultVariable: "temperature_2m",           // name or path
  initialView: { bounds: [w, s, e, n] },       // or { longitude, latitude, zoom }
  proj4: null,                                 // override the CF grid mapping
  maxTextureLayers: 128,                       // cap on slider steps per texture (tests set it low)
  maxTextureBytes: 2e9,                        // estimated GPU memory above which the status warns
});
handle.project([lon, lat]);                    // → [x, y] CSS px on the map canvas
handle.destroy();
```

Nothing is fetched before `mount()`. It sets `element.dataset.state` to `loading`,
`ready` (the active layer's viewport has loaded and a frame is drawn for the
current labels) or `error`, and writes a readable message into the `role="status"`
line. It styles itself only with the site's CSS custom properties; the colormap is
the only hard-coded colour.

## How it works

- **Store** (`src/store.js`, the one place stores are opened). The repo is opened
  on `main` once. That pins the session to one snapshot, and every read after
  that (metadata, coordinates, shard indexes, chunks) goes through it. The
  mutable `repo` object is fetched with `cache: "no-cache"`, so a reload never
  opens a snapshot that a stale cached copy points at. Content-addressed objects
  (`snapshots/`, `manifests/`, `chunks/`, `transactions/`) use the normal HTTP
  cache. A plain zarr v3 URL, i.e. one ending in `.zarr`, opens with zarrita's
  `FetchStore` instead; the test harness uses this for synthetic
  grids. Virtual chunks (the `*-virtual` stores' GRIB messages on NOAA's and
  ECMWF's buckets) are read through a retrying fetch client
  (`src/grib/retry-fetch.js`): `ecmwf-forecasts` intermittently answers with a
  503 that has no CORS headers. The status line says "Upstream request failed
  (host), retrying (attempt n)…". A CORS-hidden failure can't be diagnosed, so it
  doesn't guess why. icechunk-js uses that client only for virtual chunks; reads from the
  dynamical buckets are unchanged.
  - Failed metadata, coordinate and grid reads are not cached (`src/lib/cache.js`),
    so Retry reads them again.
- **Codecs** (`src/codecs.js`). This is the single registration point. zarrita's
  defaults cover the materialized stores (sharding, blosc/zstd, crc32c,
  scale_offset).
  - The virtual stores add `gribberish`: gribberish (Rust) compiled to wasm, in
    `src/grib/`. It is built from `explorer/gribwasm/`; see its README.
  - Its factory imports the codec and its wasm (~150 KB gzip, one lazy chunk)
    only when an array that declares it is first read, so a materialized page
    never fetches it.
  - A variable whose codecs have no browser decoder stays in the select,
    disabled, with the reason.
- **Grid** (`src/lib/grid.js`, pure). GeoZarr attributes are built from the
  store's 1-D coordinate arrays:
  - The spacing must be uniform (relative tolerance 1e-3 of a step), otherwise it
    throws an error naming the coordinate.
  - Coordinates are cell centres, so `spatial:registration` is `"node"`.
  - Descending and ascending latitude are just the sign of the y step.
  - A 0..360 longitude grid keeps its origin and is drawn twice: once as-is and
    once shifted by −360, so its eastern half appears west of Greenwich.
  - Latitude/longitude grids are declared EPSG:4326. Our CF CRS is often a WMO
    sphere (r = 6,371,229 m); those degrees are drawn as WGS84 degrees on
    purpose, because a sphere→ellipsoid datum shift would move the field off its
    own coordinates.
  - Projected grids get a proj4 string, either `options.proj4` or one built from
    the CF grid mapping (`lambert_conformal_conic`, `rotated_latitude_longitude`
    via `ob_tran`), with x/y in the grid's own units. No datum shift here either.
  - `src/crs.js` resolves both locally. There is no epsg.io fetch.
- **Dims** (`src/lib/dims.js`, pure):
  - `init_time` is pinned to the newest run whose chunk at the domain centre
    exists. At most 4 candidates are checked, and each check reads only that
    shard's index (~2 KB suffix range). The index layout is validated against the
    array's codec metadata, and an unexpected layout is a clear error. "Present"
    means that chunk exists, not that the run is complete.
  - Virtual stores have no shard index. Instead, `init_time` is the newest run
    whose **final** lead's chunk exists, so the whole slider has data. Each check
    is a 1-byte read of that chunk's GRIB message; an unwritten chunk has no
    reference, and the read comes back empty. At most 8 runs are checked, newest
    first. Their analyses probe `time` the same way.
    - A probe read that fails (e.g. an upstream outage) is reported as "the
      upstream probe failed", not as "no run with data".
  - `lead_time`, or `time` for analyses, drives the slider. Analyses start at the
    newest time whose chunk the same probe finds, and show a no-data state if
    none is found.
  - When that chunk exists but its newest texture window is empty, the rest of
    the chunk is searched, then up to 3 earlier chunks. If all are empty, the
    explorer reports no data rather than a blank "Ready".
  - A forecast whose opening block is empty searches the following blocks, at most
    6 reads: e.g. an accumulation at +0 h, where a virtual store's block is that
    one step. Labels, reference read and colour range move to the step found
    together. If none has data, the explorer says so.
  - `ensemble_member` is pinned to 0 and labelled "member 0". Every other dim
    gets its own select, labelled with coordinate values and units (e.g. "500 hPa").
- **Texture blocks.** The ECMWF-example technique: one `ZarrLayer` per
  (variable, run, pinned indices, block). Every step of the block goes into one
  `r32float` 2D-array texture, and the shader picks the step, so scrubbing inside
  a block costs no requests.
  - A block is at most `min(maxTextureLayers ?? 128, MAX_ARRAY_TEXTURE_LAYERS)`
    steps and never crosses an inner chunk.
  - Analyses with 648–2,160-step chunks therefore upload a window, and
    re-upload when the slider leaves it.
  - Leaving a block replaces the layer, so an old field is never drawn under new
    labels.
  - **Whole-grid chunks** (the virtual stores: one GRIB message per chunk,
    e.g. 721×1440) go through the tile facade (`src/grib/tile-facade.js`).
    - ZarrLayer is given a view of the array with small tiles: 121 cells, and on
      lat/lon grids at most ~30° of latitude, so 61 on 0.5° grids.
    - deck.gl-raster's mesh refinement stops at 10,000 iterations, and a
      globe-sized tile then renders 1–3 cells off at mid-latitudes.
    - Each real chunk is read and decoded once and cut into tiles.
    - Reads in flight (deduplicated) are kept apart from decoded grids (a 4-entry
      LRU). Keys are the snapshot, the variable path and every non-spatial index.
    - Each read has its own abort controller and counts the tiles waiting for it.
      A tile that aborts stops waiting at once; the read is aborted only when no
      tile waits any more, and a queued read that nobody needs never starts.
    - `clear()` (variable or level change, Unload, destroy) aborts running reads,
      drops queued ones and discards late results.
    - A result or failure is only ever recorded for the entry still registered
      under its key.
    - The view also moves a level dim that follows the grid, e.g. `(…, latitude,
      longitude, pressure_level)`, in front of it, because deck.gl-zarr needs the
      spatial dims last.
    - A block is one step here, so each slider move reads one message
      (0.14–1.2 MB).
    - A new variable or level, Unload and destroy empty the LRU.
- **Resources:**
  - 4 concurrent tile requests per layer (each decodes a whole inner chunk on the
    main thread) and 64 cached tiles.
  - Textures are destroyed on tile unload *and* when a layer is retired. deck's
    `Tileset2D.finalize` aborts requests but never calls `onTileUnload`, so the
    explorer tracks textures per layer itself.
  - A tile that resolves after its layer was replaced creates no texture.
  - Unload aborts everything and frees the GPU; Load starts again.
    - Variable, level and step changes while unloaded read no weather data. They
      compose into one pending selection.
    - A newly chosen variable's level selects and slider are rebuilt from its
      metadata and coordinates. The old variable's controls can't change the
      pending one.
    - Load applies the selection with a fresh abort controller.
  - The retry client's backoff wait ends as soon as its request is aborted.
  - A GPU-memory estimate, advisory only:
    - Tiles in view × block steps × tile cells × 4 B is estimated from the view's
      corners.
    - Above `maxTextureBytes` (2 GB, an application heuristic), a warning line
      appears beside the status (`[data-warning="gpu"]`) and the view keeps
      loading. It never sets the error state and never withholds layers.
    - IMERG at the global view is estimated at about 2.5 GB, so it warns; GFS at
      the global view is about 0.44 GB, so it doesn't.
    - The estimate doesn't bound network or decode.
  - The actual device limits are enforced: blocks never exceed
    `MAX_ARRAY_TEXTURE_LAYERS`, and a tile wider than `MAX_TEXTURE_SIZE` is a
    named error.
- **Colour.** Turbo, with NaN and missing sentinels (`_FillValue`,
  `missing_value`, or a finite zarr `fill_value`) transparent.
  - Units that are recognisably Celsius use a fixed −40..50.
  - Everything else uses the 2nd–98th percentile of one fixed reference read: the
    block and chunk at the initial view's centre, sampled at a stride (≤100k
    values). The range is frozen per dataset + variable + pinned indices.
  - A sample that is empty or all one value (e.g. no rain at the initial view) is
    **not** frozen. The first loaded tile block whose values vary, after a pan,
    zoom or step, sets the range and freezes it.
  - That reference read is handed to the tile that needs the same chunk, so it
    isn't fetched twice.
  - The legend says whether the range is fixed or sample-based, and says so when
    the sample was empty or all one value (and that it will update).
- **Basemap.** world-atlas `countries-50m` borders from jsdelivr, fetched lazily,
  drawn in the page's text colour with `wrapLongitude`.

## Upstream workarounds

- **EPSG:3857 `+over`** (`defineWebMercatorOver` in `src/crs.js`). With node
  registration, a global grid's west edge is at −180.125°, and stock 3857 wraps
  it to +179.875°. The result was a globe-wide smeared tile column and a mesh
  refinement that never converges. `+over` keeps longitudes unwrapped. It is
  applied once to the proj4 instance deck.gl-zarr shares (one deduped copy, per
  the lockfile).
- **`minZoom` 0.** deck.gl-raster 0.8.1 selects no tiles below zoom 0, and
  `minZoom ≤ −1` hangs `Tileset2D` in an infinite parent walk. So the camera
  stops at 0, and a narrow phone can't show the whole globe.
- **Local EPSG resolver.** `ZarrLayer`'s default fetches `epsg.io`. Projected
  grids use a placeholder `EPSG:0` that the resolver maps to the grid's own proj4
  definition, because geozarr only accepts `AUTHORITY:NUMBER` codes.
- **Texture disposal on layer removal.** See Resources above.
- **`process.env.NODE_ENV`.** It is defined at build time because Vite library
  mode leaves it in dependencies.

## Tests

`npm test` at the repo root runs `test/explorer-*.test.mjs` offline. They import
`src/lib/*.js` directly, so they need no build and no `explorer/node_modules`. They
cover:
- the grid transforms: descending and ascending latitude, 0..360, non-uniform
  coordinates;
- proj4 strings from CF;
- dims classification and block math;
- CF time labels;
- Float32 conversion, fill values and the colour range;
- the shard-index probe on a byte fixture;
- the empty-tail analysis search and the virtual latest-chunk walk-back;
- layouts with a trailing level dim;
- the failure-evicting promise cache;
- the GRIB codec against gribberish's Python codec, on fixtures for DRS 5.0,
  5.0 + bitmap, 5.3, 5.3 + bitmap and 5.42;
- the retrying fetch client;
- the tile facade.
