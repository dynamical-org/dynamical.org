const fetch = require('@11ty/eleventy-fetch');
const { uniq } = require('lodash');

let catalog = [
  // noaa-gfs-analysis-hourly
  {
    descriptionFull: `
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
        The data values in this dataset have been rounded in their binary
        representation to improve compression. We round to retain 9 bits of
        the floating point number's mantissa (a 10 digit significand) which
        creates a maximum of 0.2% difference between the original and rounded value. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information.
        </p>

        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>
      `,
    url: 'https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.zarr',
    status: 'available',
    examples: [{
      title: 'Mean temperature for a single day',
      code: `
import xarray as xr

ds = xr.open_zarr("https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.json?email=optional@email.com")
ds["temperature_2m"].sel(time="2024-06-01T00:00").mean().compute()
    `}],
    githubUrl: 'https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-analysis-hourly.ipynb',
    colabUrl: 'https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gfs-analysis-hourly.ipynb'
  },
  // noaa-gefs-forecast
  {
    descriptionFull: `
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
        which produce the full length 35 day forecast.
        </p>

        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. The exact number of
        rounded bits has been tuned for each variable and can be inspected in the
        variable's zarr encoding. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach.
        </p>

        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>
      `,
    // url: 'https://data.dynamical.org/noaa/gefs/forecast/latest.zarr',
    url: 'https://data.source.coop/dynamical/noaa-gefs-forecast/v0.0.1.zarr',
    status: 'pre-release',
    examples: [{
      title: 'Maximum temperature in ensemble forecast',
      code: `
import xarray as xr

ds = xr.open_zarr("https://data.dynamical.org/noaa/gefs/forecast/latest.json?email=optional@email.com")
ds['temperature_2m'].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `}],
    githubUrl: 'https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-forecast.ipynb',
    colabUrl: 'https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gefs-forecast.ipynb'
  },
].filter((entry) => !entry.hide);

module.exports = async function () {
  for (let i = 0; i < catalog.length; i++) {
    if (!catalog[i].url) {
      continue;
    }

    const metadata = (await fetch(`${catalog[i].url}/.zmetadata`, { type: 'json' }))['metadata'];
    const metadataKeys = Object.keys(metadata).filter(key => !key.startsWith("spatial_ref"));
    const dimensionKeys = uniq(
      metadataKeys.flatMap((key) => metadata[key]['_ARRAY_DIMENSIONS']).filter((key) => !!key)
    );
    const variableKeys = metadataKeys
      .filter((key) => key.endsWith('.zattrs') && metadata[key]['_ARRAY_DIMENSIONS'])
      .map((key) => key.substring(0, key.indexOf('/')))
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
      variables.push({ name: key, ...metadata[`${key}/.zattrs`], ...metadata[`${key}/.zarray`] });
    }

    catalog[i] = { ...catalog[i], ...metadata['.zattrs'], dimensions, variables };

    if (!catalog[i].dataset_id) {
      catalog[i].dataset_id = catalog[i].id
    }
  }

  return catalog;
};
