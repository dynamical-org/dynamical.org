const fetch = require("@11ty/eleventy-fetch");

// Keep in sync with RECENT_INIT_COUNT in public/wxopticon.js
const RECENT_INIT_COUNT = 10;

module.exports = async function () {
  const summary = await fetch(
    "https://assets.dynamical.org/wxopticon/summary.json",
    { duration: "1d", type: "json" }
  );

  const products = summary.products.map((p) => ({
    id: p.id,
    label: p.label,
    source: p.source,
    cadence_hours: p.cadence_hours,
    recent_init_count: Math.min(p.recent_inits.length, RECENT_INIT_COUNT),
    // Pass lead-group shape through so the build-time skeleton can allocate
    // one sub-bar per group before hydration (and a sibling label column).
    // Absent for pre-lead-groups summaries — wxopticon.js falls back to a
    // single fill in that case.
    lead_groups: (() => {
      const groups = p.lead_group_stats ?? [];
      if (groups.length === 0) return [];
      const total = groups[groups.length - 1].leads_in_group;
      let prev = 0;
      return groups.map((g) => {
        const slice = g.leads_in_group - prev;
        const center_pct = total > 0 ? ((prev + slice / 2) / total) * 100 : 0;
        prev = g.leads_in_group;
        return {
          name: g.name,
          label: g.label,
          leads_in_group: g.leads_in_group,
          center_pct,
        };
      });
    })(),
  }));

  return {
    products,
    window_days: summary.window_days,
  };
};
