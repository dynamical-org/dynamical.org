const {DateTime} = require('luxon');
const pluginRss = require('@11ty/eleventy-plugin-rss');
const pluginSyntaxHighlight = require('@11ty/eleventy-plugin-syntaxhighlight');
const {pairedShortcode} = require('@11ty/eleventy-plugin-syntaxhighlight');
const {EleventyHtmlBasePlugin} = require('@11ty/eleventy');

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

  return {
    dir: {
      input: 'content',
      includes: '../_includes',
      data: '../_data',
      output: 'docs',
    },
  };
};
