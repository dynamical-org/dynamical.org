// The prompts a reader copies into an AI assistant to work with dynamical.org
// data (dynamical-org/meta#96). Each one has to work pasted cold into any
// assistant with no other context, so every prompt names the STAC catalog —
// the one resource an agent must know — and the richer ones add llms.txt for
// the conventions. Kept as plain strings here rather than in templates so the
// tests can hold them to a word budget and to the rule that storage URLs are
// resolved from STAC, never pasted.

const STAC_CATALOG = "https://stac.dynamical.org/catalog.json";
const LLMS_TXT = "https://dynamical.org/llms.txt";
const API_DOCS = "https://dynamical.org/api/";
const MCP_SERVER = "https://mcp.dynamical.org/mcp";
const SETUP_PROMPT = "https://dynamical.org/agent-setup/prompt.md";

/**
 * The one line behind the "onboard your agent" pill: the agent fetches
 * /agent-setup/prompt.md (content/agent-setup.njk) and follows it. Modelled on
 * developers.cloudflare.com/agent-setup so people who have seen that one know
 * what it does.
 */
const SETUP_LINE = `Fetch and follow the setup instructions at ${SETUP_PROMPT}`;

const OPEN_HINT =
  "Open a dataset with dynamical_catalog.open(\"<dataset-id>\") from the dynamical-catalog package (Python 3.12+), or with icechunk>=2 and xarray from the collection's icechunk-https asset. Resolve storage URLs from STAC at run time; never hard-code them. Select the variables, the region, and the time window before loading anything; the archives run to terabytes.";

/** The task prompts, in the order the /agents/ page shows them. */
const PROMPTS = [
  {
    id: "minimum",
    title: "The minimum",
    audience: "Any assistant. The STAC catalog is the one thing it must know.",
    text: `Use the free, open weather and climate data published by dynamical.org. The STAC catalog at ${STAC_CATALOG} is the source of truth: read it first, then the collection.json of any dataset you use. Each collection lists the variables with units, the dimensions, the extent, the license, and the icechunk-https asset to open, and its examples show how to open it. No credentials are needed. Resolve storage URLs from STAC at run time; never hard-code them. Select the variables, the region, and the time window before loading anything. Then ask me what I want to make.`,
  },
  {
    id: "standard",
    title: "With the conventions",
    audience: "Any assistant that can fetch URLs. Adds llms.txt, so it also learns how the datasets are shaped.",
    text: `Help me work with the open weather and climate data from dynamical.org. Read these before writing any code:
1. ${LLMS_TXT} — what the datasets are, how they are structured, how to open them, and the conventions.
2. ${STAC_CATALOG} — the catalog. Each dataset's collection.json lists the variables with units, the dimensions, the extent, the license, and the icechunk-https asset.
${OPEN_HINT} Forecast datasets are indexed by init_time (the model run, UTC) and lead_time; analysis datasets by time. Choose the dataset by domain, resolution, and forecast horizon, and tell me which one you chose and why.`,
  },
  {
    id: "presentation",
    title: "A chart for a presentation",
    audience: "No code required of you. Routes the assistant through the point API, which returns JSON.",
    text: `I am making a presentation and want a chart of the 2 m temperature forecast for <city> for the next 7 days, from dynamical.org's free open weather data, with the source credited. Read ${LLMS_TXT} first. The simplest route is the point API documented at ${API_DOCS}: POST https://api.dynamical.org/v1/forecasts with a dataProductId of noaa-gfs-forecast, the city's latitude and longitude, variables ["temperature_2m"], and validTimeStart now and validTimeEnd 7 days from now (UTC). It returns JSON for the latest model run with no credentials. Convert the times to the city's local time, label the units, save a clean chart as a PNG I can drop into a slide, and caption it "NOAA GFS forecast via dynamical.org, run <initTime>".`,
  },
  {
    id: "verification",
    title: "Compare a forecast with its analysis",
    audience: "Analysts. Scores a forecast dataset against the model's own analysis.",
    text: `Using dynamical.org's open data, compare the NOAA GFS 2 m temperature forecast with its analysis at <latitude, longitude> for valid times in the last 30 days. Read ${LLMS_TXT} and ${STAC_CATALOG} first. Use noaa-gfs-forecast (indexed by init_time and lead_time) and noaa-gfs-analysis as the reference (indexed by time; it is the model's own estimate of what happened, not observations, so say so). ${OPEN_HINT} Keep only init_times whose valid times (init_time + lead_time) fall in the window, drop pairs where either side is missing, and report bias, RMSE, and sample count by lead time with a plot.`,
  },
  {
    id: "ensemble",
    title: "A multi-model ensemble",
    audience: "Practitioners. Combines several models into one forecast with spread.",
    text: `Build a multi-model ensemble forecast of 10 m wind speed for <location> for valid times from now until 5 days from now (UTC), from dynamical.org's open data. Read ${LLMS_TXT} and ${STAC_CATALOG} first, then choose from noaa-gfs-forecast, ecmwf-aifs-single-forecast, ecmwf-ifs-ens-forecast-15-day-0-25-degree, noaa-gefs-forecast-35-day, and dwd-icon-eu-forecast-5-day by domain, variables, and lead times. ${OPEN_HINT} Use each one's latest init_time and only the leads inside the window, compute wind speed from u and v, and align on valid time at the coarsest common step. Weight models equally and members equally within a model; show the mean, spread, and each model, and report any window a model cannot cover.`,
  },
];

/** Setup rather than a task: how a coding agent gets the catalog as a tool. */
const SETUP = [
  {
    id: "mcp",
    title: "Connect the MCP server",
    audience: "Coding agents that can add tools. The server reads the live catalog.",
    text: `Add dynamical.org's MCP server so you can search its open weather-data catalog directly: URL ${MCP_SERVER}, streamable HTTP transport, no authentication. Its tools are search_catalog, get_dataset_info, get_access_pattern, and list_recent_runs. Configure it for this session or this project only, keep my existing servers, and ask before making any user-wide change. If you cannot add MCP servers, read ${LLMS_TXT} and ${STAC_CATALOG} instead. Then ask me what I want to build.`,
  },
];

/**
 * A prompt for one dataset page. `entry` is a catalog entry from
 * _data/catalog.js: id, title, stac_href, dimensions, optimization.
 */
function datasetPrompt(entry) {
  const dims = (entry.dimensions || []).map((d) => d.name).join(", ");
  const chunking =
    entry.optimization === "space"
      ? "This archive is chunked for whole-grid reads: one time across the whole domain is cheap, a long time series at one point is not."
      : "This archive is chunked for time series: a point or small area across many times is cheap, the whole grid at one time is not.";
  return `Help me use the ${entry.title} dataset from dynamical.org (id ${entry.id}). Read its STAC collection first: ${entry.stac_href}. It lists every variable with units, the dimensions (${dims}), the spatial and temporal extent, the license, and the icechunk-https asset to open. Then read ${LLMS_TXT} for the conventions. Open it with dynamical_catalog.open("${entry.id}") from the dynamical-catalog package (Python 3.12+), or with icechunk>=2 and xarray from the asset, resolved from STAC at run time rather than hard-coded. Select the variables, the region, and the time window before loading anything. ${chunking}`;
}

/** The migration page's prompt (content/migration-2026.njk): a coding agent
 * working inside a repository that still uses data.dynamical.org URLs. */
const MIGRATION = {
  id: "migration",
  title: "Migrate from data.dynamical.org",
  text: `Replace every data.dynamical.org URL in this repository with dynamical.org's
supported access, and leave no hard-coded storage locations behind.

Context to read first:
- https://dynamical.org/llms.txt for current access patterns and dataset IDs.
- https://stac.dynamical.org/catalog.json is the source of truth. Confirm each
  dataset ID against it rather than guessing.

Rules:
- A legacy URL maps to a dataset ID by dropping the host and joining the path
  with hyphens: data.dynamical.org/noaa/gfs/forecast/latest.zarr ->
  noaa-gfs-forecast. Exception: /noaa/gfs/analysis-hourly/ is retired, use
  noaa-gfs-analysis.
- Two ways to open a dataset, equally supported. Use either, consistently:

  import dynamical_catalog

  ds = dynamical_catalog.open("noaa-gfs-forecast", chunks=None)

  or, resolving the asset from STAC yourself:

  import icechunk
  import pystac
  import xarray as xr

  catalog = pystac.Catalog.from_file("https://stac.dynamical.org/catalog.json")
  collection = catalog.get_child("noaa-gfs-forecast")
  asset = collection.assets["icechunk-https"]

  repo = icechunk.Repository.open(icechunk.http_storage(asset.href))
  session = repo.readonly_session("main")

  ds = xr.open_zarr(session.store, chunks=None)

  Any HTTP client reads the STAC; pystac is not required.
- The first option needs the latest dynamical-catalog.
- Either way you open an Icechunk 2.0 repository, so Icechunk 2 is required; in
  Python that means 3.12+. Resolve the asset at open time — do not hard-code the
  asset href, the S3 bucket, or a version number.
- Drop any ?email= query argument. It is no longer used.
- The datasets are identical to the legacy archive in structure, naming,
  attributes, chunking/sharding, and content — only the open call changes, so
  leave the surrounding analysis code alone.

Report every URL you could not map, and every place a dataset ID had to be
chosen rather than derived.`,
};

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

module.exports = { PROMPTS, SETUP, SETUP_LINE, SETUP_PROMPT, MIGRATION, datasetPrompt, wordCount, STAC_CATALOG, LLMS_TXT };
