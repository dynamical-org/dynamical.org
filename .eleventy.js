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
