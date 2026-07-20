// Per-dataset validation report page. Renders validation_summary.md
// (published by dynamical-org/reformatters to R2) into a near-identical
// layout to the standalone HTML report at
// https://dataset-validation-reports.dynamical.org/<dataset-id>/latest/validation_report.html.
//
// Mirrors reformatters' src/scripts/validation/render.py output — the
// same post-process transforms over markdown-it's HTML, plus per-
// variable plot injection. Image refs in the markdown are bare
// filenames and get resolved against the report's baseUrl so the
// rendered page can load them directly from R2.
//
// Page chrome and the scroll-spy TOC come from base.njk + main.css +
// lib/markdown-toc.js. Everything in this file is validation-specific.

const MarkdownIt = require("markdown-it");
const markdownToc = require("../../lib/markdown-toc.js");

const md = new MarkdownIt("commonmark").enable("table");

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Plot files R2 holds for each variable, keyed by the bold section label
// that accompanies the plot in the variable's markdown body. Listed in the
// order reformatters' render.py emits them.
const PLOT_SECTIONS = [
  ["Nulls", "nulls", "null fraction"],
  ["Point time series", "value_timeseries", "full-period value time series"],
  ["Spatial", "spatial", "spatial comparison"],
  ["Temporal", "temporal", "time series comparison"],
  ["Availability", "availability", "availability over append dim"],
];

// Filesystem-safe form of a (possibly group-pathed) variable name, matching
// reformatters' scripts/validation/utils.py var_slug: group vars like
// `model_level/temperature` are stored as `model_level__temperature.png`.
function varSlug(v) {
  return v.replace(/\//g, "__");
}

// Per-variable heading rows in the markdown are `### \`name\``, which
// markdown-it renders as `<h3><code>name</code></h3>`. For each one, append
// a `<div class="plots">` block of the R2 plots for that variable.
//
// Which plots a report carries — and their order — is derived from the bold
// section labels present in the variable's body, so one code path renders
// both report styles: materialized (Nulls, Spatial, Temporal) and virtual
// (Point time series, Spatial, Temporal, Availability).
function injectVariablePlots(html) {
  const re =
    /(<h3 id="[^"]*"><code>([^<]+)<\/code><\/h3>)([\s\S]*?)(?=<h[23][\s>]|$)/g;
  return html.replace(re, (_full, heading, varName, body) => {
    const slug = varSlug(varName);
    const plots = PLOT_SECTIONS.filter(([label]) =>
      body.includes(`<strong>${label}</strong>`),
    )
      .map(
        ([, prefix, alt]) =>
          `<a href="${prefix}_${slug}.png" target="_blank">` +
          `<img src="${prefix}_${slug}.png" alt="${escapeAttr(varName)} — ${alt}"></a>`,
      )
      .join("");
    return `${heading}${body}<div class="plots">${plots}</div>`;
  });
}

function pngLinksOpenInNewTab(html) {
  return html.replace(
    /<a href="([^"]+\.png)">/g,
    '<a href="$1" target="_blank">',
  );
}

// Apply the site's .table-container + .data table classes so markdown
// tables match the catalog page. The site-wide .table-container rule
// lets tables overflow their parent into the page margins when the
// viewport has room and only scrolls horizontally when the viewport is
// narrower than the table.
function styleTables(html) {
  return html.replace(
    /<table>([\s\S]*?)<\/table>/g,
    '<div class="table-container"><table class="data">$1</table></div>',
  );
}

// The page generates its own H1 from the catalog entry name, so any H1
// emitted by the rendered markdown is redundant. reformatters PR #614
// drops the H1 from validation_summary.md; this strip keeps the page
// looking right against both the current bucket output (still includes
// the H1) and the post-#614 output (no H1).
function stripH1(html) {
  return html.replace(/<h1>[\s\S]*?<\/h1>\s*/g, "");
}

// Resolve bare-filename src/href on <img>/<a> against baseUrl. Anything
// that already looks absolute (scheme, protocol-relative, root-relative,
// or a bare fragment) is left alone — only relative refs get rewritten.
function rewriteAssetUrls(html, baseUrl) {
  const isAbsolute = (u) =>
    /^[a-z][a-z0-9+.-]*:/i.test(u) ||
    u.startsWith("//") ||
    u.startsWith("/") ||
    u.startsWith("#");
  const rewriteAttr = (input, attr) =>
    input.replace(
      new RegExp(`(<(?:img|a)\\b[^>]*\\s${attr}=")([^"]+)(")`, "g"),
      (full, pre, url, post) =>
        isAbsolute(url) ? full : `${pre}${baseUrl}${url}${post}`,
    );
  return rewriteAttr(rewriteAttr(html, "src"), "href");
}

function extractDatasetName(mdText, fallback) {
  const m = mdText.match(/^\|\s*Validation\s*\|\s*([^|]+?)\s*\|/m);
  return m ? m[1] : fallback;
}

// Validation-specific styles only: the per-variable plot block under
// each <h3><code>name</code></h3>. Layout (wrapper, toc rail, sticky,
// narrow-mode collapse) comes from lib/markdown-toc CSS; everything
// else (max-width, typography, tables, link colors) comes from
// main.css's .content + table.data + base type rules.
const CSS = `
.plots {
  display: flex; flex-direction: column;
  gap: 1rem; margin: 1rem 0 2rem;
}
.plots a { display: block; }
.plots img {
  display: block; max-width: 100%; height: auto;
  border: 1px solid var(--border-color);
  background: var(--bg-color);
}
/* Validation reports embed long unbroken identifiers (variable names,
   s3:// URLs, filenames) in <code> spans and h3 headings. Let them
   break anywhere so they don't force horizontal scroll on mobile. */
.md-toc-content code { overflow-wrap: anywhere; }
.md-toc-content h3 { overflow-wrap: anywhere; }
/* Keep table cells on one line — .table-container already provides
   horizontal scroll when the table is wider than the viewport. */
.md-toc-content table.data td,
.md-toc-content table.data th { white-space: nowrap; }
${markdownToc.CSS}
`;

function renderFragment({ datasetId, baseUrl, markdown }, datasetName) {
  let html = md.render(markdown);
  html = stripH1(html);
  html = pngLinksOpenInNewTab(html);

  const annotated = markdownToc.annotateHeadings(html);
  html = annotated.html;

  html = injectVariablePlots(html);
  html = styleTables(html);
  html = rewriteAssetUrls(html, baseUrl);

  const tocHtml = markdownToc.buildTocHtml(annotated.headings);
  const breadcrumbName = datasetName || datasetId;
  const pageTitle = `${breadcrumbName} validation report`;

  // .content gives the standard 78rem max-width + centering. The TOC
  // rail absolute-positions itself out of flow into the left margin
  // (containing block = .md-toc-content). On narrow viewports the rail
  // goes static and renders here in flow, under the H1.
  return `<div class="content md-toc-content">
  <div>
    <a href="/catalog">Catalog</a> >
    <a href="/catalog/${datasetId}/">${breadcrumbName}</a> >
    Validation report
  </div>
  <h1>${pageTitle}</h1>
  <div class="md-toc-rail">
    <nav class="md-toc" aria-label="Table of contents">${tocHtml}</nav>
  </div>
  ${html}
  <style>${CSS}</style>
  <script>${markdownToc.JS}</script>
</div>`;
}

class ValidationReportPage {
  data() {
    return {
      layout: "base.njk",
      pagination: {
        data: "validationReports.entries",
        size: 1,
        alias: "entry",
        addAllPagesToCollections: true,
      },
      permalink: ({ entry }) => `catalog/${entry.datasetId}/validation/`,
      eleventyComputed: {
        title: ({ entry }) => `Validation report — ${entry.datasetId}`,
        socialTitle: ({ entry }) => `${entry.datasetId} validation report`,
        description: ({ entry }) =>
          `Completeness, spatial, temporal, and availability checks for the ${entry.datasetId} weather dataset.`,
      },
    };
  }

  render({ entry, catalog }) {
    const catalogEntry =
      catalog && catalog.entries
        ? catalog.entries.find((e) => e.id === entry.datasetId)
        : null;
    const datasetName =
      (catalogEntry && catalogEntry.title) ||
      extractDatasetName(entry.markdown, entry.datasetId);
    return renderFragment(entry, datasetName);
  }
}

module.exports = ValidationReportPage;
module.exports.renderFragment = renderFragment;
