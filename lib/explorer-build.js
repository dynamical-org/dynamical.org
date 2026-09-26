// Builds the catalog explorer (explorer/), a separate Vite package whose
// bundle lands in public/explorer/. It runs from .eleventy.js's
// eleventy.before hook rather than an npm script, because the Cloudflare Pages
// build doesn't run `npm run build`, so a script-only step never reaches the
// deploy.
//
// It builds once per process (Vite takes about a second); watch-mode rebuilds
// reuse it, so restart `npm start` after editing explorer/. `npm ci` reruns
// whenever package.json or package-lock.json differs from the last successful
// install, or Vite is missing, so a dependency bump or a half-finished install
// never builds with stale packages. The marker is written only after `npm ci`
// succeeds, and a failed install or build throws, failing the site build.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MARKER = ".installed-sha256";

function installFingerprint(root) {
  const hash = crypto.createHash("sha256");
  for (const f of ["package.json", "package-lock.json"]) hash.update(fs.readFileSync(path.join(root, f)));
  return hash.digest("hex");
}

// `exec(cmd, args, options)` defaults to execFileSync; tests inject a fake.
function makeExplorerBuilder(root, exec = require("child_process").execFileSync) {
  let built = false;
  return function buildExplorer() {
    if (built) return;
    const want = installFingerprint(root);
    const marker = path.join(root, "node_modules", MARKER);
    const have = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
    if (have !== want || !fs.existsSync(path.join(root, "node_modules", ".bin", "vite"))) {
      exec("npm", ["ci"], { cwd: root, stdio: "inherit" });
      fs.writeFileSync(marker, want);
    }
    exec("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
    built = true;
  };
}

module.exports = { makeExplorerBuilder, installFingerprint, MARKER };
