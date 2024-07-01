const fetch = require('@11ty/eleventy-fetch');

let catalog = [
  {
    name: 'NOAA GFS 6-hourly Analysis',
    description:
      "Historical weather data from the US National Oceanic and Atmospheric Administration's Global Forecast System",
    url: 'https://data.dynamical.org/gfs/analysis/latest.zarr',
    status: 'todo-phase1',
  },
];

module.exports = async function () {
  for (let i = 0; i < catalog.length; i++) {
    let metadataKeys = {};
    let metadata = {};
    if (catalog[i].url) {
      metadata = (await fetch(`${catalog[i].url}/.zmetadata`, {type: 'json'}))['metadata'];
      metadataKeys = Object.keys(metadata);
    }

    let dimensions = [];
    let variables = [];
    for (let i = 0; i < metadataKeys.length; i++) {
      const key = metadataKeys[i];
      if (key.endsWith('.zattrs') && metadata[key]['_ARRAY_DIMENSIONS']) {
        const name = key.substring(0, key.indexOf('/'));
        if (metadata[key]['_ARRAY_DIMENSIONS'].length === 1) {
          dimensions.push({
            name,
            ...metadata[key],
            ...metadata[`${name}/.zarray`],
          });
        } else {
          variables.push({name, ...metadata[key], ...metadata[`${name}/.zarray`]});
        }
      }
    }
    catalog[i].dimensions = dimensions;
    catalog[i].variables = variables;
  }

  return catalog;
};
