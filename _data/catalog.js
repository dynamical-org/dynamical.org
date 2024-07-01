const fetch = require('@11ty/eleventy-fetch');
const {uniq} = require('lodash');

let catalog = [
  {
    name: 'NOAA GFS 6-hourly Analysis',
    description:
      "Historical weather data from the US National Oceanic and Atmospheric Administration's Global Forecast System",
    url: 'https://data.dynamical.org/gfs/analysis/latest.zarr',
    status: 'Initial release',
  },
];

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
