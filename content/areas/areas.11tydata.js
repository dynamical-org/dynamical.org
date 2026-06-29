// Research areas — the thematic buckets dynamical organizes its work around.
// Each area is a Markdown file: the frontmatter feeds the cards on the homepage
// (the /#research section), and the body is rendered as the intro of the area page.
//
// Areas live OUTSIDE content/research/ on purpose: that dir's data file applies
// `tags: ["research"]`, and Eleventy's Data Deep Merge concatenates tag arrays
// down the cascade, which would pull areas into collections.research.
module.exports = {
  tags: ["researchAreas"],
  layout: "research-area.njk",
  // Files live in content/areas/<slug>.md but the page is served under /research.
  permalink: "/research/{{ page.fileSlug }}/",
  eleventyComputed: {
    // The blurb doubles as the page/social-card description.
    description: (data) => data.blurb || data.description,
  },
};
