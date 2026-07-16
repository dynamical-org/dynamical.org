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

// Canonical public site + STAC hosts for machine-readable metadata (llms.txt,
// schema.org JSON-LD). Always production, regardless of STAC_BASE_URL — the
// links we advertise to crawlers must point at the live public endpoints, not
// a staging preview.
const SITE_URL = "https://dynamical.org/";
const STAC_PUBLIC_URL = "https://stac.dynamical.org";
// Single Zenodo DOI covering the dynamical.org catalog (also rendered as a
// badge on each catalog page in content/catalog-pages.njk).
const DATASET_DOI = "10.5281/zenodo.18777399";

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

  // Structured-data contract: llms.txt and schema.org/Dataset JSON-LD are
  // generated from these same entries, so they can't reference a dataset that
  // isn't in STAC. The real drift risk is upstream STAC dropping/renaming a
  // field our machine-readable output depends on — which would silently emit
  // broken schema.org. Fail the build instead. `npm run build` runs on
  // Cloudflare Pages, so a throw here aborts the deploy.
  validateEntries(entries);

  // Attach the schema.org/Dataset object per entry so templates can emit it
  // with `{{ entry.jsonld | dump | safe }}` — one source of truth with the
  // catalog pages.
  entries.forEach((entry) => {
    entry.jsonld = buildDatasetJsonLd(entry);
  });

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

  // Split live (non-deprecated) datasets into the two families the catalog
  // page lists separately: forecasts (have a forecast lead-time domain) and
  // analyses (best-estimate archives, no forecast domain). Preserves
  // catalog.json child order within each list.
  const liveEntries = entries.filter((e) => e.status !== "deprecated");
  const forecasts = liveEntries.filter((e) => e.forecast_domain);
  const analyses = liveEntries.filter((e) => !e.forecast_domain);

  return {
    entries,
    models: Object.values(modelGroups),
    forecasts,
    analyses,
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

// Human-readable label for a STAC license link — raw titles are inconsistent
// (e.g. "CC-BY-4.0", "CC BY 4.0 (additional terms)").
function licenseLabel(link) {
  return link.title.replace("CC-BY-4.0", "CC BY 4.0").replace(/\s*\(additional terms\)$/i, "");
}

function licenseMd(licenseLinks) {
  if (!licenseLinks || licenseLinks.length === 0) return "";
  const labels = licenseLinks.map((l) => `[${licenseLabel(l)}](${l.href})`);
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

  // Surface every published STAC asset generically as a distribution. Today
  // this is the single `icechunk` (s3://) asset; when reformatters adds an
  // HTTPS mirror asset it flows through here with no code change. The JSON-LD
  // builder filters to the data-role assets.
  const distributions = Object.entries(collection.assets || {}).map(([key, a]) => ({
    key,
    href: a.href,
    type: a.type,
    title: a.title,
    roles: a.roles || [],
  }));

  const licenseLink = licenseLinks[0] || null;

  // Per-dataset social-card thumbnail, keyed by dataset id under
  // public/assets/catalog-thumbnails/. Null when no thumbnail is published so
  // the page falls back to the default site image.
  const thumbnailPath = path.join(__dirname, "..", "public", "assets", "catalog-thumbnails", `${collection.id}.jpg`);
  const thumbnail = fs.existsSync(thumbnailPath)
    ? `https://dynamical.org/assets/catalog-thumbnails/${collection.id}.jpg`
    : null;

  // A `-virtual` (or legacy `-spatial`/`-spatial-dev`) id marks a virtual,
  // space-optimized product chunked for whole-grid, low-latency reads; anything
  // else is a materialized, time-optimized archive rechunked for point time
  // series. Virtual products carry the model's complete variable set;
  // materialized ones carry a curated subset.
  const isVirtual = collection.id.includes("-virtual") || /-spatial(-dev)?$/.test(collection.id);

  return {
    // Use the STAC Collection directly for everything it already exposes at
    // the top level: id, title, description, attribution, model_id,
    // model_name, description_summary/details/model, examples, license,
    // version, keywords, summaries, extent, links, assets, cube:*. Templates
    // read these STAC-native fields (entry.id, entry.title, ...) as-is.
    ...collection,
    // Below: only fields that require transforming STAC structures, or
    // derived values the site needs.
    dimensions,
    variables,
    variableGroups,
    notebooks,
    distributions,
    thumbnail,
    validation_report_href,
    license_md: licenseMd(licenseLinks),
    license_links: licenseLinks.map((l) => ({ title: licenseLabel(l), href: l.href })),
    license_url: licenseLink ? licenseLink.href : null,
    description_meta: plainTextExcerpt(collection.description_summary),
    // STAC summaries are single-element arrays; unwrap to scalars.
    spatial_domain: summaryValue("spatial_domain"),
    spatial_resolution: summaryValue("spatial_resolution"),
    time_domain: summaryValue("time_domain"),
    time_resolution: summaryValue("time_resolution"),
    forecast_domain: summaryValue("forecast_domain"),
    forecast_resolution: summaryValue("forecast_resolution"),
    // Extracted from STAC extent for structured data (JSON-LD).
    spatial_bbox: collection.extent?.spatial?.bbox?.[0] || null,
    temporal_interval: collection.extent?.temporal?.interval?.[0] || null,
    // Canonical public URLs.
    stac_href: `${STAC_PUBLIC_URL}/${collection.id}/collection.json`,
    catalog_url: `${SITE_URL}catalog/${collection.id}/`,
    // Access-pattern optimization (see isVirtual above): virtual products are
    // space-optimized (whole-grid reads); everything else is time-optimized.
    optimization: isVirtual ? "space" : "time",
    // Build-model archetype (icon + label), shown on the row's title line. The
    // benefit tags below (access_tags) follow from it.
    access_type: isVirtual
      ? { icon: "layers", label: "virtual" }
      : { icon: "brick-wall", label: "materialized" },
    // Benefit tags describing what the implementation is good for, keyed off
    // isVirtual. Each has a Lucide `icon` key (rendered by tag-icon.njk) and a
    // plaintext `label`; templates render them as an icon + label list.
    access_tags: isVirtual
      ? [
          { icon: "rabbit", label: "low latency" },
          { icon: "map", label: "map-optimized" },
        ]
      : [
          { icon: "clock", label: "time-optimized" },
          { icon: "chart-line", label: "designed for analysis and training" },
        ],
    // Total variables across the root group and any nested groups — surfaced on
    // the catalog list as "N variables" (or "all variables" for space-optimized).
    variable_count:
      variables.length + variableGroups.reduce((n, g) => n + g.variables.length, 0),
  };
}

// schema.org/Dataset for one catalog entry. Derived entirely from STAC fields
// surfaced above so it stays in lockstep with the rendered catalog page.
function buildDatasetJsonLd(entry) {
  const org = { "@type": "Organization", name: "dynamical.org", url: SITE_URL };

  // Advertise the data-role assets (the s3:// Icechunk repo today, an HTTPS
  // mirror in future), plus the STAC Collection JSON as a metadata endpoint.
  const distribution = entry.distributions
    .filter((a) => a.roles.includes("data"))
    .map((a) => ({
      "@type": "DataDownload",
      ...(a.title ? { name: a.title } : {}),
      ...(a.type ? { encodingFormat: a.type } : {}),
      contentUrl: a.href,
    }));
  distribution.push({
    "@type": "DataDownload",
    name: "STAC Collection metadata",
    encodingFormat: "application/json",
    contentUrl: entry.stac_href,
  });

  // Root variables plus any nested-group variables (qualified with their
  // group prefix), so schema.org lists the dataset's full variable set even
  // when the catalog page renders some behind group disclosures.
  const allVariables = [
    ...entry.variables,
    ...(entry.variableGroups || []).flatMap((g) =>
      g.variables.map((v) => ({ ...v, name: `${g.name}/${v.name}` })),
    ),
  ];

  const schema = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": entry.catalog_url,
    name: entry.title,
    description: entry.description_meta || plainTextExcerpt(entry.description),
    url: entry.catalog_url,
    sameAs: entry.stac_href,
    isAccessibleForFree: true,
    creator: org,
    publisher: org,
    identifier: `https://doi.org/${DATASET_DOI}`,
    distribution,
    variableMeasured: allVariables.map((v) => ({
      "@type": "PropertyValue",
      name: v.name,
      ...(v.long_name ? { description: v.long_name } : {}),
      ...(v.units ? { unitText: v.units } : {}),
    })),
  };
  if (entry.version) schema.version = entry.version;
  if (entry.license_url) schema.license = entry.license_url;
  if (entry.keywords) schema.keywords = entry.keywords;
  if (entry.spatial_bbox) {
    // STAC bbox is [west, south, east, north]; schema.org GeoShape.box is
    // "south west north east" (min lat, min lon, max lat, max lon).
    const [west, south, east, north] = entry.spatial_bbox;
    schema.spatialCoverage = {
      "@type": "Place",
      geo: { "@type": "GeoShape", box: `${south} ${west} ${north} ${east}` },
    };
  }
  if (entry.temporal_interval && entry.temporal_interval[0]) {
    // ISO 8601 interval; open-ended ("..") when STAC leaves the end null.
    const [start, end] = entry.temporal_interval;
    schema.temporalCoverage = `${start}/${end || ".."}`;
  }
  return schema;
}

// Fail the build if any live entry is missing a field the machine-readable
// output depends on. Aggregates all problems into one error so a broken STAC
// publish surfaces every offending dataset at once.
function validateEntries(entries) {
  const problems = [];
  for (const e of entries) {
    const id = e.id || "(unknown id)";
    if (!e.title) problems.push(`${id}: missing title`);
    if (!e.distributions.some((a) => a.roles.includes("data"))) {
      problems.push(`${id}: no data-role asset (STAC assets: ${e.distributions.map((a) => a.key).join(", ") || "none"})`);
    }
    if (!Array.isArray(e.spatial_bbox) || e.spatial_bbox.length !== 4) {
      problems.push(`${id}: missing/invalid extent.spatial.bbox`);
    }
    if (!e.temporal_interval || !e.temporal_interval[0]) {
      problems.push(`${id}: missing extent.temporal.interval start`);
    }
    if (!e.license_url) problems.push(`${id}: no license link (rel="license")`);
  }
  if (problems.length) {
    throw new Error(
      `catalog.js: ${problems.length} STAC dataset(s) fail the structured-data contract:\n  - ${problems.join("\n  - ")}`,
    );
  }
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
