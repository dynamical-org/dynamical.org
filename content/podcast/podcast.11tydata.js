module.exports = {
  tags: [
    "podcast"
  ],
  "layout": "podcast-episode.njk",
  // Section-level keyword base; individual episodes can override with their own
  // `keywords` frontmatter.
  keywords:
    "weathering podcast, weather podcast, forecasting podcast, meteorology, weather and climate",
  permalink: function(data) {
    return `/podcast/${data.page.fileSlug}/`;
  }
};