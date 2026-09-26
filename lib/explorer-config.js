// Turns a catalog entry plus its _data/explorer.js row into the options the
// explorer's mount() takes (see explorer/README.md). The page serializes them
// into the Explore section, so this runs at build time only.

// Root variables and nested-group variables, flattened. `path` is the array's
// location in the store and the variable's identity; nothing is filtered out
// here, since the explorer disables what it can't draw and says why.
function explorerVariables(entry) {
  const pick = (v, path) => ({
    path,
    name: v.name,
    long_name: v.long_name,
    units: v.units,
    dims: v.dimension_names,
  });
  return [
    ...entry.variables.map((v) => pick(v, v.name)),
    ...(entry.variableGroups || []).flatMap((g) =>
      g.variables.map((v) => pick(v, `${g.name}/${v.name}`)),
    ),
  ];
}

// Null when the dataset isn't enabled or publishes no HTTPS Icechunk asset,
// which is the template's cue to leave the Explore section out.
function explorerMountOptions(entry, datasets) {
  const dataset = datasets.find((d) => d.id === entry.id);
  const href = entry.assets?.["icechunk-https"]?.href;
  if (!dataset || !href) return null;
  return {
    id: entry.id,
    href,
    variables: explorerVariables(entry),
    defaultVariable: dataset.defaultVariable,
    initialView: dataset.initialView,
    proj4: dataset.proj4,
    ...(dataset.virtual ? { virtual: true } : {}),
  };
}

module.exports = { explorerMountOptions };
