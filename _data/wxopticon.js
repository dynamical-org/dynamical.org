const fetch = require("@11ty/eleventy-fetch");

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
    recent_init_count: p.recent_inits.length,
  }));

  return {
    products,
    window_days: summary.window_days,
  };
};
