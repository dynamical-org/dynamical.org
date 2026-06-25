module.exports = {
  tags: ["updates"],
  // Every entry is one of two kinds:
  //   - "update" (default): short changelog post, file named YYYY-MM-DD.md,
  //     rendered inline on the /updates index and on its own date-based page.
  //   - "note": long-form lab note, file named by slug, rendered as a summary
  //     card on the index and on its own rich page (byline, abstract, TOC).
  eleventyComputed: {
    layout: (data) => (data.kind === "note" ? "note.njk" : "update.njk"),
    // Lab notes surface their abstract as the page/social-card description.
    // Updates keep the sitewide default (data.description stays undefined).
    description: (data) =>
      data.kind === "note" ? data.summary || data.description : data.description,
  },
};
