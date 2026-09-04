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
