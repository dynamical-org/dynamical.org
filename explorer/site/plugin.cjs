// The explorer's Eleventy plugin, and its whole footprint on the site:
// .eleventy.js adds it, and content/catalog-pages.njk calls {% explorer entry %}
// where the Explore section goes. It
// - builds the explorer bundle (build.cjs) before each build, into explorer/dist/;
// - copies that bundle to /explorer/;
// - renders the section: an empty-map preview with the load button, its styles
//   (section.css) and the click loader (loader.js). Datasets not listed in
//   datasets.cjs render nothing.
const fs = require("fs");
const path = require("path");
const fetch = require("@11ty/eleventy-fetch");
const { makeExplorerBuilder } = require("./build.cjs");
const { datasets } = require("./datasets.cjs");
const { explorerMountOptions } = require("./mount-options.cjs");
const { previewSvg } = require("./preview.cjs");

const ROOT = path.join(__dirname, "..");

// The file the explorer draws its borders from (explorer/src/explorer.js).
const BORDERS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";

const CSS = fs.readFileSync(path.join(__dirname, "section.css"), "utf8");
const LOADER = fs.readFileSync(path.join(__dirname, "loader.js"), "utf8");

const escapeAttribute = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The Explore section for one catalog entry, or "" when it has no explorer.
// `previews` maps dataset ids to their empty-map SVG.
function exploreSection(entry, previews) {
  const options = explorerMountOptions(entry, datasets);
  if (!options) return "";
  return `<style>
${CSS}</style>
<section class="explore" aria-labelledby="explore-heading" data-options="${escapeAttribute(JSON.stringify(options))}">
  <h2 id="explore-heading">Explore</h2>
  <div class="explore-map">
    ${previews.get(entry.id)}
    <button type="button">Load interactive map</button>
  </div>
</section>
<script type="module">
${LOADER}</script>`;
}

module.exports = function explorerPlugin(eleventyConfig) {
  const buildExplorer = makeExplorerBuilder(ROOT);
  const previews = new Map();
  eleventyConfig.on("eleventy.before", async () => {
    buildExplorer();
    if (previews.size) return;
    const topology = await fetch(BORDERS_URL, { duration: "1d", type: "json" });
    for (const d of datasets) previews.set(d.id, previewSvg(topology, d.initialView.bounds));
  });
  eleventyConfig.addPassthroughCopy({ [`./${path.relative(process.cwd(), ROOT)}/dist/`]: "/explorer/" });
  eleventyConfig.addShortcode("explorer", (entry) => exploreSection(entry, previews));
};

module.exports.exploreSection = exploreSection;
