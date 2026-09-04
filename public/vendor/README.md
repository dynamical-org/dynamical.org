# Vendored client libraries

The status pages render with [Preact](https://preactjs.com) through
[htm](https://github.com/developit/htm) tagged templates, so there is no build
step for client JavaScript: these files are served as-is by the passthrough
copy of `public/`.

| File                | Package                    | Version | Source in the npm tarball  |
| ------------------- | -------------------------- | ------- | -------------------------- |
| `preact.mjs`        | `preact`                   | 10.29.8 | `dist/preact.mjs`          |
| `preact-hooks.mjs`  | `preact` (hooks)           | 10.29.8 | `hooks/dist/hooks.mjs`     |
| `htm.mjs`           | `htm`                      | 3.1.1   | `dist/htm.mjs`             |

Two things are ours:

- `preact-hooks.mjs` imports `from "./preact.mjs"` instead of the bare
  specifier `"preact"` the tarball ships, since nothing resolves bare
  specifiers here.
- `preact-htm.mjs` is a small shim that binds `html` to Preact's `h` and
  re-exports everything a page needs, so a page imports one module.

To upgrade: `npm pack preact@<version> htm@<version>`, copy the three files
from the tarballs, re-apply the one-line import rewrite in `preact-hooks.mjs`,
and update the table above.
