// Turns a catalog entry plus its datasets.cjs row into the options the
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

const { FRAME } = require("./preview.cjs");

const KM_PER_DEGREE = 111.2;
// Spatial chunks the first view of a materialized store shows, at most, across and down.
const CHUNKS_WIDE = 6;
const CHUNKS_TALL = 4;
const RAD = Math.PI / 180;
// Web Mercator y in longitude-degree units, and back.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / RAD;
const latOf = (y) => (2 * Math.atan(Math.exp(y * RAD)) - Math.PI / 2) / RAD;

// A materialized dataset's first view: the row's initialView as the map shows it on a
// desktop page (fitted to the 16:9 frame, like mount()), shrunk about its centre until the
// frame shows at most CHUNKS_WIDE chunks of the default variable across and CHUNKS_TALL
// down. A view already within that is kept. It is a desktop target: a phone's taller box
// shows more latitude, and the chunks cut by the edges are read too.
// Chunk sizes come from the STAC cube the entry carries: chunk cells × cell size
// (extent span / (size − 1)), in degrees for lat/lon, metres for projected grids
// (HRRR) and great-circle degrees for rotated ones (HRDPS), converted to lon/lat
// degrees at the centre. Virtual rows and entries without that metadata keep the row's view.
function chunkView(entry, dataset) {
  const keep = dataset.initialView;
  const variable = entry["cube:variables"]?.[dataset.defaultVariable];
  const dims = entry["cube:dimensions"];
  if (dataset.virtual || !variable?.chunks || !dims) return keep;
  const [w, s, e, n] = keep.bounds;
  const cLon = (w + e) / 2;
  const cy = (mercY(s) + mercY(n)) / 2;
  const cos = Math.cos(latOf(cy) * RAD);
  // One chunk's extent along a spatial dim in lon or lat degrees, or null if unknown.
  const span = (name, cells, axis) => {
    const d = dims[name];
    if (!d?.extent || !(d.size > 1)) return null;
    const native = (cells * (d.extent[1] - d.extent[0])) / (d.size - 1);
    if (/^degrees?_(north|east)$/.test(d.unit)) return native;
    const km = d.unit === "m" ? native / 1000 : d.unit === "degrees" ? native * KM_PER_DEGREE : null;
    if (km === null) return null;
    return axis === "x" ? km / (KM_PER_DEGREE * cos) : km / KM_PER_DEGREE;
  };
  const [yName, xName] = variable.dimensions.slice(-2);
  const [yCells, xCells] = variable.chunks.slice(-2);
  const [dy, dx] = [span(yName, yCells, "y"), span(xName, xCells, "x")];
  if (dy === null || dx === null) return keep;
  // The row's view as mount() fits it to the desktop frame: its full width or its full
  // height inside the padding, at the inner box's aspect (width × height, Mercator units).
  const inner = [FRAME.width - 2 * FRAME.padding, FRAME.mapHeight - 2 * FRAME.padding];
  const aspect = inner[0] / inner[1];
  const width = Math.max(e - w, (mercY(n) - mercY(s)) * aspect);
  const height = width / aspect;
  const lats = (h) => [latOf(cy - h / 2), latOf(cy + h / 2)];
  // What the whole frame shows, padding included: the chunks counted are the visible ones.
  const [shownWidth, shownHeight] = [(width * FRAME.width) / inner[0], (height * FRAME.mapHeight) / inner[1]];
  const [s0, n0] = lats(shownHeight);
  const f = Math.min(1, (CHUNKS_WIDE * dx) / shownWidth, (CHUNKS_TALL * dy) / (n0 - s0));
  if (f >= 1) return keep;
  const [s1, n1] = lats(height * f);
  const round = (v) => Math.round(v * 1000) / 1000;
  return { bounds: [cLon - (width * f) / 2, s1, cLon + (width * f) / 2, n1].map(round) };
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
    initialView: chunkView(entry, dataset),
    proj4: dataset.proj4,
    ...(dataset.virtual ? { virtual: true } : {}),
  };
}

module.exports = { explorerMountOptions, chunkView };
