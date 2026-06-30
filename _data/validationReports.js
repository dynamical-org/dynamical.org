const fetch = require("@11ty/eleventy-fetch");

// On Cloudflare Pages, the `staging` branch builds against the staging STAC
// catalog; everything else uses production. Explicit STAC_BASE_URL always wins.
const STAC_BASE_URL =
  process.env.STAC_BASE_URL ||
  (process.env.CF_PAGES_BRANCH === "staging"
    ? "https://stac-staging.dynamical.org"
    : "https://stac.dynamical.org");
const VALIDATION_BASE_URL =
  process.env.VALIDATION_REPORTS_BASE_URL ||
  "https://dataset-validation-reports.dynamical.org";
const STAC_CACHE_DURATION = process.env.STAC_CACHE_DURATION || "1d";

module.exports = async function () {
  const rootCatalog = await fetch(`${STAC_BASE_URL}/catalog.json`, {
    type: "json",
    duration: STAC_CACHE_DURATION,
  });

  const childLinks = (rootCatalog.links || []).filter((l) => l.rel === "child");
  const datasetIds = childLinks
    .map((l) => {
      const m = l.href.match(/\/([^/]+)\/collection\.json(?:$|\?|#)?$/);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  const results = await Promise.all(
    datasetIds.map(async (datasetId) => {
      const baseUrl = `${VALIDATION_BASE_URL}/${datasetId}/latest/`;
      const mdUrl = `${baseUrl}validation_summary.md`;
      try {
        const markdown = await fetch(mdUrl, {
          type: "text",
          duration: STAC_CACHE_DURATION,
        });
        return { datasetId, baseUrl, markdown };
      } catch (err) {
        // 404s are expected — not every dataset has a published validation
        // report yet. Surface any other failure so build errors don't get
        // silently swallowed (network, DNS, 5xx, etc).
        if (/\b404\b/.test(String(err && err.message))) return null;
        console.warn(
          `[validationReports] ${datasetId}: failed to fetch summary — ${err.message}`,
        );
        return null;
      }
    }),
  );

  const entries = results.filter(Boolean);
  entries.sort((a, b) => a.datasetId.localeCompare(b.datasetId));
  return { entries };
};
