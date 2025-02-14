const {DateTime} = require('luxon');
const pluginRss = require('@11ty/eleventy-plugin-rss');
const pluginSyntaxHighlight = require('@11ty/eleventy-plugin-syntaxhighlight');
const {pairedShortcode} = require('@11ty/eleventy-plugin-syntaxhighlight');
const {EleventyHtmlBasePlugin} = require('@11ty/eleventy');
const fetch = require('node-fetch');

const pluginImages = require('./eleventy.config.images.js');

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
    const response = await fetch('https://api.github.com/orgs/dynamical-org/repos');
    const repos = await response.json();
    const contributorsSet = new Set();

    for (const repo of repos) {
      const contributorsResponse = await fetch(repo.contributors_url);
      const contributors = await contributorsResponse.json();
      contributors.forEach(contributor => contributorsSet.add(contributor.login));
    }

    return Array.from(contributorsSet).sort();
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
