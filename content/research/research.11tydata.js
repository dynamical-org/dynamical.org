module.exports = {
  tags: ["research"],
  layout: "research-post.njk",
  // Section-level keyword base; individual notes can override with their own
  // `keywords` frontmatter.
  keywords:
    "weather forecasting research, forecast evaluation, weather product design, weather data science, cloud-optimized weather data, dynamical.org",
  // Long-form pieces surface their abstract as the page/social-card description.
  eleventyComputed: {
    description: (data) => data.summary || data.description,
  },
};
