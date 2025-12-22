const { DateTime } = require("luxon");
const pluginRss = require("@11ty/eleventy-plugin-rss");
const pluginSyntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const { pairedShortcode } = require("@11ty/eleventy-plugin-syntaxhighlight");
const { EleventyHtmlBasePlugin } = require("@11ty/eleventy");
const fetch = require("@11ty/eleventy-fetch");
const fs = require("fs");
const path = require("path");

const pluginImages = require("./eleventy.config.images.js");

const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "github-contributors.json");
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

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

  eleventyConfig.addPlugin(pluginRss);
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

  eleventyConfig.addGlobalData("contributors", async () => {
    // Fetch all repos for the org
    const repos = await fetch(
      "https://api.github.com/orgs/dynamical-org/repos",
      {
        duration: "1d",
        type: "json",
      }
    );

    const contributorsSet = new Set();

    // Only include non-forked repos
    const primaryRepos = repos.filter((repo) => !repo.fork);

    for (const repo of primaryRepos) {
      const repoContributors = await fetch(repo.contributors_url, {
        duration: "1d",
        type: "json",
      });

      repoContributors.forEach((contributor) => {
        contributorsSet.add(contributor.login);
      });
    }

    const contributorsList = Array.from(contributorsSet).sort();
    return contributorsList;
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

  eleventyConfig.addFilter("find", function (array, property, value) {
    if (!Array.isArray(array)) {
      return undefined;
    }
    return array.find((item) => item[property] === value);
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
