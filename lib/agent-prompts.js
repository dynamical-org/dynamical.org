// The prompts a reader copies into an AI assistant to work with dynamical.org
// data (dynamical-org/meta#96). Kept as plain strings here rather than in
// templates so the tests can hold them to the rule that storage URLs are
// resolved from STAC, never pasted.

const SETUP_PROMPT = "https://dynamical.org/prompt.md";

/**
 * The one line behind the "onboard your agent" pill (agent-setup-pill.njk):
 * the agent fetches /prompt.md (content/prompt.njk) and follows it. Modelled
 * on developers.cloudflare.com/agent-setup so people who have seen that one
 * know what it does.
 */
const SETUP_LINE = `Fetch and follow the setup instructions at ${SETUP_PROMPT}`;

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

// Places a dataset prompt names, in order of preference: the first whose
// coordinates fall inside a product's bbox. A bbox is not a grid's coverage:
// New York City was checked against the point API for the projected grids
// (HRRR and HRDPS, 2026-09-29); MRMS is a lat/lon CONUS grid. London covers
// ICON-EU.
const PLACES = [
  { name: "New York City", latitude: 40.71, longitude: -74.01 },
  { name: "London", latitude: 51.51, longitude: -0.13 },
];

// The variable a dataset prompt asks about: the first of these the product
// has, else its first variable. Exact names only — the IMERG products list a
// precipitation quality index ahead of the rate.
const PREFERRED_VARIABLES = ["temperature_2m", "maximum_temperature_2m", "precipitation_surface"];

function promptPlace([west, south, east, north]) {
  const inside = PLACES.find(
    (p) => p.latitude >= south && p.latitude <= north && p.longitude >= west && p.longitude <= east,
  );
  if (inside) return `${inside.name} (${inside.latitude}, ${inside.longitude})`;
  return `(${((south + north) / 2).toFixed(2)}, ${((west + east) / 2).toFixed(2)})`;
}

/**
 * The "Example prompt" tab on a catalog page (content/catalog-pages.njk): the
 * setup line, then one bounded task on this product, written from its catalog
 * entry (_data/catalog.js) so every page gets one without hand-writing it. The
 * task is phrased as the answer to prompt.md's closing "ask what they want to
 * build", and it names the product's STAC Collection, never a storage URL.
 * Time-optimized products get a series at a place, map-optimized ones a map;
 * either way on the newest data present, since the newest run can still be
 * arriving, and the agent says which it used.
 */
function datasetPrompt(entry) {
  const names = entry.variables.map((v) => v.name);
  const name = PREFERRED_VARIABLES.find((n) => names.includes(n)) || names[0];
  const longName = entry.variables.find((v) => v.name === name).long_name || name;
  const variable = `${longName[0].toLowerCase()}${longName.slice(1)} (${name})`;
  const ensemble = entry.dimensions.some((d) => d.name === "ensemble_member");
  const forecast = Boolean(entry.forecast_domain);

  let task;
  if (entry.optimization === "space") {
    const when = forecast ? "the first lead_time of the latest init_time with data" : "the latest time with data";
    task = `map ${variable} across the whole grid at ${when}${ensemble ? ", averaged over ensemble_member" : ""}`;
  } else {
    const where = `at the grid point nearest ${promptPlace(entry.spatial_bbox)}`;
    const when = forecast ? "for every lead time of the latest init_time with data" : "over the 7 days up to its latest time with data";
    task = `plot ${variable} ${where} ${when}${ensemble ? ", one line per ensemble_member" : ""}`;
  }
  const stac = `https://stac.dynamical.org/${entry.id}/collection.json`;
  return `${SETUP_LINE}\n\nAfter setup, my task: open ${entry.id} (${stac}) and ${task}. Say which times you used.`;
}

module.exports = { SETUP_LINE, SETUP_PROMPT, MIGRATION, datasetPrompt };
