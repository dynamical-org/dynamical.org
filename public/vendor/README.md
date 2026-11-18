# Vendored client libraries

The status pages render with [Preact](https://preactjs.com) through
[htm](https://github.com/developit/htm) tagged templates, so there is no build
step for client JavaScript: these files are served as-is by the passthrough
copy of `public/`.

| File                       | Package          | Version | Source in the npm tarball |
| -------------------------- | ---------------- | ------- | ------------------------- |
| `preact-10.29.8.mjs`       | `preact`         | 10.29.8 | `dist/preact.mjs`         |
| `preact-hooks-10.29.8.mjs` | `preact` (hooks) | 10.29.8 | `hooks/dist/hooks.mjs`    |
| `htm-3.1.1.mjs`            | `htm`            | 3.1.1   | `dist/htm.mjs`            |
| `plot-0.6.17.mjs`          | `@observablehq/plot` | 0.6.17 | `src/index.js`, bundled with all dependencies |

Two things are ours:

- `preact-hooks-10.29.8.mjs` imports its versioned Preact sibling instead of
  the bare specifier `"preact"` the tarball ships, since nothing resolves bare
  specifiers here.
- `preact-htm.mjs` is a small shim that binds `html` to Preact's `h` and
  re-exports everything a page needs, so a page imports one module.

To upgrade: `npm pack preact@<version> htm@<version>`, copy the three files
from the tarballs under filenames containing the new versions, re-apply the
one-line import rewrite in the versioned hooks file, update the shim to import
the new filenames, and delete the old versioned files. Old URLs may stay cached,
but nothing will reference them.

The scorecard's Plot module is a self-contained, minified ESM bundle; its
dependency licenses are collected in `LICENSE.plot`. To upgrade, run
`node scripts/vendor-plot.mjs <version>` from the repository root. The script
installs the exact Plot version and pinned esbuild in a temporary directory,
then refreshes the bundle and licenses without adding project dependencies.
Point `getPlot` in `public/scorecard.js` at the new file (the e2e fixtures load
Plot through it), update the table above, and delete the old file.
Replace the old version's immutable cache entry in `public/_headers` with an
entry for the new filename.
Before upgrading to 0.6.18 or later, follow [#318's caution about null leads and
the hover fixtures](https://github.com/dynamical-org/dynamical.org/pull/318).
