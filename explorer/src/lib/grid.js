// Spatial adapter: turn a store's 1-D coordinate arrays and its CF grid mapping
// into the GeoZarr attributes deck.gl-zarr's ZarrLayer reads. Pure: no proj4,
// no network, so test/explorer-grid.test.mjs can import it directly.

/**
 * A placeholder CRS code for projected grids. It is not a real EPSG code: the
 * explorer's resolver maps it to the grid's own proj4 definition, because
 * geozarr only accepts `AUTHORITY:NUMBER` codes and deck.gl-zarr only resolves
 * EPSG ones.
 */
export const LOCAL_CRS_CODE = 0;

/** How far any coordinate may sit from the fitted line, as a fraction of a step. */
const SPACING_TOLERANCE = 1e-3;

/**
 * Fit a uniform axis to coordinate values and check that every value lies on it.
 * Values are cell centres.
 * @param {ArrayLike<number>} values
 * @param {string} name used in the error message
 * @returns {{ start: number, step: number, n: number }}
 */
export function uniformAxis(values, name) {
  const n = values.length;
  if (n < 2) throw new Error(`Coordinate "${name}" has ${n} value(s); need at least 2 to infer the grid spacing`);
  const start = Number(values[0]);
  const step = (Number(values[n - 1]) - start) / (n - 1);
  if (!Number.isFinite(step) || step === 0) {
    throw new Error(`Coordinate "${name}" has zero or non-finite spacing`);
  }
  for (let i = 0; i < n; i++) {
    const off = Math.abs(Number(values[i]) - (start + i * step));
    if (!(off <= SPACING_TOLERANCE * Math.abs(step))) {
      throw new Error(
        `Coordinate "${name}" is not uniformly spaced (value ${i} is ${values[i]}, expected ${start + i * step}); the explorer only draws regular grids`,
      );
    }
  }
  return { start, step, n };
}

/** CF earth-shape parameters as proj4 `+a`/`+b`, defaulting to WGS84. */
function earthShape(gm) {
  const a = gm.semi_major_axis ?? gm.earth_radius;
  const b = gm.semi_minor_axis ?? gm.earth_radius;
  if (a == null) return "+ellps=WGS84";
  if (b == null && gm.inverse_flattening) return `+a=${a} +rf=${gm.inverse_flattening}`;
  return `+a=${a} +b=${b ?? a}`;
}

/**
 * A proj4 string for a CF grid mapping, or null when the grid is plain
 * latitude/longitude.
 *
 * The datum is left unset on purpose (no `+towgs84`), so proj4 does no datum
 * shift: our stores follow the source models in reading their sphere
 * coordinates as WGS84 latitude/longitude, the same convention used for
 * latitude_longitude grids below.
 * @param {Record<string, any>} gm grid-mapping attributes (the store's spatial_ref)
 * @returns {string | null}
 */
export function cfToProj4(gm) {
  const name = gm?.grid_mapping_name;
  if (!name || name === "latitude_longitude") return null;
  const earth = earthShape(gm);
  if (name === "lambert_conformal_conic") {
    const sp = [].concat(gm.standard_parallel);
    const lat1 = sp[0];
    const lat2 = sp[1] ?? sp[0];
    return [
      "+proj=lcc",
      `+lat_1=${lat1}`,
      `+lat_2=${lat2}`,
      `+lat_0=${gm.latitude_of_projection_origin}`,
      `+lon_0=${gm.longitude_of_central_meridian}`,
      `+x_0=${gm.false_easting ?? 0}`,
      `+y_0=${gm.false_northing ?? 0}`,
      earth,
      "+units=m",
      "+no_defs",
    ].join(" ");
  }
  if (name === "rotated_latitude_longitude") {
    // CF → PROJ: o_lat_p is the grid north pole latitude, and lon_0 is the grid
    // north pole longitude + 180 (the meridian the rotated grid is centred on).
    return [
      "+proj=ob_tran",
      "+o_proj=longlat",
      `+o_lat_p=${gm.grid_north_pole_latitude}`,
      `+o_lon_p=${gm.north_pole_grid_longitude ?? 0}`,
      `+lon_0=${180 + Number(gm.grid_north_pole_longitude)}`,
      earth,
      "+no_defs",
    ].join(" ");
  }
  throw new Error(`Unsupported grid mapping "${name}"`);
}

/**
 * Build the GeoZarr attributes for a regular grid.
 *
 * Coordinates are cell centres, so the transform's origin is the first
 * centre and `spatial:registration` is "node"; deck.gl-zarr then shifts by half
 * a cell to the true edges. Descending (north-up) and ascending latitude are
 * both just the sign of the y step.
 *
 * Latitude/longitude grids are declared EPSG:4326. Our stores' CF CRS is often
 * a WMO sphere (r = 6,371,229 m); the explorer deliberately draws those
 * degrees as WGS84 degrees, because a sphere→ellipsoid datum shift would move
 * the field away from where the coordinates say it is.
 *
 * Longitudes past 180 (a 0..360 grid) are kept as-is; `wrapOffsets` lists the
 * extra copies the caller must draw (shifted by -360) so the eastern half
 * shows up west of Greenwich instead of beyond the antimeridian.
 *
 * @param {{
 *   yName: string, xName: string,
 *   y: ArrayLike<number>, x: ArrayLike<number>,
 *   gridMapping?: Record<string, any> | null,
 *   proj4?: string | null,
 * }} args
 * @returns {{
 *   attrs: Record<string, unknown>,
 *   crs: { kind: "geographic" } | { kind: "projected", proj4: string, units: string },
 *   wrapOffsets: number[],
 *   y: { start: number, step: number, n: number },
 *   x: { start: number, step: number, n: number },
 * }}
 */
export function buildGrid({ yName, xName, y, x, gridMapping = null, proj4 = null }) {
  const ya = uniformAxis(y, yName);
  const xa = uniformAxis(x, xName);
  const projString = proj4 ?? cfToProj4(gridMapping);
  const attrs = {
    "spatial:dimensions": [yName, xName],
    "spatial:transform": [xa.step, 0, xa.start, 0, ya.step, ya.start],
    "spatial:shape": [ya.n, xa.n],
    "spatial:registration": "node",
    "proj:code": projString ? `EPSG:${LOCAL_CRS_CODE}` : "EPSG:4326",
  };
  if (projString) {
    const units = /\+units=(\S+)/.exec(projString)?.[1] ?? (/\+proj=(ob_tran|longlat)/.test(projString) ? "degree" : "m");
    return { attrs, crs: { kind: "projected", proj4: projString, units }, wrapOffsets: [0], y: ya, x: xa };
  }
  if (Math.abs(ya.start) > 90.0001 || Math.abs(ya.start + (ya.n - 1) * ya.step) > 90.0001) {
    throw new Error(`Latitude "${yName}" runs outside -90..90`);
  }
  const xMax = Math.max(xa.start, xa.start + (xa.n - 1) * xa.step);
  const wrapOffsets = xMax > 180 ? [0, -360] : [0];
  return { attrs, crs: { kind: "geographic" }, wrapOffsets, y: ya, x: xa };
}

/** Shift a GeoZarr transform east by `dx` CRS units (used for the -360 copy). */
export function shiftAttrs(attrs, dx) {
  if (!dx) return attrs;
  const t = /** @type {number[]} */ (attrs["spatial:transform"]);
  return { ...attrs, "spatial:transform": [t[0], t[1], t[2] + dx, t[3], t[4], t[5]] };
}

/**
 * Nearest cell index on a uniform axis, clamped to the grid.
 * @param {{ start: number, step: number, n: number }} axis
 * @param {number} v
 */
export function nearestCell(axis, v) {
  const i = Math.round((v - axis.start) / axis.step);
  return Math.min(axis.n - 1, Math.max(0, i));
}
