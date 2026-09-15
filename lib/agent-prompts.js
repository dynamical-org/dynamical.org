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

module.exports = { SETUP_LINE, SETUP_PROMPT, MIGRATION };
