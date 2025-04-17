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

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "./public/": "/" });

  eleventyConfig.addPlugin(pluginRss);
  eleventyConfig.addPlugin(EleventyHtmlBasePlugin);

  eleventyConfig.addPlugin(pluginSyntaxHighlight, {
    preAttributes: { tabindex: 0 },
  });
  eleventyConfig.addFilter("highlight", function (content, language) {
    return pairedShortcode(content, language);
  });

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

  eleventyConfig.addGlobalData("contributors", async () => {
    // Fetch repos from GitHub API with caching provided by eleventy-fetch
    const repos = await fetch(
      "https://api.github.com/orgs/dynamical-org/repos",
      {
        duration: "1d",
        type: "json",
      }
    );
    const contributorsSet = new Set();

    for (const repo of repos) {
      if (repo.name === "aws-open-data-registry") {
        continue;
      }
      // Fetch each repo's contributors with caching
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

      // Create a copy of the notebook to avoid modifying the cached version
      const cleanedNotebook = JSON.parse(JSON.stringify(json));

      // Remove base64 encoded data and script and style tags from notebook cell outputs
      if (cleanedNotebook.cells) {
        cleanedNotebook.cells.forEach(cell => {
          if (cell.outputs) {
            cell.outputs.forEach(output => {
              if (output.data) {
                const mimeTypes = ['image/png', 'image/jpeg', 'application/pdf', 'application/octet-stream'];
                mimeTypes.forEach(mimeType => {
                  if (output.data[mimeType]) {
                    output.data[mimeType] = '[BASE64_DATA_REMOVED]';
                  }
                });

                if (output.data['text/html']) {
                  if (Array.isArray(output.data['text/html'])) {
                    const joinedHtml = output.data['text/html'].join('\n');
                    const cleanedHtml = removeStyleAndScriptTags(joinedHtml);
                    output.data['text/html'] = cleanedHtml.split('\n');
                  } else if (typeof output.data['text/html'] === 'string') {
                    output.data['text/html'] = removeStyleAndScriptTags(output.data['text/html']);
                  }
                }
              }
            });
          }

          if (cell.attachments) {
            Object.keys(cell.attachments).forEach(key => {
              Object.keys(cell.attachments[key]).forEach(mimeType => {
                cell.attachments[key][mimeType] = '[BASE64_DATA_REMOVED]';
              });
            });
          }
        });
      }

      return `<pre>${JSON.stringify(cleanedNotebook, null, 2)}</pre>`;
    } catch (error) {
      console.error(`Error fetching notebook from ${url}:`, error);
      return `<p>Error loading notebook content: ${error.message}</p>`;
    }
  });

  function removeStyleAndScriptTags(htmlContent) {
    return htmlContent
      .replace(/<script[\s\S]*?<\/script>/gi, '[SCRIPT_REMOVED]')
      .replace(/<style[\s\S]*?<\/style>/gi, '[STYLE_REMOVED]');
  }

  return {
    dir: {
      input: "content",
      includes: "../_includes",
      data: "../_data",
      output: "docs",
    },
  };
};
