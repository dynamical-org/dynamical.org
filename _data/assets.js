// Content-hash of static assets, for cache-busting their URLs.
//
// Cloudflare Pages serves /main.css with `Cache-Control: public,
// max-age=14400` (4h), so a CSS change can take up to 4h to reach consumers
// who already cached the old file. Appending `?v=<hash>` changes the URL
// whenever the file's contents change, forcing a fresh fetch. The HTML itself
// is served `max-age=0, must-revalidate`, so the new markup — and the new
// versioned URL — reaches consumers immediately on their next navigation.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function hash(file) {
  const buf = fs.readFileSync(path.join(__dirname, "..", "public", file));
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
}

module.exports = {
  mainCss: hash("main.css"),
};
