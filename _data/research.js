// Scaffolding for the research section (the homepage "Research areas" +
// "Featured work" lists and the /research hub).
//
// This is intentionally a hand-curated data file rather than auto-derived
// from content: areas and featured work are an editorial statement about how
// dynamical wants to be understood, so they're curated and ordered by hand.
//
// Most copy below is a PLACEHOLDER (marked TODO) — brainstorm and replace.
// The Scorecard, Catalog, and the sample lab note are wired to real pages so
// the pattern is visible end to end.

module.exports = {
  // Thematic areas dynamical organizes its work around. Mirrors Ink & Switch's
  // "Research Areas". Each operationalizes into one or more pieces of featured
  // work (e.g. "Weather forecast evaluation" → the Scorecard).
  areas: [
    {
      title: "Weather forecast evaluation",
      slug: "forecast-evaluation",
      blurb:
        "TODO — How well do models actually predict the weather? Operationalized by the Scorecard.",
    },
    {
      title: "Data product validation",
      slug: "data-validation",
      blurb:
        "TODO — Automated, transparent checks that every dataset is correct before you build on it.",
    },
    {
      title: "Production latency & observability",
      slug: "latency-observability",
      blurb:
        "TODO — Keeping live, cloud-optimized archives fast, fresh, and observable.",
    },
    {
      title: "Cloud-optimized archives",
      slug: "cloud-optimized-archives",
      blurb:
        "TODO — Live-updating Zarr / Icechunk weather data — the Catalog.",
    },
  ],

  // Curated, ordered highlights surfaced on the homepage and /research.
  //   type:  Project | Lab note | Report | Paper
  //   code:  true  → render the live-code frame (the Catalog's special item)
  // Projects link to their own pages (/catalog, /scorecard); writing links
  // into /research/<slug>.
  featured: [
    {
      type: "Project",
      title: "The Catalog",
      area: "Cloud-optimized archives",
      url: "/catalog",
      code: true,
      blurb:
        "A public, live-updating catalog of cloud-optimized weather datasets. One line of code to open.",
    },
    {
      type: "Project",
      title: "Scorecard",
      area: "Weather forecast evaluation",
      url: "/scorecard",
      blurb:
        "TODO — Operational skill scores for forecast models, scored against observations.",
    },
    {
      type: "Lab note",
      title: "How we validate the catalog",
      area: "Data product validation",
      url: "/research/validating-the-catalog/",
      year: 2026,
      blurb:
        "What our automated validation reports check, why we chose those checks, and how they run.",
    },
  ],
};
