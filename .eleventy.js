const { DateTime } = require("luxon");
const {
  dateToRfc3339,
  getNewestCollectionItemDate,
} = require("@11ty/eleventy-plugin-rss");
const pluginSyntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const { pairedShortcode } = require("@11ty/eleventy-plugin-syntaxhighlight");
const { EleventyHtmlBasePlugin } = require("@11ty/eleventy");
const fetch = require("@11ty/eleventy-fetch");
const markdownIt = require("markdown-it");
const fs = require("fs");
const path = require("path");

const crypto = require("crypto");

const pluginImages = require("./eleventy.config.images.js");
const markdownToc = require("./lib/markdown-toc.js");
const markdownItFootnote = require("markdown-it-footnote");

// html: true lets inline HTML (e.g. <a>, <code>) in STAC-provided markdown
// pass through so we can migrate prose without breaking mid-markdown links.
const md = markdownIt({ html: true });

// Strip the common leading whitespace from every non-empty line. Without this,
// markdown prose authored inside a JS template literal keeps its indentation,
// and markdown-it treats any 4+ space-indented block as a code fence — which
// double-escapes inline HTML and wrecks our existing HTML-in-markdown prose.
function dedent(input) {
  const lines = input.split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  if (indents.length === 0) return input;
  const minIndent = Math.min(...indents);
  if (minIndent === 0) return input;
  return lines.map((line) => line.slice(minIndent)).join("\n");
}

// Turn a page URL into a filesystem-safe slug for its social card, e.g.
// "/" -> "index", "/sla/" -> "sla", "/updates/2026-06-01/" -> "updates-2026-06-01".
// Used by both the `ogSlug` filter (in base.njk) and the `ogCards` collection so
// the og:image URL and the generated PNG path always agree.
function ogSlug(url) {
  const trimmed = String(url || "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "index";
  return trimmed.replace(/\//g, "-").replace(/[^a-z0-9-]/gi, "-");
}

// Short context label shown in the top-right corner of generated social cards.
// Keep this tied to the public information architecture so pages get useful
// context without every content file needing another frontmatter field.
function ogLabel(url) {
  const pathname = new URL(url || "https://dynamical.org/").pathname;
  if (/^\/updates\//.test(pathname)) return "dispatch";
  if (/^\/research\//.test(pathname)) return "research";
  if (/^\/catalog\/[^/]+\/validation\//.test(pathname)) return "validation";
  if (/^\/catalog\//.test(pathname)) return "data catalog";
  if (/^\/scorecard\//.test(pathname)) return "forecast evaluation";
  if (/^\/meetings\//.test(pathname)) return "steering committee";
  if (pathname === "/about/") return "about";
  return "weather + climate";
}

// Reverse the HTML-attribute escaping Nunjucks applies to og:title /
// og:description so the rendered card shows literal characters (& " ' < >).
function decodeEntities(str) {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function mergeClasses(existingClasses, extraClasses) {
  const existing = String(existingClasses || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const extra = String(extraClasses || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...extra, ...existing])).join(" ");
}

function postprocessHighlightedHtml(html, extraPreClasses) {
  if (typeof html !== "string") return html;

  let out = html;

  if (extraPreClasses) {
    // Inject classes into the *first* <pre ...> tag produced by the syntaxhighlight plugin.
    out = out.replace(/<pre\b([^>]*)>/, (fullMatch, attrs) => {
      if (/\bclass\s*=/.test(attrs)) {
        const updatedAttrs = attrs.replace(/\bclass="([^"]*)"/, (m, cls) => {
          return `class="${mergeClasses(cls, extraPreClasses)}"`;
        });
        return `<pre${updatedAttrs}>`;
      }

      // attrs includes any leading whitespace (e.g. ` tabindex="0"`), so this stays valid.
      return `<pre class="${extraPreClasses}"${attrs}>`;
    });
  }

  // Eleventy syntaxhighlight outputs <br> tags for line breaks. That's fragile if any
  // client-side code ever reads/writes `.textContent` (which drops <br>), collapsing
  // the entire block into one line. Convert <br> to literal newlines to be robust.
  out = out.replace(/<br\s*\/?>/gi, "\n");

  return out;
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "./public/": "/" });

  // The includes/layouts dir (`../_includes`) lives outside the `content` input
  // dir, so `--serve` doesn't watch it by default — edits to base.njk and other
  // layouts wouldn't trigger a rebuild. Watch it explicitly.
  eleventyConfig.addWatchTarget("./_includes/");

  // Eleventy 3's eleventy-plugin-rss no longer ships a default plugin that
  // auto-registers these filters, and its bundled filters would register after
  // this config body runs — clobbering the custom `dateToRfc822` UTC override
  // below. Register only the filters the feeds use, directly.
  eleventyConfig.addFilter("dateToRfc3339", dateToRfc3339);
  eleventyConfig.addFilter(
    "getNewestCollectionItemDate",
    getNewestCollectionItemDate
  );
  eleventyConfig.addPlugin(EleventyHtmlBasePlugin);

  eleventyConfig.addPlugin(pluginSyntaxHighlight, {
    preAttributes: { tabindex: 0 },
  });
  // Filter form: {{ code | highlight("py", "extra classes...") }}
  eleventyConfig.addFilter("highlight", function (content, language, preClasses) {
    return postprocessHighlightedHtml(pairedShortcode(content, language), preClasses);
  });

  // Paired-shortcode form:
  // {% frameHighlight "py", "frameContent frameContentDesktop" %}...{% endframeHighlight %}
  eleventyConfig.addPairedShortcode(
    "frameHighlight",
    function (content, language, preClasses) {
      return postprocessHighlightedHtml(pairedShortcode(content, language), preClasses);
    }
  );

  eleventyConfig.addPlugin(pluginImages);

  eleventyConfig.addFilter("ogSlug", ogSlug);

  // The site feeds (Atom + JSON) carry both the newsletter (updates) and
  // long-form research posts, newest last (templates reverse for display).
  eleventyConfig.addCollection("feedItems", (api) => {
    return [
      ...api.getFilteredByTag("updates"),
      ...api.getFilteredByTag("research"),
    ].sort((a, b) => a.date - b.date);
  });

  // Research areas, ordered by the `order` frontmatter (cards on the homepage
  // and /research hub; each links to its own page under /research/<slug>/).
  eleventyConfig.addCollection("areas", (api) =>
    api
      .getFilteredByTag("researchAreas")
      .sort((a, b) => (a.data.order || 0) - (b.data.order || 0))
  );

  // Everything that can be "work": projects (metadata-only) plus long-form
  // research notes/papers. Area pages filter this by `areas`; the homepage and
  // hub filter it by `featured`.
  eleventyConfig.addCollection("researchWork", (api) => [
    ...api.getFilteredByTag("projects"),
    ...api.getFilteredByTag("research"),
  ]);

  // Curated highlights: any work item with a `featured` number, ascending.
  eleventyConfig.addCollection("featuredWork", (api) =>
    [
      ...api.getFilteredByTag("projects"),
      ...api.getFilteredByTag("research"),
    ]
      .filter((item) => item.data.featured != null)
      .sort((a, b) => a.data.featured - b.data.featured)
  );

  // Keep only the work items tagged to a given area slug.
  eleventyConfig.addFilter("inArea", (items, slug) =>
    (items || []).filter((item) => (item.data.areas || []).includes(slug))
  );

  // Split work items by `type` (e.g. projects vs. everything else). Nunjucks
  // lacks Jinja's selectattr/equalto, so we filter explicitly.
  eleventyConfig.addFilter("ofType", (items, type) =>
    (items || []).filter((item) => item.data.type === type)
  );
  eleventyConfig.addFilter("notType", (items, type) =>
    (items || []).filter((item) => item.data.type !== type)
  );

  // Map area slugs to their display titles (for the area tag on work cards).
  eleventyConfig.addFilter("areaTitles", (slugs, areas) => {
    const titleBySlug = Object.fromEntries(
      (areas || []).map((a) => [a.fileSlug, a.data.title])
    );
    return (slugs || []).map((slug) => titleBySlug[slug] || slug);
  });

  // Enable inline HTML and academic-style footnotes in markdown-rendered
  // content (lab notes lean on footnotes for citations). Additive over
  // 11ty's default markdown-it; the validation report uses its own
  // isolated markdown-it instance and is unaffected.
  eleventyConfig.amendLibrary("md", (mdLib) => {
    mdLib.set({ html: true });
    mdLib.use(markdownItFootnote);
  });

  // Run the shared scroll-spy TOC component (lib/markdown-toc.js) over
  // already-rendered markdown HTML. Returns { html, toc } so a layout can
  // drop the annotated body and the TOC nav in separate places. The
  // accompanying CSS/JS are exposed as global data (tocCSS / tocJS).
  eleventyConfig.addFilter("tocify", (html) => {
    const { html: annotated, headings } = markdownToc.annotateHeadings(html || "");
    return { html: annotated, toc: markdownToc.buildTocHtml(headings) };
  });
  eleventyConfig.addGlobalData("tocCSS", markdownToc.CSS);
  eleventyConfig.addGlobalData("tocJS", markdownToc.JS);

  // Low-tech figure with caption for long-form notes:
  //   {% figure "/assets/notes/foo.png", "alt text" %}Figure 1. Caption.{% endfigure %}
  // Plain <figure> HTML works too (markdown html:true), this is the
  // convenience form. Caption is the paired body (markdown-free, inline HTML ok).
  eleventyConfig.addPairedShortcode("figure", function (caption, src, alt) {
    const cap = String(caption || "").trim();
    return (
      `<figure>` +
      `<img src="${src}" alt="${alt || ""}">` +
      (cap ? `<figcaption>${cap}</figcaption>` : "") +
      `</figure>`
    );
  });

  // Generate a social card PNG for every page whose og:image points at the
  // generated-card path. We key off the rendered HTML (rather than a collection)
  // so the cards stay aligned with base.njk even for pages that opt out of
  // collections (e.g. the unlisted /sla page with eleventyExcludeFromCollections).
  // Podcast episodes and pages with a `socialImage` override get a different
  // og:image, so they're skipped here automatically.
  eleventyConfig.on("eleventy.after", async ({ dir, results }) => {
    const { renderCard } = require("./lib/og-card.js");
    const metadata = require("./_data/metadata.js");

    const metaTag = (html, prop) => {
      const m = html.match(
        new RegExp(`<meta property="${prop}" content="([^"]*)"`)
      );
      return m ? decodeEntities(m[1]) : "";
    };
    // og:title is "dynamical.org" sitewide unless a page sets socialTitle, so
    // the card headline comes from the page's own <title> ("dynamical.org - X"),
    // with an explicit socialTitle (surfaced via og:title) winning when present.
    const cardTitle = (html) => {
      const ogTitle = metaTag(html, "og:title");
      if (ogTitle && ogTitle !== metadata.title) return ogTitle;
      const m = html.match(/<title>([^<]*)<\/title>/);
      let pageTitle = m ? decodeEntities(m[1]).trim() : "";
      pageTitle = pageTitle.replace(/^dynamical\.org\s*-?\s*/, "").trim();
      if (pageTitle.toLowerCase() === "home") pageTitle = "";
      return pageTitle || metadata.title;
    };

    const outputDir = (dir && dir.output) || "docs";
    const seen = new Set();
    for (const result of results) {
      if (!result.outputPath || !result.outputPath.endsWith(".html")) continue;
      const image = metaTag(result.content, "og:image");
      const slugMatch = image.match(/\/assets\/og\/([^"/]+)\.png$/);
      if (!slugMatch) continue;
      const slug = slugMatch[1];
      if (seen.has(slug)) continue;
      seen.add(slug);

      // The shared default card is brand-only and must be deterministic, so it
      // ignores whichever titleless page happens to be processed first.
      const isDefault = slug === "default";
      const title = isDefault ? metadata.title : cardTitle(result.content);
      let subtitle = isDefault
        ? metadata.description
        : metaTag(result.content, "og:description");
      // When the description leads with the headline (e.g. socialTitle is the
      // first clause of the description), drop the duplicate so the card reads
      // headline + the remaining detail instead of repeating itself.
      if (subtitle.toLowerCase().startsWith(title.toLowerCase())) {
        subtitle = subtitle.slice(title.length).replace(/^[\s–—:.,-]+/, "");
      }
      const url = metaTag(result.content, "og:url");
      const png = await renderCard({ title, subtitle, label: ogLabel(url) });
      const outPath = path.join(outputDir, "assets", "og", `${slug}.png`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, png);
    }
  });

  eleventyConfig.addFilter("fileHash", function (filePath) {
    const content = fs.readFileSync(path.join(__dirname, filePath));
    return crypto.createHash("md5").update(content).digest("hex").slice(0, 8);
  });

  eleventyConfig.addShortcode("currentBuildDate", () => {
    return new Date().toISOString();
  });

  eleventyConfig.addFilter("readableDate", (dateObj, format, zone) => {
    // Formatting tokens for Luxon: https://moment.github.io/luxon/#/formatting?id=table-of-tokens
    return DateTime.fromJSDate(dateObj, { zone: zone || "utc" }).toFormat(
      format || "yyyy-MM-dd"
    );
  });

  // Override the RSS plugin's dateToRfc822 filter to properly handle UTC conversion
  eleventyConfig.addFilter("dateToRfc822", (dateObj) => {
    // Convert to UTC using Luxon to ensure proper timezone handling
    const utcDate = DateTime.fromJSDate(dateObj, { zone: "utc" });
    return utcDate.toFormat("ccc, dd LLL yyyy HH:mm:ss '+0000'");
  });

  // Add ISO date filter for consistent UTC output
  eleventyConfig.addFilter("isoDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj, { zone: "utc" }).toISO();
  });

  // Derive a short plain-text summary from rendered HTML for archive listings
  // (e.g. the /updates index). Strips tags/entities, collapses whitespace, and
  // truncates on a word boundary. A page's own `description` frontmatter should
  // win over this when present.
  eleventyConfig.addFilter("excerpt", (content, maxLength) => {
    const limit = maxLength || 220;
    // Decode the handful of entities we care about in a single pass. Sequential
    // per-entity replaces can double-unescape (e.g. "&amp;lt;" -> "&lt;" -> "<"),
    // so match them all at once and never re-scan the replacement text.
    const entities = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&#x27;": "'",
      "&nbsp;": " ",
    };
    const text = String(content || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => entities[m])
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= limit) return text;
    const truncated = text.slice(0, limit);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "…";
  });

  eleventyConfig.addAsyncFilter("embedNotebookContent", async function (url) {
    try {
      // Use eleventy-fetch with caching
      const json = await fetch(url, {
        duration: "1d",
        type: "json",
      });

      // Remove outputs from notebook cells, they spew a lot of data that's not LLM friendly.
      const cleanedNotebook = JSON.parse(JSON.stringify(json));
      if (cleanedNotebook.cells) {
        cleanedNotebook.cells.forEach((cell) => {
          cell.outputs = [];
        });
      }

      return `<pre>${JSON.stringify(cleanedNotebook, null, 2)}</pre>`;
    } catch (error) {
      console.error(`Error fetching notebook from ${url}:`, error);
      return `<p>Error loading notebook content: ${error.message}</p>`;
    }
  });

  eleventyConfig.addFilter("roundIfNumber", function (value, decimals) {
    if (typeof value === "number") {
      const factor = Math.pow(10, decimals ?? 0);
      return Math.round(value * factor) / factor;
    }
    return value;
  });

  eleventyConfig.addFilter("find", function (array, property, value) {
    if (!Array.isArray(array)) {
      return undefined;
    }
    return array.find((item) => item[property] === value);
  });

  eleventyConfig.addFilter("rejectWhere", function (array, property, value) {
    if (!Array.isArray(array)) {
      return [];
    }
    return array.filter((item) => item[property] !== value);
  });

  // Render markdown, and give any table the site's data-table treatment
  // (bordered `.data` style + horizontal-scroll container). Markdown tables
  // are always real tabular data, unlike the hand-authored layout tables in
  // templates, so this styles them without a per-call wrapper. Mirrors the
  // wrap in content/catalog/validation.11ty.js.
  eleventyConfig.addFilter("markdown", (input) =>
    input
      ? md
          .render(dedent(input))
          .replace(
            /<table>([\s\S]*?)<\/table>/g,
            '<div class="table-container"><table class="data">$1</table></div>'
          )
      : ""
  );

  // Strip the approximate-km parenthetical from a spatial resolution, e.g.
  // "0.25 degrees (~20km)" -> "0.25 degrees". Handles multiple occurrences
  // (some resolutions list two, e.g. GEFS). Used on the catalog list.
  eleventyConfig.addFilter("stripApprox", (s) =>
    (s || "").replace(/\s*\(~[^)]*\)/g, "")
  );

  // Drop the time-of-day from a datetime range, e.g.
  // "2021-05-01 00:00:00 UTC to Present" -> "2021-05-01 UTC to Present".
  // Used for the analysis record on the catalog list.
  eleventyConfig.addFilter("dateOnly", (s) =>
    (s || "").replace(/ \d{2}:\d{2}:\d{2}/g, "")
  );

  // Abbreviate hour units on the catalog list, e.g. "every 6 hours" ->
  // "every 6h", "1 hour" -> "1h", "0-384 hours (0-16 days)" -> "0-384h ...".
  eleventyConfig.addFilter("abbrevHours", (s) =>
    (s || "").replace(/ hours?\b/g, "h")
  );

  // Render an analysis time step of the form "N hour(s)" as "N hourly step"
  // (normalizing "3.0" -> "3"). Anything that doesn't match is left as-is.
  eleventyConfig.addFilter("hourlyStep", (s) => {
    const match = /^(\d+(?:\.\d+)?)\s+hours?$/.exec((s || "").trim());
    return match ? `${parseFloat(match[1])} hourly step` : s;
  });

  return {
    dir: {
      input: "content",
      includes: "../_includes",
      data: "../_data",
      output: "docs",
    },
  };
};
