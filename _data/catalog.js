const fetch = require('@11ty/eleventy-fetch');
const {uniq} = require('lodash');

let catalog = [
  {
    name: 'NOAA GFS Analysis',
    description:
      "Hourly historical weather data from NOAA's Global Forecast System from XXXX to the present.",
    url: 'https://data.dynamical.org/noaa/gfs/analysis-hourly/latest.zarr',
    status: 'Release on 2024-07-03',
  },
  {
    name: 'NOAA GFS Forecast',
    description:
      "Real-time forecasts from NOAA's Global Forecast System, updating every 6 hours.",
    // url: 'https://data.dynamical.org/noaa/gfs/forecast/latest.zarr',
    status: 'Phase 1 Roadmap',
    hide: true
  },
  {
    name: 'NOAA HRRR Forecast',
    description:
      "Real-time forecasts leveraging a 3-km resolution, hourly updated, cloud-resolving, convection-allowing atmospheric model.",
    // url: 'https://data.dynamical.org/noaa/gfs/forecast/latest.zarr',
    status: 'Phase 1 Roadmap',
    hide: true
  },
  {
    name: 'ECMWF ERA5-Land',
    description:
      "Historical weather data from European Centre for Medium-Range Weather Forecasts's enhanced reanalysis dataset providing a consistent view of the evolution of land variables over several decades.",
    // url: 'https://data.dynamical.org/noaa/gfs/forecast/latest.zarr',
    status: 'Phase 1 Roadmap',
    hide: true
  },
].filter(entry => !entry.hide);

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

    catalog[i].dimensions = dimensions;
    catalog[i].variables = variables;
  }

  return catalog;
};
