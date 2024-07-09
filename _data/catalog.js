const fetch = require('@11ty/eleventy-fetch');
const {uniq} = require('lodash');

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
      `,
    url: 'https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.zarr',
    status: 'Release on 2024-07-09',
    examples: [{
      title: 'Mean temperature for a single day',
      code: `
import xarray as xr

ds = xr.open_zarr("https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.json?email=optional@email.com")
ds["temperature_2m"].sel(time="2024-06-01T00:00").mean().compute()
    `}]
  },
].filter((entry) => !entry.hide);

module.exports = async function () {
  for (let i = 0; i < catalog.length; i++) {
    if (!catalog[i].url) {
      continue;
    }

    const metadata = (await fetch(`${catalog[i].url}/.zmetadata`, {type: 'json'}))['metadata'];
    const metadataKeys = Object.keys(metadata);
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
      variables.push({name: key, ...metadata[`${key}/.zattrs`], ...metadata[`${key}/.zarray`]});
    }

    catalog[i] = {...catalog[i], ...metadata['.zattrs'], dimensions, variables};
  }

  return catalog;
};
