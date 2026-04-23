const fetch = require("@11ty/eleventy-fetch");

const CC_BY_4 = `
        <p>
        Dataset licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
        </p>
`;

const ECMWF_LICENSE = `
        <p>
        This data is based on data and products of the European Centre for
        Medium-Range Weather Forecasts (ECMWF). Use is governed by the
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> license
        and the ECMWF <a href="https://apps.ecmwf.int/datasets/licences/general/">Terms of Use</a>.
        </p>
`;

// Entries are minimal here — url (for slug derivation and the copyable input),
// status (live / coming soon / deprecated), and license blurb. All prose
// (descriptions, examples, per-model metadata) is fetched from STAC at build
// time and merged in via reshapeStacCollection. The one exception is the
// dwd-icon-eu "coming soon" entry, which has no STAC collection yet and so
// authors its prose inline as a fallback.
let entries = [
  {
    url: "https://data.dynamical.org/noaa/gfs/analysis/latest.zarr",
    status: "live",
    license: CC_BY_4,
  },
  {
    url: "https://data.dynamical.org/noaa/gfs/forecast/latest.zarr",
    status: "live",
    license: CC_BY_4,
  },
  {
    url: "https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr",
    status: "live",
    license: CC_BY_4,
  },
  {
    url: "https://data.dynamical.org/noaa/gefs/analysis/latest.zarr",
    status: "live",
    license: CC_BY_4,
  },
  {
    url: "https://data.dynamical.org/noaa/hrrr/forecast-48-hour/latest.zarr",
    status: "live",
    license: CC_BY_4,
  },
  {
    url: "https://data.dynamical.org/noaa/hrrr/analysis/latest.zarr",
    status: "live",
    license: CC_BY_4,
  },
  {
    url: "https://data.dynamical.org/noaa/mrms/conus-analysis-hourly/latest.zarr",
    status: "live",
    license: CC_BY_4,
  },
  // dwd-icon-eu — not yet in STAC, so prose lives inline as markdown (matching
  // the shape STAC Collections will carry once this dataset is ingested).
  // Remove the fallback block then.
  {
    url: "https://data.dynamical.org/dwd/icon-eu/forecast-5-day/latest.zarr",
    status: "coming soon",
    license: CC_BY_4,
    model_id: "dwd-icon-eu",
    description_summary:
      "This dataset is an archive of past and present ICON-EU forecasts. " +
      "Forecasts are identified by an initialization time (`init_time`) denoting " +
      "the start time of the model run and step forward in time along the " +
      "`lead_time` dimension. This dataset contains only the 00, 06, 12, " +
      "and 18 hour UTC initialization times which produce the full length, 5 day forecast.",
    description_details: [
      "### Source",
      "The source grib files this archive is constructed from are provided by " +
        "[DWD Open Data](https://www.dwd.de/EN/ourservices/opendata/opendata.html) " +
        "and the [dynamical.org DWD ICON grib archive](https://source.coop/dynamical/dwd-icon-grib) " +
        "on [Source Cooperative](https://source.coop/).",
      "### Storage",
      "Icechunk storage generously provided by [AWS Open Data](https://aws.amazon.com/opendata/). " +
        "Storage for the dynamical.org DWD ICON-EU grib archive is generously provided by " +
        "[Source Cooperative](https://source.coop/), a [Radiant Earth](https://radiant.earth/) initiative.",
      "### Compression",
      "The data values in this dataset have been rounded in their binary " +
        "floating point representation to improve compression. See " +
        "[Klöwer et al. 2021](https://www.nature.com/articles/s43588-021-00156-2) " +
        "for more information on this approach. The exact number of rounded bits " +
        "can be found in our " +
        "[reformatting code](https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/dwd/icon_eu/forecast_5_day/template_config.py).",
    ].join("\n\n"),
    examples: [
      {
        title: "Maximum temperature in a forecast",
        code: `import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/dwd/icon-eu/forecast-5-day/latest.zarr")
ds["temperature_2m"].sel(init_time="2026-04-01T00", latitude=50, longitude=10).max().compute()`,
      },
    ],
  },
  {
    url: "https://data.dynamical.org/ecmwf/aifs-single/forecast/latest.zarr",
    status: "live",
    license: ECMWF_LICENSE,
  },
  {
    url: "https://data.dynamical.org/ecmwf/ifs-ens/forecast-15-day-0-25-degree/latest.zarr",
    status: "live",
    license: ECMWF_LICENSE,
  },
].filter((entry) => !entry.hide);

const STAC_BASE_URL = process.env.STAC_BASE_URL || "https://stac.dynamical.org";

module.exports = async function () {
  for (const entry of entries) {
    if (!entry.url) continue;

    const slug = stacSlugFromUrl(entry.url);
    try {
      const collection = await fetchStacCollection(slug);
      Object.assign(entry, reshapeStacCollection(collection));
    } catch (e) {
      // Tolerate only 404 (dataset not yet ingested into STAC). Any other
      // failure — network, 5xx, malformed JSON — should fail the build
      // rather than silently publish a page missing its metadata tables.
      if (e.cause?.status !== 404) throw e;
      console.log(`No STAC collection for ${slug}: ${e.message}`);
      entry.dataset_id = entry.dataset_id || slug;
      entry.name = entry.name || slug;
    }
  }

  // Group datasets by model using STAC-provided model_id / model_name /
  // description_model. For non-STAC entries (e.g. dwd-icon-eu), model_id
  // comes from the inline hand-authored field and model_name / description_model
  // are undefined — matching prior behavior where the dwd-icon-eu row in the
  // catalog table renders with an empty model cell.
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

// e.g. https://data.dynamical.org/noaa/gfs/analysis/latest.zarr → noaa-gfs-analysis
function stacSlugFromUrl(url) {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
  return path.replace(/\/[^/]+\.zarr$/, "").split("/").join("-");
}

function fetchStacCollection(slug) {
  return fetch(`${STAC_BASE_URL}/${slug}/collection.json`, { type: "json" });
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
    long_name: v.description,
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

  return {
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
