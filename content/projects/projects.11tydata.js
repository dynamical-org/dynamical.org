// Projects — metadata records for the work dynamical ships. Every project has
// its own page already (e.g. /catalog, /scorecard, status.dynamical.org), so
// these files generate NO page of their own: they're frontmatter-only records
// that the homepage and area pages read via collections.projects.
//
// `permalink: false` keeps each file out of the output dir while leaving it in
// the data cascade and collections. Set `url` in each file to the real page.
module.exports = {
  tags: ["projects"],
  permalink: false,
};
