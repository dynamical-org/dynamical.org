const fetch = require("@11ty/eleventy-fetch");
const fs = require("fs");
const path = require("path");

// On Cloudflare Pages, preview deployments (every branch except the production
// `main` branch — i.e. PR previews) build against the staging STAC catalog so
// catalog changes can be previewed before going live; production builds use
// prod. An explicit STAC_BASE_URL always wins, e.g. `npm run start:staging` or
// pointing at a locally-served stac/ tree.
const STAC_BASE_URL =
  process.env.STAC_BASE_URL ||
  (process.env.CF_PAGES_BRANCH && process.env.CF_PAGES_BRANCH !== "main"
    ? "https://stac-staging.dynamical.org"
    : "https://stac.dynamical.org");

// `npm run build` sets this to "0s" so production builds always pick up the
// latest STAC — we don't want to publish a site that references stale catalog
// data. `npm start` (dev server) leaves it unset and keeps a 1-hour cache so
// iterating on templates stays fast without going too far out of date.
const STAC_CACHE_DURATION = process.env.STAC_CACHE_DURATION || "1h";
const STAC_FETCH_OPTIONS = { type: "json", duration: STAC_CACHE_DURATION };

module.exports = async function () {
  const rootCatalog = await fetch(`${STAC_BASE_URL}/catalog.json`, STAC_FETCH_OPTIONS);
  const childLinks = (rootCatalog.links || []).filter((l) => l.rel === "child");

  const entries = await Promise.all(
    childLinks.map(async (link) => {
      // Child links are absolute (stac.dynamical.org). When STAC_BASE_URL is
      // set explicitly, rewrite them to it so local builds can point at a
      // locally-served stac/ tree. Otherwise pass the href through untouched.
      const href = process.env.STAC_BASE_URL
        ? link.href.replace("https://stac.dynamical.org", process.env.STAC_BASE_URL)
        : link.href;
      const collection = await fetch(href, STAC_FETCH_OPTIONS);
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

// Reduce markdown prose to a plain-text excerpt suitable for a meta
// description / social card (strips links, inline code, emphasis markers;
// collapses whitespace; truncates on a word boundary).
function plainTextExcerpt(md, maxLen = 200) {
  if (!md) return "";
  let text = md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > maxLen) {
    text = text.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
  }
  return text;
}

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

  const rawVariables = Object.entries(cubeVars).map(([name, v]) => ({
    name,
    long_name: v.long_name,
    short_name: v.short_name,
    comment: v.comment,
    units: v.unit,
    dimension_names: v.dimensions,
  }));

  // Variables at the root zarr group (e.g. `temperature_2m`) are listed
  // directly, unchanged from before. Variables under a nested zarr group
  // (e.g. `model_level/geopotential_height`) are split off into named
  // groups so the catalog page can render them behind disclosures instead
  // of flooding a single flat table.
  const { variables, variableGroups } = groupVariables(rawVariables);

  const summaryValue = (key) => {
    const value = (collection.summaries || {})[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const notebooks = parseNotebooks(collection.links);

  const licenseLinks = (collection.links || []).filter((l) => l.rel === "license");

  // Optional validation-report asset published by reformatters. Surface its
  // href so the catalog page can offer a fallback raw-HTML link for datasets
  // where the on-site rendering can't fetch the markdown source.
  const validationAsset = (collection.assets || {})["validation_report"];
  const validation_report_href = validationAsset ? validationAsset.href : null;

  // Per-dataset social-card thumbnail, keyed by dataset id under
  // public/assets/catalog-thumbnails/. Null when no thumbnail is published so
  // the page falls back to the default site image.
  const thumbnailPath = path.join(__dirname, "..", "public", "assets", "catalog-thumbnails", `${collection.id}.jpg`);
  const thumbnail = fs.existsSync(thumbnailPath)
    ? `https://dynamical.org/assets/catalog-thumbnails/${collection.id}.jpg`
    : null;

  return {
    thumbnail,
    description_meta: plainTextExcerpt(collection.description_summary),
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
    variableGroups,
    notebooks,
    validation_report_href,
  };
}

// Split cube:variables into root (single-level) variables and named groups
// based on a `group/name` prefix in the variable's key, e.g.
// `model_level/geopotential_height` belongs to the `model_level` group as
// `geopotential_height`. Variables with no `/` stay in the flat root list.
function groupVariables(rawVariables) {
  const variables = [];
  const groupsByName = {};
  const groupOrder = [];

  rawVariables.forEach((variable) => {
    const slashIndex = variable.name.lastIndexOf("/");
    if (slashIndex === -1) {
      variables.push(variable);
      return;
    }
    const groupName = variable.name.slice(0, slashIndex);
    const name = variable.name.slice(slashIndex + 1);
    if (!groupsByName[groupName]) {
      groupsByName[groupName] = { name: groupName, variables: [] };
      groupOrder.push(groupName);
    }
    groupsByName[groupName].variables.push({ ...variable, name });
  });

  return { variables, variableGroups: groupOrder.map((name) => groupsByName[name]) };
}

// Pair `rel:example` links into notebooks by the `{slug}.ipynb` filename
// they share. Each notebook ends up with a github (ipynb json) URL and a
// colab (html) URL. Backward-compatible with STAC output that emits a single
// pair per dataset.
function parseNotebooks(links) {
  const examples = (links || []).filter((l) => l.rel === "example");
  const order = [];
  const bySlug = {};
  for (const link of examples) {
    const match = link.href.match(/([^/]+)\.ipynb(?:$|\?|#)/);
    if (!match) continue;
    const slug = match[1];
    if (!bySlug[slug]) {
      order.push(slug);
      const title = (link.title || "")
        .replace(/\s*\((?:GitHub|Colab)\)\s*$/i, "")
        .trim();
      bySlug[slug] = { slug, title: title || slug };
    }
    if (link.type === "application/x-ipynb+json") {
      bySlug[slug].githubUrl = link.href;
    } else if (link.type === "text/html") {
      bySlug[slug].colabUrl = link.href;
    }
  }
  return order
    .map((slug) => bySlug[slug])
    .filter((nb) => nb.githubUrl && nb.colabUrl);
}
