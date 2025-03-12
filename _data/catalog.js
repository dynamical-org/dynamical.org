const fetch = require("@11ty/eleventy-fetch");
const { uniq } = require("lodash");

let catalog = [
  // noaa-gfs-analysis-hourly
  {
    descriptionSummary: `
        <p>
        The Global Forecast System (GFS) is a National Oceanic and Atmospheric
        Administration (NOAA) National Centers for Environmental Prediction
        (NCEP) weather forecast model that generates data for dozens of
        atmospheric and land-soil variables, including temperatures, winds,
        precipitation, soil moisture, and atmospheric ozone concentration. The
        system couples four separate models (atmosphere, ocean model, land/soil
        model, and sea ice) that work together to depict weather conditions.
        </p>

        <p>
        This dataset is an "analysis" containing the model's best estimate of
        each value at each timestep. In other words, it does not contain a
        forecast dimension. GFS starts a new model run every 6 hours and
        dynamical.org has created this analysis by concatenating the first 6
        hours of each forecast. Before 2021-02-27 GFS had a 3 hourly step at
        early forecast hours. In this reanalysis we have used linear
        interpolation in the time dimension to fill in the two timesteps between
        the three-hourly values prior to 2021-02-27.
        </p>

        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>
      `,
    descriptionDetails: `
        <p>
        The data values in this dataset have been rounded in their binary
        representation to improve compression. We round to retain 9 bits of
        the floating point number's mantissa (a 10 digit significand) which
        creates a maximum of 0.2% difference between the original and rounded value. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information.
        </p>
      `,
    url: "https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.zarr",
    status: "available",
    examples: [
      {
        title: "Mean temperature for a single day",
        code: `
import xarray as xr

ds = xr.open_zarr("https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.json?email=optional@email.com")
ds["temperature_2m"].sel(time="2024-06-01T00:00").mean().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-analysis-hourly.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gfs-analysis-hourly.ipynb",
  },

  // noaa-gefs-forecast-35-day
  {
    descriptionSummary: `
        <p>
        The Global Ensemble Forecast System (GEFS) is a National Oceanic and
        Atmospheric Administration (NOAA) National Centers for Environmental
        Prediction (NCEP) weather forecast model. GEFS creates 31 separate
        forecasts (ensemble members) to describe the range of forecast uncertainty.
        </p>

        <p>
        This dataset is an archive of past and present GEFS forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run as well as by the <code>ensemble_member</code>.
        Each forecast has a 3 hourly forecast step along the <code>lead_time</code>
        dimension. This dataset contains only the 00 hour UTC initialization times
        which produce the full length, 35 day forecast.
        </p>

        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>
      `,
    descriptionDetails: `
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gefs/forecast_35_day/template_config.py">reformatting code</a>.
        </p>

        <p>
        The source data is available at both 0.25-degree and 0.5-degree resolutions.
        All variables—except where noted, including the 100m wind components—are derived
        from a 0.25-degree grid for the first 240 hours of each forecast and from a
        0.5-degree grid for the remainder. Bilinear interpolation is used to convert
        0.5-degree data to a 0.25-degree grid. The original 0.5-degree values can be
        retrieved by selecting every other pixel starting from offset 0 in both the 
        latitude and longitude dimensions (e.g. <code>array[::2, ::2]</code>).
        </p>
      `,
    url: "https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr",
    status: "live",
    examples: [
      {
        title: "Maximum temperature in ensemble forecast",
        code: `
import xarray as xr

ds = xr.open_zarr("https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr?email=optional@email.com")
ds['temperature_2m'].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-forecast-35-day.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gefs-forecast-35-day.ipynb",
  },
].filter((entry) => !entry.hide);

module.exports = async function () {
  for (let i = 0; i < catalog.length; i++) {
    if (!catalog[i].url) {
      continue;
    }

    try {
      // Try zarr v3 format first
      const datasetInfo = await processZarrV3(catalog[i].url);
      catalog[i] = {
        ...catalog[i],
        ...datasetInfo,
      };
    } catch (e) {
      console.log(
        `Falling back to zarr v2 for ${catalog[i].url}: ${e.message}`
      );
      // Fall back to zarr v2 format
      const datasetInfo = await processZarrV2(catalog[i].url);
      catalog[i] = {
        ...catalog[i],
        ...datasetInfo,
      };
    }
  }

  return catalog;
};

/**
 * Process zarr v2 metadata format
 * @param {string} url - URL to the zarr dataset
 * @returns {Object} - Dataset metadata with dimensions and variables
 */
async function processZarrV2(url) {
  const metadata = (await fetch(`${url}/.zmetadata`, { type: "json" }))[
    "metadata"
  ];

  const metadataKeys = Object.keys(metadata).filter(
    (key) => !key.startsWith("spatial_ref")
  );

  const dimensionKeys = uniq(
    metadataKeys
      .flatMap((key) => metadata[key]["_ARRAY_DIMENSIONS"])
      .filter((key) => !!key)
  );

  const variableKeys = metadataKeys
    .filter(
      (key) => key.endsWith(".zattrs") && metadata[key]["_ARRAY_DIMENSIONS"]
    )
    .map((key) => key.substring(0, key.indexOf("/")))
    .filter((key) => !dimensionKeys.includes(key));

  let dimensions = [];
  let variables = [];

  for (let i = 0; i < dimensionKeys.length; i++) {
    const key = dimensionKeys[i];
    dimensions.push({
      name: key,
      ...metadata[`${key}/.zattrs`],
      ...metadata[`${key}/.zarray`],
    });
  }

  for (let i = 0; i < variableKeys.length; i++) {
    const key = variableKeys[i];
    variables.push({
      name: key,
      dimension_names: metadata[`${key}/.zattrs`]["_ARRAY_DIMENSIONS"],
      ...metadata[`${key}/.zattrs`],
      ...metadata[`${key}/.zarray`],
    });
  }

  return {
    ...metadata[".zattrs"],
    dataset_id: metadata[".zattrs"]["id"],
    dimensions,
    variables,
  };
}

/**
 * Process zarr v3 metadata format
 * @param {string} url - URL to the zarr dataset
 * @returns {Object} - Dataset metadata with dimensions and variables
 */
async function processZarrV3(url) {
  const zarrJson = await fetch(`${url}/zarr.json`, { type: "json" });

  if (!zarrJson.consolidated_metadata) {
    throw new Error("No consolidated metadata found in zarr v3 format");
  }

  const metadata = zarrJson.consolidated_metadata.metadata;
  const datasetAttributes = zarrJson.attributes || {};

  const metadataKeys = Object.keys(metadata).filter(
    (key) => !key.startsWith("spatial_ref")
  );

  const dimensions = [];
  const variables = [];

  // Process metadata to identify dimensions and variables
  for (const key of metadataKeys) {
    const metaItem = metadata[key];

    // Skip if not an array (likely a group or other metadata)
    if (!metaItem.shape) continue;

    const dimensionNames = metaItem.dimension_names || [];

    // Determine if this is a dimension or a variable
    const isDimension =
      dimensionNames.length === 1 && dimensionNames[0] === key;

    const itemInfo = {
      name: key,
      ...metaItem.attributes,
      shape: metaItem.shape,
      chunks: metaItem.chunks,
      dtype: metaItem.dtype,
      dimension_names: dimensionNames,
    };

    if (isDimension) {
      dimensions.push(itemInfo);
    } else {
      variables.push(itemInfo);
    }
  }

  return {
    ...datasetAttributes,
    dimensions,
    variables,
  };
}
