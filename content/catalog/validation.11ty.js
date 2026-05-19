// Per-dataset validation report page. Renders validation_summary.md
// (published by dynamical-org/reformatters to R2) into a near-identical
// layout to the standalone HTML report at
// https://dataset-validation-reports.dynamical.org/<dataset-id>/latest/validation_report.html.
//
// Mirrors reformatters' src/scripts/validation/render.py output — the
// same post-process transforms over markdown-it's HTML. Image refs in
// the markdown are bare filenames and get resolved against the report's
// baseUrl so the rendered page can load them directly from R2.
//
// The page inherits site chrome (base.njk + main.css). The TOC sits to
// the left of the centered max-width content on wide viewports and
// stacks above it on narrow ones.

const MarkdownIt = require("markdown-it");

const md = new MarkdownIt("commonmark").enable("table");

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Per-variable headings render as <h3><code>name</code></h3>; other ### don't.
function extractPerVarNames(html) {
  return [...html.matchAll(/<h3><code>([^<]+)<\/code><\/h3>/g)].map((m) => m[1]);
}

function wrapVariableSections(html) {
  const re = /<h3><code>([^<]+)<\/code><\/h3>([\s\S]*?)(?=<h[23][\s>]|$)/g;
  return html.replace(re, (_full, varName, body) => {
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
    return (
      `<section class="variable" id="var-${v}">` +
      `<h3 class="var-heading"><code>${v}</code></h3>` +
      `${body}${plots}</section>`
    );
  });
}

function annotateH2(html) {
  const sections = [];
  const out = html.replace(/<h2>([\s\S]*?)<\/h2>/g, (_full, inner) => {
    const plain = inner.replace(/<[^>]+>/g, "").trim();
    const slug = slugify(plain);
    sections.push({ slug, title: plain });
    return `<h2 id="${slug}">${inner}</h2>`;
  });
  return { html: out, sections };
}

function annotateNonVarH3(html) {
  return html.replace(/<h3>([\s\S]*?)<\/h3>/g, (full, inner) => {
    if (inner.startsWith("<code>")) return full;
    const plain = inner.replace(/<[^>]+>/g, "").trim();
    const slug = slugify(plain);
    return `<h3 id="${slug}">${inner}</h3>`;
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

function buildToc(sections, variables) {
  const sectionItems = sections
    .map((s) => `<li><a href="#${s.slug}">${s.title}</a></li>`)
    .join("");
  const varItems = variables
    .map((v) => `<li><a href="#var-${v}">${v}</a></li>`)
    .join("");
  return `
<aside class="validation-toc" aria-label="Table of contents">
  <div class="toc-heading">Sections</div>
  <ul>${sectionItems}</ul>
  <div class="toc-heading">Variables</div>
  <ul>${varItems}</ul>
</aside>
`;
}

// Layout: the report body is centered at the same max-width as the
// rest of the site (78rem), unaffected by the TOC. The TOC lives in a
// rail anchored just outside the wrapper's left edge (so it sits in
// what would otherwise be empty page margin) and is right-aligned so
// its items sit flush against the content's left edge. It stays sticky
// as the page scrolls. Below ~1180px the rail collapses back into the
// flow and renders above the content.
//
// Typography, link colors, base table style come from main.css.
const CSS = `
.validation-wrapper {
  position: relative;
  max-width: 78rem;
  margin: 0 auto;
}
.validation-toc-rail {
  position: absolute;
  top: 0;
  right: calc(100% + 3rem);
  width: 18rem;
  height: 100%;
}
.validation-toc {
  position: sticky;
  top: 2rem;
  font-size: 1.2rem;
  max-height: calc(100vh - 4rem);
  overflow-y: auto;
  text-align: right;
}
.validation-toc .toc-heading {
  font-size: 1.3rem;
  color: var(--header-color);
  margin: 1.4rem 0 0.6rem;
  font-weight: 700;
}
.validation-toc .toc-heading:first-child { margin-top: 0; }
.validation-toc ul { list-style: none; padding: 0; margin: 0; }
.validation-toc li { margin: 0.2rem 0; }
.validation-toc a {
  color: var(--text-color);
  text-decoration: none;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.validation-toc a:visited { color: var(--text-color); }
.validation-toc a:hover { color: var(--link-color); }

.validation-body {
  font-size: 1.4rem;
}
.validation-breadcrumb { margin-bottom: 2rem; }
.validation-body h2 { margin-top: 3.2rem; }
.validation-body h3 { margin-top: 2.4rem; }
.validation-body section.variable { margin-top: 2.4rem; }
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
  .validation-toc-rail {
    position: static;
    width: auto;
    height: auto;
    margin-bottom: 1.6rem;
  }
  .validation-toc {
    position: static;
    max-height: none;
    overflow: visible;
    padding: 1rem 0;
    text-align: left;
  }
  .validation-body .table-scroll table { font-size: 1.2rem; }
  .validation-body .table-scroll th,
  .validation-body .table-scroll td {
    padding: 0.4rem 0.8rem;
  }
}
`;

function renderFragment({ datasetId, baseUrl, markdown }, datasetName) {
  let html = md.render(markdown);
  html = pngLinksOpenInNewTab(html);
  const variables = extractPerVarNames(html);
  const annotated = annotateH2(html);
  html = annotated.html;
  html = annotateNonVarH3(html);
  html = wrapVariableSections(html);
  html = wrapTables(html);
  html = rewriteAssetUrls(html, baseUrl);

  const toc = buildToc(annotated.sections, variables);
  const breadcrumbName = datasetName || datasetId;

  return `<div class="validation-wrapper">
  <div class="validation-toc-rail">${toc}</div>
  <article class="validation-body">
    <div class="validation-breadcrumb">
      <a href="/catalog">Catalog</a> >
      <a href="/catalog/${datasetId}/">${breadcrumbName}</a> >
      Validation report
    </div>
    ${html}
  </article>
  <style>${CSS}</style>
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
