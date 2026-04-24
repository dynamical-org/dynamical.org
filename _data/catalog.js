const fetch = require("@11ty/eleventy-fetch");

const STAC_BASE_URL = process.env.STAC_BASE_URL || "https://stac.dynamical.org";

module.exports = async function () {
  const rootCatalog = await fetch(`${STAC_BASE_URL}/catalog.json`, { type: "json" });
  const childLinks = (rootCatalog.links || []).filter((l) => l.rel === "child");

  const entries = await Promise.all(
    childLinks.map(async (link) => {
      const collection = await fetch(link.href, { type: "json" });
      return { status: "live", ...reshapeStacCollection(collection) };
    }),
  );

  const modelGroups = {};
  entries.forEach((entry) => {
    if (!entry.model_id) return;
    if (!modelGroups[entry.model_id]) {
      modelGroups[entry.model_id] = {
        id: entry.model_id,
        name: entry.model_name,
        description: entry.description_model,
        datasets: [],
      };
    }
    modelGroups[entry.model_id].datasets.push(entry);
  });

  return {
    entries,
    models: Object.values(modelGroups),
  };
};

function licenseMd(licenseLinks) {
  if (!licenseLinks || licenseLinks.length === 0) return "";
  const labels = licenseLinks.map(
    (l) => `[${l.title.replace("CC-BY-4.0", "CC BY 4.0").replace(/\s*\(additional terms\)$/i, "")}](${l.href})`,
  );
  if (labels.length === 1) return `Dataset licensed under ${labels[0]}.`;
  const last = labels.pop();
  return `Dataset licensed under ${labels.join(", ")} and ${last}.`;
}

// Reshape a STAC Collection into the object templates consume
// (dataset attributes + dimensions + variables + prose).
function reshapeStacCollection(collection) {
  const cubeDims = collection["cube:dimensions"] || {};
  const cubeVars = collection["cube:variables"] || {};

  const dimensions = Object.entries(cubeDims).map(([name, d]) => {
    const [min, max] = d.extent ?? [null, null];
    return {
      name,
      units: d.unit,
      statistics_approximate: { min, max },
    };
  });

  const variables = Object.entries(cubeVars).map(([name, v]) => ({
    name,
    long_name: v.long_name,
    short_name: v.short_name,
    comment: v.comment,
    units: v.unit,
    dimension_names: v.dimensions,
  }));

  const summaryValue = (key) => {
    const value = (collection.summaries || {})[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const exampleLinks = (collection.links || []).filter((l) => l.rel === "example");
  const githubUrl = exampleLinks.find((l) => l.type === "application/x-ipynb+json")?.href;
  const colabUrl = exampleLinks.find((l) => l.type === "text/html")?.href;

  const licenseLinks = (collection.links || []).filter((l) => l.rel === "license");

  return {
    license_md: licenseMd(licenseLinks),
    name: collection.title,
    dataset_id: collection.id,
    description: collection.description,
    attribution: collection.attribution,
    model_id: collection.model_id,
    model_name: collection.model_name,
    description_summary: collection.description_summary,
    description_details: collection.description_details,
    description_model: collection.description_model,
    examples: collection.examples,
    spatial_domain: summaryValue("spatial_domain"),
    spatial_resolution: summaryValue("spatial_resolution"),
    time_domain: summaryValue("time_domain"),
    time_resolution: summaryValue("time_resolution"),
    forecast_domain: summaryValue("forecast_domain"),
    forecast_resolution: summaryValue("forecast_resolution"),
    dimensions,
    variables,
    githubUrl,
    colabUrl,
  };
}
