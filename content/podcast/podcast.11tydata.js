module.exports = {
  tags: [
    "podcast"
  ],
  "layout": "podcast-episode.njk",
  permalink: function(data) {
    return `/podcast/${data.page.fileSlug}/`;
  }
};