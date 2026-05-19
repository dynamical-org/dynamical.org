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
// append a `<div class="plots">` block of the three R2 plots that share
// the variable's name as a filename suffix.
function injectVariablePlots(html) {
  const re = /(<h3 id="[^"]*"><code>([^<]+)<\/code><\/h3>)([\s\S]*?)(?=<h[23][\s>]|$)/g;
  return html.replace(re, (_full, heading, varName, body) => {
    const v = varName;
    const plots =
      `<div class="plots">` +
      `<a href="nulls_${v}.png" target="_blank">` +
      `<img src="nulls_${v}.png" alt="${escapeAttr(v)} — null fraction"></a>` +
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

function wrapTables(html) {
  return html.replace(
    /(<table>[\s\S]*?<\/table>)/g,
    '<div class="table-scroll">$1</div>',
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

// Layout: the report body is centered at the same max-width as the
// rest of the site (78rem), unaffected by the TOC. The TOC lives in a
// rail anchored just outside the wrapper's left edge (so it sits in
// what would otherwise be empty page margin) and stays sticky as the
// page scrolls. Below ~1180px the rail collapses back into the flow
// and renders above the content.
//
// Typography, link colors, base table style come from main.css.
// Nested-tree styling + ▸ indicator come from lib/markdown-toc CSS.
const CSS = `
.validation-wrapper {
  position: relative;
  max-width: 78rem;
  margin: 0 auto;
}
.validation-toc-rail {
  position: absolute;
  top: 0;
  right: calc(100% + 2rem);
  width: 18rem;
  height: 100%;
  padding-right: 1rem;
  border-right: 1px solid var(--border-muted-color);
}
.md-toc {
  position: sticky;
  top: 2rem;
  font-size: 1.2rem;
  max-height: calc(100vh - 4rem);
  overflow-y: auto;
}

.validation-body {
  font-size: 1.4rem;
}
.validation-breadcrumb { margin-bottom: 2rem; }
.validation-body h2 { margin-top: 3.2rem; }
.validation-body h3 { margin-top: 2.4rem; }
.validation-body .plots {
  display: flex; flex-direction: column;
  gap: 1rem; margin: 1rem 0 2rem;
}
.validation-body .plots a { display: block; }
.validation-body .plots img {
  display: block; max-width: 100%; height: auto;
  border: 1px solid var(--border-color);
  background: var(--bg-color);
}
.validation-body .table-scroll {
  overflow-x: auto; margin: 1rem 0 2rem;
}
.validation-body .table-scroll table {
  border-collapse: collapse;
  border: 1px solid var(--border-color);
  margin: 0;
  max-width: 100%;
}
.validation-body .table-scroll th,
.validation-body .table-scroll td {
  padding: 0.8rem 1.6rem;
  vertical-align: top;
  border-right: 1px dotted var(--border-muted-color);
}
.validation-body .table-scroll th {
  border-bottom: 1px solid var(--border-color);
  font-weight: 700;
}

@media (max-width: 1180px) {
  /* Rail collapses out of the left margin and renders in document flow
     instead — inside validation-body, after the breadcrumb + H1. */
  .validation-toc-rail {
    position: static;
    width: auto;
    height: auto;
    margin: 0 0 2.4rem;
    padding-right: 0;
    border-right: none;
  }
  .md-toc {
    position: static;
    max-height: none;
    overflow: visible;
    padding: 0;
  }
  /* No indicator and no nested subheaders when the TOC is in-flow —
     it's just a flat list of section links right under the title.
     Once the user scrolls past it, it's off-screen and the scroll-spy
     wouldn't be useful, so we skip the visual effects entirely. */
  .md-toc a { padding-left: 0; }
  .md-toc a::before { display: none; }
  .md-toc .toc-h3 { display: none; }
  .md-toc .toc-h2 > ul { display: none; }

  .validation-body .table-scroll table { font-size: 1.2rem; }
  .validation-body .table-scroll th,
  .validation-body .table-scroll td {
    padding: 0.4rem 0.8rem;
  }
}
${markdownToc.CSS}
`;

function renderFragment({ datasetId, baseUrl, markdown }, datasetName) {
  let html = md.render(markdown);
  html = stripH1(html);
  html = pngLinksOpenInNewTab(html);

  const annotated = markdownToc.annotateHeadings(html);
  html = annotated.html;

  html = injectVariablePlots(html);
  html = wrapTables(html);
  html = rewriteAssetUrls(html, baseUrl);

  const tocHtml = markdownToc.buildTocHtml(annotated.headings);
  const breadcrumbName = datasetName || datasetId;
  const pageTitle = `${breadcrumbName} validation report`;

  // The TOC rail lives inside .validation-body, after the breadcrumb
  // and H1. On wide viewports it absolute-positions itself out of flow
  // into the left margin (containing block = .validation-wrapper). On
  // narrow viewports it goes static and renders right under the H1.
  return `<div class="validation-wrapper">
  <div class="md-toc-content validation-body">
    <div class="validation-breadcrumb">
      <a href="/catalog">Catalog</a> >
      <a href="/catalog/${datasetId}/">${breadcrumbName}</a> >
      Validation report
    </div>
    <h1>${pageTitle}</h1>
    <div class="validation-toc-rail">
      <nav class="md-toc" aria-label="Table of contents">${tocHtml}</nav>
    </div>
    ${html}
  </div>
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
