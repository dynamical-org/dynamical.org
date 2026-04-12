const fetch = require("@11ty/eleventy-fetch");

module.exports = async function () {
  const data = await fetch(
    "https://assets.dynamical.org/site/usage-data.json",
    { duration: "1d", type: "json" }
  );

  const totals = data.monthly_totals;
  const totalRequests = totals.reduce((sum, m) => sum + m.requests, 0);

  return {
    totalRequests,
    requestsDisplay: formatRequests(totalRequests),
  };
};

function formatRequests(n) {
  if (n >= 1_000_000_000) return `${Math.floor(n / 1_000_000_000)}B+`;
  if (n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}K+`;
  return `${n}`;
}
