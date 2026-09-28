// proj4 glue: the EPSG:3857 +over workaround, a local EPSG resolver (so the
// layer never fetches epsg.io), and lon/lat → grid cell for projected grids.
import { parseWkt } from "@developmentseed/proj";
import proj4 from "proj4";
import { LOCAL_CRS_CODE, nearestCell } from "./lib/grid.js";

const WKT_4326 =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

let overDefined = false;

/**
 * Upstream workaround (deck.gl-zarr 0.8.1). With "node" registration a global
 * grid's westmost cell edge is at -180.125°, and the stock EPSG:3857 wraps that
 * to +179.875°: the first tile column becomes a globe-wide smear and the mesh
 * refinement never converges. "+over" keeps longitudes unwrapped. This is a
 * global change to the proj4 instance deck.gl-zarr shares with us (the same
 * package, deduped), so it is applied once, on first mount, and only for 3857.
 */
export function defineWebMercatorOver() {
  if (overDefined) return;
  overDefined = true;
  proj4.defs(
    "EPSG:3857",
    "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +over +no_defs",
  );
}

let wgs84 = null;
let localId = 0;

/**
 * A proj4 definition object for a grid (what ZarrLayer's resolver must return:
 * it reads `.units` and `.a`/`.datum.a`).
 * @param {{ kind: "geographic" } | { kind: "projected", proj4: string, units: string }} crs
 */
export function projectionDef(crs) {
  if (crs.kind === "geographic") return (wgs84 ??= parseWkt(WKT_4326));
  const name = `EXPLORER:${++localId}`;
  proj4.defs(name, crs.proj4);
  const def = { ...proj4.defs(name) };
  def.units ??= crs.units;
  return def;
}

/**
 * The epsgResolver for one grid: 4326 resolves locally; the placeholder code
 * resolves to the grid's own projection. Anything else is an error rather than
 * a network fetch.
 */
export function makeResolver(def) {
  return async (code) => {
    if (code === 4326 || code === LOCAL_CRS_CODE) return def;
    throw new Error(`EPSG:${code} is not available offline`);
  };
}

/**
 * The grid cell nearest a lon/lat, clamped to the grid.
 * @param {ReturnType<typeof import("./lib/grid.js").buildGrid>} grid
 * @param {[number, number]} lonLat
 * @returns {[number, number]} [row, col]
 */
export function lonLatToCell(grid, [lon, lat]) {
  let x = lon;
  let y = lat;
  if (grid.crs.kind === "projected") {
    [x, y] = proj4(grid.crs.proj4).forward([lon, lat]);
  } else if (grid.wrapOffsets.length > 1 && x < 0) {
    x += 360;
  }
  return [nearestCell(grid.y, y), nearestCell(grid.x, x)];
}
