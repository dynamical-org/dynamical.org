// Per-dataset validation report page. Renders validation_summary.md
// (published by dynamical-org/reformatters to R2) into a near-identical
// layout to the standalone HTML report at
// https://dataset-validation-reports.dynamical.org/<dataset-id>/latest/validation_report.html.
//
// Mirrors reformatters' src/scripts/validation/render.py — the same five
// post-process transforms over markdown-it's HTML output, the same sidebar
// TOC, the same CSS, the same checkbox-toggle JS. Image references in the
// markdown are bare filenames and get resolved against the report's baseUrl
// so the rendered page can load them directly from R2.

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
  // Match a variable heading and everything up to the next h2/h3 or EOF.
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
      `<section class="variable" id="var-${v}" data-var="${escapeAttr(v)}">` +
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

// Resolve bare-filename src/href on <img>/<a> against baseUrl. Anything that
// already looks absolute (scheme, protocol-relative, root-relative, or a bare
// fragment) is left alone — only relative refs get rewritten, matching how a
// browser would resolve them when loading the standalone HTML next to the
// markdown.
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

function buildToc(sections, variables, datasetName, datasetId) {
  const sectionItems = sections
    .map((s) => `<li><a href="#${s.slug}">${s.title}</a></li>`)
    .join("");
  const varItems = variables
    .map(
      (v) =>
        `<li class="var-row"><input type="checkbox" checked data-var="${escapeAttr(v)}" ` +
        `id="cb-${v}"><a href="#var-${v}">${v}</a></li>`,
    )
    .join("");
  return `
<nav class="toc" aria-label="Table of contents">
  <div class="toc-back"><a href="/catalog/${datasetId}/">← ${datasetId}</a></div>
  <div class="toc-heading">${datasetName}</div>
  <ul>${sectionItems}</ul>
  <div class="toc-heading">Variables</div>
  <div class="var-actions">
    <button type="button" data-action="all">all</button>
    <button type="button" data-action="none">none</button>
  </div>
  <ul>${varItems}</ul>
</nav>
`;
}

// CSS ported verbatim from reformatters' render.py _CSS, with one addition:
// a `.toc-back` rule for the breadcrumb back to /catalog/<id>/.
const CSS = `
:root {
  color-scheme: light dark;
  --bg-color: #ffffff;
  --text-color: #111111;
  --header-color: #111111;
  --link-color: #0b57d0;
  --link-visited-color: #6f42c1;
  --border-color: #111111;
  --border-muted-color: #444444;
  --muted-text: #666666;
  --muted-text-2: #999999;
  --pill-muted-bg: #f0f0f0;
  --pill-muted-fg: #111111;
  --pill-muted-border: #d0d0d0;
  --sidebar: 28rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg-color: #0f0f10;
    --text-color: #e8e8ea;
    --header-color: #ffffff;
    --link-color: #8ab4f8;
    --link-visited-color: #c58af9;
    --border-color: #e8e8ea;
    --border-muted-color: #b5b5b5;
    --muted-text: #b5b5b5;
    --muted-text-2: #8f8f93;
    --pill-muted-bg: #2a2a2d;
    --pill-muted-fg: #e8e8ea;
    --pill-muted-border: #3a3a3d;
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { font-size: 62.5%; }
body, input, button, h1, h2, h3, h4, h5, h6 {
  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
body {
  margin: 0;
  font-size: 1.4rem;
  line-height: 1.6;
  color: var(--text-color);
  background-color: var(--bg-color);
}
a { color: var(--link-color); }
a:visited { color: var(--link-visited-color); }
h1, h2, h3, h4, h5, h6 {
  font-weight: 700;
  margin-top: 2rem;
  margin-bottom: 1rem;
  color: var(--header-color);
}
p { margin-bottom: 1.2rem; }

table { border-collapse: collapse; border: 1px solid var(--border-color);
        margin: 1rem 0 2rem; max-width: 100%; }
th, td { padding: 0.8rem 1.6rem; text-align: left; vertical-align: top;
         border-right: 1px dotted var(--border-muted-color); }
th { border-bottom: 1px solid var(--border-color); font-weight: 700; }
.table-scroll { overflow-x: auto; margin: 1rem 0 2rem; }
.table-scroll table { margin: 0; }

ul, ol { padding-left: 2rem; }
li { margin: 0.2rem 0; }

.toc-toggle {
  position: fixed; top: 1rem; left: 1rem; z-index: 30;
  border: 1px solid var(--border-color); background: var(--bg-color);
  color: var(--header-color);
  width: 3.6rem; height: 3.6rem; font-size: 1.6rem; cursor: pointer;
  display: none; padding: 0; line-height: 1;
  align-items: center; justify-content: center;
}
.toc-toggle:hover { background: var(--header-color); color: var(--bg-color); }

.toc {
  position: fixed; top: 0; left: 0; bottom: 0; width: var(--sidebar);
  border-right: 1px solid var(--border-color); padding: 2rem;
  overflow-y: auto; background: var(--bg-color); z-index: 20;
}
.toc-back { font-size: 1.2rem; margin-bottom: 1.6rem; }
.toc-back a { color: var(--muted-text); text-decoration: none; }
.toc-back a:visited { color: var(--muted-text); }
.toc-back a:hover { color: var(--link-color); }
.toc-heading {
  font-size: 1.4rem; color: var(--header-color);
  margin: 2rem 0 0.8rem; font-weight: 700;
}
.toc-heading:first-child { margin-top: 0; }
.toc ul { list-style: none; padding: 0; margin: 0; }
.toc li { margin: 0.3rem 0; }
.toc a { color: var(--text-color); text-decoration: none; display: block; }
.toc a:visited { color: var(--text-color); }
.toc a:hover { color: var(--link-color); }
.toc .var-row { display: flex; align-items: center; gap: 0.6rem; }
.toc .var-row input { margin: 0; flex-shrink: 0; }
.toc .var-row a { flex: 1; min-width: 0; overflow: hidden;
                  text-overflow: ellipsis; white-space: nowrap;
                  font-size: 1.3rem; }
.toc .var-actions {
  display: flex; gap: 0.6rem; margin-bottom: 0.8rem;
  font-size: 1.1rem; text-transform: uppercase; letter-spacing: 1px;
}
.toc .var-actions button {
  background: var(--bg-color); border: 1px solid var(--border-color);
  color: var(--header-color); padding: 0.2rem 0.8rem; cursor: pointer;
  font-weight: 700; letter-spacing: 1px;
}
.toc .var-actions button:hover { background: var(--header-color); color: var(--bg-color); }

main {
  margin-left: var(--sidebar); padding: 2rem 4rem 6rem;
  max-width: calc(78rem + var(--sidebar));
}
main h1 { margin-top: 0; }
main h2 { margin-top: 3.2rem; padding-bottom: 0.4rem;
          border-bottom: 1px solid var(--border-color); }
main h3 { margin-top: 2.4rem; }

section.variable {
  margin-top: 2.4rem; padding-top: 0.6rem;
  border-top: 1px solid var(--border-color);
}
section.variable.hidden { display: none; }
.plots { display: flex; flex-direction: column; gap: 1rem; margin: 1rem 0 2rem; }
.plots a { display: block; }
.plots img {
  display: block; max-width: 100%; height: auto;
  border: 1px solid var(--border-color);
  background: var(--bg-color);
}

@media (max-width: 880px) {
  .toc-toggle { display: flex; }
  .toc { transform: translateX(-100%); transition: transform 180ms ease;
         padding-top: 5.6rem;
         box-shadow: 0.4rem 0 1.2rem var(--shadow-color, rgba(0,0,0,0.4)); }
  body.toc-open .toc { transform: translateX(0); }
  body.toc-open::after { content: ""; position: fixed; inset: 0;
                         background: rgba(0,0,0,0.4); z-index: 15; }
  main { margin-left: 0; padding: 6rem 2rem 3rem; }
  table { font-size: 1.2rem; }
  th, td { padding: 0.4rem 0.8rem; }
}
`;

// JS ported verbatim from reformatters' render.py _JS.
const JS = String.raw`
(function () {
  var body = document.body;
  var toggle = document.querySelector('.toc-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      body.classList.toggle('toc-open');
    });
  }
  document.querySelectorAll('.toc a').forEach(function (a) {
    a.addEventListener('click', function () {
      body.classList.remove('toc-open');
      var href = a.getAttribute('href') || '';
      if (href.indexOf('#var-') === 0) {
        var v = href.slice(5);
        var cb = document.querySelector('input[data-var="' + cssEscape(v) + '"]');
        if (cb && !cb.checked) { cb.checked = true; applyVar(v, true); }
      }
    });
  });

  function cssEscape(s) {
    return s.replace(/(["\\])/g, '\\$1');
  }
  function applyVar(v, on) {
    document.querySelectorAll('section.variable[data-var="' + cssEscape(v) + '"]')
      .forEach(function (s) { s.classList.toggle('hidden', !on); });
  }
  document.querySelectorAll('input[data-var]').forEach(function (cb) {
    cb.addEventListener('change', function () { applyVar(cb.dataset.var, cb.checked); });
  });
  var allBtn = document.querySelector('[data-action="all"]');
  var noneBtn = document.querySelector('[data-action="none"]');
  if (allBtn) allBtn.addEventListener('click', function () { setAll(true); });
  if (noneBtn) noneBtn.addEventListener('click', function () { setAll(false); });
  function setAll(on) {
    document.querySelectorAll('input[data-var]').forEach(function (cb) {
      cb.checked = on; applyVar(cb.dataset.var, on);
    });
  }
})();
`;

function renderHtml({ datasetId, baseUrl, markdown }) {
  let html = md.render(markdown);
  html = pngLinksOpenInNewTab(html);
  const variables = extractPerVarNames(html);
  const annotated = annotateH2(html);
  html = annotated.html;
  html = annotateNonVarH3(html);
  html = wrapVariableSections(html);
  html = wrapTables(html);
  html = rewriteAssetUrls(html, baseUrl);

  const datasetName = extractDatasetName(markdown, datasetId);
  const toc = buildToc(annotated.sections, variables, datasetName, datasetId);
  const title = `Validation report — ${datasetId}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="icon" href="https://assets.dynamical.org/identity/logo/favicon/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<button type="button" class="toc-toggle" aria-label="Open table of contents">☰</button>
${toc}
<main>${html}</main>
<script>${JS}</script>
</body>
</html>
`;
}

class ValidationReportPage {
  data() {
    return {
      pagination: {
        data: "validationReports.entries",
        size: 1,
        alias: "entry",
      },
      permalink: ({ entry }) => `catalog/${entry.datasetId}/validation/`,
      eleventyComputed: {
        title: ({ entry }) => `Validation report — ${entry.datasetId}`,
      },
      layout: false,
    };
  }

  render({ entry }) {
    return renderHtml(entry);
  }
}

module.exports = ValidationReportPage;
module.exports.renderHtml = renderHtml;
