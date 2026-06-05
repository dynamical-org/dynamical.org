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

// Per-variable heading rows in the markdown are `### \`name\``, which
// markdown-it renders as `<h3><code>name</code></h3>`. For each one,
// append a `<div class="plots">` block of the R2 plots that share the
// variable's name as a filename suffix, in the order reformatters'
// render.py emits them: nulls, value_timeseries, spatial, temporal.
//
// The full-period value_timeseries plot only exists for reports built
// after reformatters PR #641, so it's injected only when this variable's
// section carries the matching "Point time series statistics for the full
// period" table (written alongside the plot by summary.py). Reports that
// predate #641 keep the original three plots and pick up the fourth
// automatically once their report is regenerated — no code change needed.
function injectVariablePlots(html) {
  const re = /(<h3 id="[^"]*"><code>([^<]+)<\/code><\/h3>)([\s\S]*?)(?=<h[23][\s>]|$)/g;
  return html.replace(re, (_full, heading, varName, body) => {
    const v = varName;
    const valueTimeseriesPlot = /Point time series statistics for the full period/.test(
      body,
    )
      ? `<a href="value_timeseries_${v}.png" target="_blank">` +
        `<img src="value_timeseries_${v}.png" alt="${escapeAttr(v)} — full-period value time series"></a>`
      : "";
    const plots =
      `<div class="plots">` +
      `<a href="nulls_${v}.png" target="_blank">` +
      `<img src="nulls_${v}.png" alt="${escapeAttr(v)} — null fraction"></a>` +
      valueTimeseriesPlot +
      `<a href="spatial_${v}.png" target="_blank">` +
      `<img src="spatial_${v}.png" alt="${escapeAttr(v)} — spatial comparison"></a>` +
      `<a href="temporal_${v}.png" target="_blank">` +
      `<img src="temporal_${v}.png" alt="${escapeAttr(v)} — time series comparison"></a>` +
      `</div>`;
    return `${heading}${body}${plots}`;
  });
}

function pngLinksOpenInNewTab(html) {
  return html.replace(/<a href="([^"]+\.png)">/g, '<a href="$1" target="_blank">');
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
      },
      permalink: ({ entry }) => `catalog/${entry.datasetId}/validation/`,
      eleventyComputed: {
        title: ({ entry }) => `Validation report — ${entry.datasetId}`,
      },
    };
  }

  render({ entry, catalog }) {
    const catalogEntry =
      catalog && catalog.entries
        ? catalog.entries.find((e) => e.dataset_id === entry.datasetId)
        : null;
    const datasetName =
      (catalogEntry && catalogEntry.name) ||
      extractDatasetName(entry.markdown, entry.datasetId);
    return renderFragment(entry, datasetName);
  }
}

module.exports = ValidationReportPage;
module.exports.renderFragment = renderFragment;
