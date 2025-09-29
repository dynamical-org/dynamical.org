const fetch = require("@11ty/eleventy-fetch");
const { uniq } = require("lodash");

// Model definitions for grouping datasets
const models = {
  "noaa-gfs": {
    name: "NOAA GFS",
    shortName: "GFS", 
    description: `
      <p>
      The Global Forecast System (GFS) is a National Oceanic and Atmospheric
      Administration (NOAA) National Centers for Environmental Prediction
      (NCEP) weather forecast model that generates data for dozens of
      atmospheric and land-soil variables, including temperatures, winds,
      precipitation, soil moisture, and atmospheric ozone concentration. The
      system couples four separate models (atmosphere, ocean model, land/soil
      model, and sea ice) that work together to depict weather conditions.
      </p>
    `,
    agency: "NOAA",
    type: "Global Weather Model"
  },
  "noaa-gefs": {
    name: "NOAA GEFS", 
    shortName: "GEFS",
    description: `
      <p>
      The Global Ensemble Forecast System (GEFS) is a National Oceanic and
      Atmospheric Administration (NOAA) National Centers for Environmental
      Prediction (NCEP) weather forecast model. GEFS creates 31 separate
      forecasts (ensemble members) to describe the range of forecast uncertainty.
      </p>
    `,
    agency: "NOAA",
    type: "Global Ensemble Weather Model"
  },
  "noaa-hrrr": {
    name: "NOAA HRRR",
    shortName: "HRRR",
    description: `
      <p>
      The High-Resolution Rapid Refresh (HRRR) is a NOAA real-time 3-km resolution,
      hourly updated, cloud-resolving, convection-allowing atmospheric model,
      initialized by 3km grids with 3km radar assimilation. Radar data is
      assimilated in the HRRR every 15 min over a 1-h period adding further
      detail to that provided by the hourly data assimilation from the 13km
      radar-enhanced Rapid Refresh.
      </p>
    `,
    agency: "NOAA",
    type: "Regional Weather Model"
  }
};

let entries = [
  // noaa-gfs-analysis-hourly
  {
    modelId: "noaa-gfs",
    descriptionSummary: `
        <p>
        This analysis dataset is an archive of the model's best estimate of past weather.
        It is created by concatenating the first few hours of each historical forecast to
        provide a dataset with dimensions time, latitude, and longitude.
        </p>
      `,
    descriptionDetails: `
        <h3>Construction</h3>
        <p>
        GFS starts a new model run every 6 hours and
        dynamical.org has created this analysis by concatenating the first 6
        hours of each forecast along the time dimension.
        </p>

        <h3>Interpolation</h3>
        <p>
        Before 2021-02-27 GFS had a 3 hourly step at early forecast hours.
        In this reanalysis we have used linear interpolation in the time
        dimension to fill in the two timesteps between the three-hourly
        values prior to 2021-02-27.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>

        <h3>Compression</h3>
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

ds = xr.open_zarr("https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.zarr?email=optional@email.com")
ds["temperature_2m"].sel(time="2024-06-01T00:00").mean().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-analysis-hourly.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gfs-analysis-hourly.ipynb",
  },

  // noaa-gfs-forecast
  {
    modelId: "noaa-gfs",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present GFS forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run. Each forecast steps forward in time along the
        <code>lead_time</code> dimension.
        </p>
      `,
    descriptionDetails: `
        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gfs/forecast/template_config.py">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/noaa/gfs/forecast/latest.zarr",
    status: "live",
    examples: [
      {
        title: "Maximum temperature in a forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/gfs/forecast/latest.zarr?email=optional@email.com")
ds["temperature_2m"].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-forecast.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gfs-forecast.ipynb",
  },

  // noaa-gefs-forecast-35-day
  {
    modelId: "noaa-gefs",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present GEFS forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run as well as by the <code>ensemble_member</code>.
        Each forecast has a 3 hourly forecast step along the <code>lead_time</code>
        dimension. This dataset contains only the 00 hour UTC initialization times
        which produce the full length, 35 day forecast.
        </p>
      `,
    descriptionDetails: `
        <h3>Interpolation</h3>
        <p>
        Source data is available at both 0.25-degree and 0.5-degree resolutions.
        All variables except the 100m wind components are derived
        from a 0.25-degree grid for the first 240 hours of each forecast and from a
        0.5-degree grid for the remainder. 100m wind components are derived from
        a 0.5-degree grid for all lead times. Bilinear interpolation is used to convert
        0.5-degree data to a 0.25-degree grid. The original 0.5-degree values can be
        retrieved by selecting every other pixel starting from offset 0 in both the
        latitude and longitude dimensions (e.g. <code>array[::2, ::2]</code>).
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gefs/common_gefs_template_config.py">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr",
    status: "live",
    examples: [
      {
        title: "Maximum temperature in ensemble forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr?email=optional@email.com")
ds["temperature_2m"].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-forecast-35-day.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gefs-forecast-35-day.ipynb",
  },

  // noaa-gefs-analysis
  {
    modelId: "noaa-gefs",
    descriptionSummary: `
        <p>
        This analysis dataset is an archive of the model's best estimate of past weather.
        It is created by concatenating the first few hours of each historical forecast to
        provide a dataset with dimensions time, latitude, and longitude.
        </p>
      `,
    descriptionDetails: `
        <h3>Sources</h3>
        <p>
        To provide the longest possible historical record, this dataset in constructed
        from three distinct GEFS forecast archives.
        </p>
        <ul>
          <li>From 2000-01-01 to 2019-12-31 we use the <a href="https://registry.opendata.aws/noaa-gefs-reforecast/">GEFS reforecast</a>.</li>
          <li>From 2020-01-01 to 2020-09-23 we use <a href="https://registry.opendata.aws/noaa-gefs/">GEFS forecast archive</a> data which has a lower spatial and temporal resolution.</li>
          <li>From 2020-09-23 to Present we use <a href="https://registry.opendata.aws/noaa-gefs/">GEFS operational forecast archives</a>.</li>
        </ul>

        <h3>Variable availability</h3>
        <p>
        Data is available for all variables at all times with the following exceptions.
        </p>
        <ul>
          <li>Unavailable before 2020-01-01:
            <code>relative_humidity_2m</code>,
            <code>percent_frozen_precipitation_surface</code>,
            <code>categorical_freezing_rain_surface</code>,
            <code>categorical_ice_pellets_surface</code>,
            <code>categorical_rain_surface</code>,
            <code>categorical_snow_surface</code>
          </li>
          <li>Unavailable 2020-01-01T00 to 2020-09-22T21:
            <code>geopotential_height_cloud_ceiling</code>
          </li>
        </ul>

        <h3>Construction</h3>
        <p>
        To create a single time dimension we concatenate the first few hours of each forecast.
        From 2000-01-01 to 2019-12-31 reforecasts are available once per day and this dataset
        uses the first 21 or 24 hours of each forecast. From 2020-01-01 to present forecasts
        are available every 6 hours and this dataset uses the first 3 or 6 hours of each forecast.
        Variables with an instantaneous <code>step_type</code> use the shortest possible lead times
        (e.g. 0 and 3 hours) while accumulated variables must use one additional forecast
        step (e.g. 3 and 6 hours) because they do not have an hour 0 forecast value.
        </p>

        <h3>Interpolation</h3>
        <p>
        For most of the time range of the archive the source data is available at 0.25-degree
        resolution and a 3 hourly time step and we perform no interpolation. There are two
        exceptions to this. 1) From 2020-01-01 to 2020-09-23 the source data has a 1.0-degree
        spatial resolution and a 6 hourly time step. 2) From 2020-09-23 to present the 100m
        wind components have a 0.5-degree spatial resolution in the source data.
        To provide a consistent archive in the above two cases we first perform bilinear
        interpolation in space to 0.25-degree resolution followed by linear interpolation in time
        to a 3-hourly timestep if necessary. The original, uninterpolated data can be obtained
        by selecting latitudes and longitudes evenly divisible by 1 and, in case 1), time steps
        whose hour is divisible by 6.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gefs/common_gefs_template_config.py">reformatting code</a>.
        </p>

      `,
    url: "https://data.dynamical.org/noaa/gefs/analysis/latest.zarr",
    status: "live",
    examples: [
      {
        title: "Temperature at a specific place and time",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/gefs/analysis/latest.zarr?email=optional@email.com")
ds["temperature_2m"].sel(time="2025-01-01T00", latitude=0, longitude=0).compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-analysis.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gefs-analysis.ipynb",
  },

  // noaa-hrrr-forecast-48-hour
  {
    modelId: "noaa-hrrr",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present HRRR forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run.
        Each forecast has an hourly forecast step along the <code>lead_time</code>
        dimension. This dataset contains only the 00, 06, 12, and 18 hour UTC
        initialization times which produce the full length, 48 hour forecast.
        </p>

        <p>
        This dataset uses the native HRRR Lambert Conformal Conic projection,
        with spatial indexing along the <code>x</code> and <code>y</code> dimensions.
        The example notebook shows how to use the embedded spatial reference to
        select geographic areas of interest.
        </p>
      `,
    descriptionDetails: `
        <h3>Sources</h3>
        <p>
        The source grib files this archive is contructed from are provided by
        <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemniation (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-hrrr-pds/">AWS Open Data Registry</a>.
        </p>

        <h3>Data availability</h3>
        <p>
        Forecasts initialized through 2020-12-02T06 UTC include data
        only for the first 36 hours; steps 37–48 are filled with NaNs. Starting with
        the 2020-12-02T12 UTC initialization, forecasts cover the full 48 hours.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/">reformatting code</a>.
        </p>

      `,
    url: "https://data.dynamical.org/noaa/hrrr/forecast-48-hour/latest.zarr",
    status: "coming soon",
    examples: [
      {
        title: "Maximum temperature in a forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/hrrr/forecast-48-hour/latest.zarr?email=optional@email.com")
ds["temperature_2m"].sel(init_time="2025-01-01T00", x=0, y=0, method="nearest").max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-hrrr-forecast-48-hour.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-hrrr-forecast-48-hour.ipynb",
  },
].filter((entry) => !entry.hide);

module.exports = async function () {
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].url) {
      continue;
    }

    try {
      // Try zarr v3 format first
      const datasetInfo = await processZarrV3(entries[i].url);
      entries[i] = {
        ...entries[i],
        ...datasetInfo,
      };
    } catch (e) {
      console.log(
        `Falling back to zarr v2 for ${entries[i].url}: ${e.message}`
      );
      // Fall back to zarr v2 format
      const datasetInfo = await processZarrV2(entries[i].url);
      entries[i] = {
        ...entries[i],
        ...datasetInfo,
      };
    }
  }

  // Group datasets by model
  const modelGroups = {};
  entries.forEach(dataset => {
    if (dataset.modelId) {
      if (!modelGroups[dataset.modelId]) {
        modelGroups[dataset.modelId] = {
          ...models[dataset.modelId],
          id: dataset.modelId,
          datasets: []
        };
      }
      modelGroups[dataset.modelId].datasets.push(dataset);
    }
  });

  // Add related datasets to each entry
  entries.forEach(dataset => {
    if (dataset.modelId && modelGroups[dataset.modelId]) {
      dataset.relatedDatasets = modelGroups[dataset.modelId].datasets
        .filter(d => d.dataset_id !== dataset.dataset_id)
        .map(d => ({
          name: d.name,
          dataset_id: d.dataset_id,
          descriptionSummary: d.descriptionSummary
        }));
      dataset.model = models[dataset.modelId];
    }
  });

  return { 
    entries, 
    models: Object.values(modelGroups),
  };
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
