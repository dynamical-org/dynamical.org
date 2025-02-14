const {DateTime} = require('luxon');
const pluginRss = require('@11ty/eleventy-plugin-rss');
const pluginSyntaxHighlight = require('@11ty/eleventy-plugin-syntaxhighlight');
const {pairedShortcode} = require('@11ty/eleventy-plugin-syntaxhighlight');
const {EleventyHtmlBasePlugin} = require('@11ty/eleventy');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const pluginImages = require('./eleventy.config.images.js');

const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'github-contributors.json');
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({'./public/': '/'});

  eleventyConfig.addPlugin(pluginRss);
  eleventyConfig.addPlugin(EleventyHtmlBasePlugin);

  eleventyConfig.addPlugin(pluginSyntaxHighlight, {
    preAttributes: {tabindex: 0},
  });
  eleventyConfig.addFilter('highlight', function (content, language) {
    return pairedShortcode(content, language);
  });

  eleventyConfig.addPlugin(pluginImages);

  eleventyConfig.addShortcode('currentBuildDate', () => {
    return new Date().toISOString();
  });

  eleventyConfig.addFilter('readableDate', (dateObj, format, zone) => {
    // Formatting tokens for Luxon: https://moment.github.io/luxon/#/formatting?id=table-of-tokens
    return DateTime.fromJSDate(dateObj, {zone: zone || 'utc'}).toFormat(format || 'yyyy-MM-dd');
  });

  eleventyConfig.addGlobalData("contributors", async () => {
    // Check if cache exists and is still valid
    if (fs.existsSync(CACHE_FILE)) {
      const stat = fs.statSync(CACHE_FILE);
      const now = Date.now();
      if (now - stat.mtimeMs < CACHE_DURATION) {
        try {
          const cached = fs.readFileSync(CACHE_FILE, 'utf8');
          return JSON.parse(cached);
        } catch (err) {
          // fall through on error
        }
      }
    }
    
    // Fetch from GitHub API since no valid cache exists
    const response = await fetch('https://api.github.com/orgs/dynamical-org/repos');
    const repos = await response.json();
    const contributorsSet = new Set();

    for (const repo of repos) {
      const contributorsResponse = await fetch(repo.contributors_url);
      const contributors = await contributorsResponse.json();
      contributors.forEach(contributor => contributorsSet.add(contributor.login));
    }
    const contributorsList = Array.from(contributorsSet).sort();
    
    // Ensure cache directory exists and write cache
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR);
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(contributorsList));
    
    return contributorsList;
  });

  return {
    dir: {
      input: 'content',
      includes: '../_includes',
      data: '../_data',
      output: 'docs',
    },
  };
};
