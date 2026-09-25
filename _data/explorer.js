const { explorerMountOptions } = require("../lib/explorer-config.js");

// Catalog datasets whose page offers the in-browser map explorer (explorer/,
// mounted by the Explore section of content/catalog-pages.njk). An id missing
// from this list gets no Explore section. Per dataset:
//
// - initialView: what the map fits on load. Regional products use their own
//   bbox; global ones open on CONUS, [-125, 24, -66, 50] (west, south, east,
//   north), because a whole-globe view reads every tile of the grid.
// - proj4: overrides the grid mapping read from the store for projected grids;
//   null means "use the store's own".
// - defaultVariable: the variable drawn first, a path from entry.variables.
// - firstViewMB: the caption's "~N MB" estimate of weather data read to draw
//   the default variable at initialView. Where each number came from is noted
//   beside it; re-measure when a store's chunking changes.
// - virtual: set true for a -virtual (GRIB-referencing) store. None are enabled
//   yet; they need the browser GRIB codec, and their own firstViewMB.
const datasets = [
  {
    id: "noaa-gfs-forecast",
    initialView: { bounds: [-125, 24, -66, 50] },
    proj4: null,
    defaultVariable: "temperature_2m",
    // Browser spike, 2026-09-25, snapshot 593MB4JXEPB4TA33RXCG (12Z run),
    // CONUS at 1280×800: 7.02 MB cold (6.46 MB of temperature_2m chunks plus
    // 0.56 MB of store metadata). A 390×844 phone viewport read 13.2 MB.
    firstViewMB: 7,
  },
];

module.exports = {
  datasets,
  // The template calls explorer.mountOptions(entry); null means no Explore section.
  mountOptions: (entry) => explorerMountOptions(entry, datasets),
};
