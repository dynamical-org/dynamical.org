module.exports = {
  tags: ["research"],
  layout: "research-post.njk",
  // Long-form pieces surface their abstract as the page/social-card description.
  eleventyComputed: {
    description: (data) => data.summary || data.description,
  },
};
