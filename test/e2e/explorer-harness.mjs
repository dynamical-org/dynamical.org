import { existsSync, readdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

// Shared by the explorer specs: serving the fixture Icechunk store in place of
// S3, wrapping the explorer bundle so a spec can reach its handle, and reading
// rendered pixels back as data values.

export const PAGE = "/catalog/noaa-gfs-forecast/";

const STORE = new URL("../fixtures/explorer-store/", import.meta.url);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-range, content-length, etag",
};

// Every sharded array in the fixture has 8 inner chunks per shard: 2 lead (or
// level) blocks × 2 × 2 spatial, C order, so chunks 0–3 are block 0. Reading
// the index at the end of each chunk object (8 × (offset, nbytes) uint64 + a
// crc32c) lets a spec tell which block a range read is for.
const INDEX_BYTES = 8 * 16 + 4;
const chunkBlocks = new Map();
for (const name of readdirSync(new URL("chunks/", STORE))) {
  const body = readFileSync(new URL(`chunks/${name}`, STORE));
  if (body.length < INDEX_BYTES) continue;
  const index = body.subarray(body.length - INDEX_BYTES);
  const entries = [];
  for (let i = 0; i < 8; i += 1) {
    entries.push([Number(index.readBigUInt64LE(i * 16)), Number(index.readBigUInt64LE(i * 16 + 8))]);
  }
  if (entries.every(([offset, n]) => offset + n <= body.length - INDEX_BYTES)) {
    chunkBlocks.set(name, entries);
  }
}

/** Which lead block a range read targets, or null for anything else. */
export function blockOf(key, start) {
  const entries = chunkBlocks.get(key.replace(/^chunks\//, ""));
  const i = entries?.findIndex(([offset]) => offset === start) ?? -1;
  return i < 0 ? null : Math.floor(i / 4);
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match) return null;
  const [, from, to] = match;
  if (from === "") return [size - Number(to), size - 1];
  return [Number(from), to === "" ? size - 1 : Math.min(Number(to), size - 1)];
}

/**
 * A route handler that answers `…/*.icechunk/<key>` from the fixture, honouring
 * Range. `delayFor({ key, start, block })` returns milliseconds to hold a reply.
 * Every served read is appended to `log`.
 */
export function storeRoute({ delayFor = () => 0, log = [] } = {}) {
  return async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } });
    const key = new URL(request.url()).pathname.split(".icechunk/")[1] ?? "";
    const file = new URL(key, STORE);
    if (!key || !existsSync(file)) return route.fulfill({ status: 404, headers: CORS });
    const body = readFileSync(file);
    const range = parseRange(request.headers().range, body.length);
    const block = range ? blockOf(key, range[0]) : null;
    const ms = delayFor({ key, start: range?.[0], block });
    log.push({ key, range, block, at: Date.now() });
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
    if (!range) return route.fulfill({ status: 200, headers: CORS, body }).catch(() => {});
    const [a, b] = range;
    return route
      .fulfill({
        status: 206,
        headers: { ...CORS, "content-range": `bytes ${a}-${b}/${body.length}` },
        body: body.subarray(a, b + 1),
      })
      .catch(() => {});
  };
}

// A one-country topology far from every point the specs sample (the real file
// is world-atlas's countries-50m TopoJSON).
const BORDERS = {
  type: "Topology",
  objects: {
    countries: { type: "GeometryCollection", geometries: [{ type: "Polygon", arcs: [[0]], id: "999" }] },
    land: { type: "GeometryCollection", geometries: [{ type: "Polygon", arcs: [[0]] }] },
  },
  arcs: [[[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]],
};

/**
 * Stub the network for an offline run: nothing leaves localhost except the
 * store (served from the fixture) and the borders file. The explorer bundle is
 * wrapped so a spec can reach the mount handle as `window.__explorer` and pass
 * extra mount options through `window.__explorerOverrides`.
 */
export async function offline(page, { store = storeRoute(), overrides = {} } = {}) {
  await page.route((url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1", (route) => route.abort());
  await page.route(/\.amazonaws\.com\//, store);
  await page.route(/cdn\.jsdelivr\.net\/npm\/world-atlas/, (route) =>
    route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(BORDERS) }),
  );
  await wrapBundle(page, overrides);
}

export async function wrapBundle(page, overrides = {}) {
  await page.addInitScript((o) => {
    window.__explorerOverrides = o;
  }, overrides);
  await page.route(/\/explorer\/explorer\.js$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: `import { mount as real } from "/explorer/explorer.js?real";
export function mount(el, options) {
  window.__explorer = real(el, { ...options, ...window.__explorerOverrides });
  return window.__explorer;
}`,
    }),
  );
}

/** The fixture's variables, as the page would list them from STAC. */
const FORECAST = ["init_time", "lead_time", "latitude", "longitude"];
export const FIXTURE_VARIABLES = [
  { path: "temperature_2m", name: "temperature_2m", long_name: "2 metre temperature", units: "degree_Celsius", dims: FORECAST },
  { path: "relative_humidity_2m", name: "relative_humidity_2m", long_name: "2 metre relative humidity", units: "percent", dims: FORECAST },
  {
    path: "temperature_isobaric",
    name: "temperature_isobaric",
    long_name: "Temperature",
    units: "degree_Celsius",
    dims: ["init_time", "lead_time", "pressure_level", "latitude", "longitude"],
  },
  { path: "total_cloud_cover_atmosphere", name: "total_cloud_cover_atmosphere", long_name: "Total cloud cover", units: "percent", dims: FORECAST },
];
export const ANALYSIS_VARIABLES = [
  { path: "temperature_2m_analysis", name: "temperature_2m_analysis", long_name: "2 metre temperature (analysis)", units: "degree_Celsius", dims: ["time", "latitude", "longitude"] },
];

/** Click the load button and wait for the explorer to report a drawn frame. */
export async function loadMap(page) {
  await page.getByRole("button", { name: "Load interactive map" }).click();
  await expectState(page, "ready");
}

export async function expectState(page, state, timeout = 30_000) {
  const map = page.locator(".explore-map");
  await page.waitForFunction(
    (s) => {
      const el = document.querySelector(".explore-map");
      return el?.dataset.state === s || (s !== "error" && el?.dataset.state === "error");
    },
    state,
    { timeout },
  );
  const actual = await map.getAttribute("data-state");
  if (actual !== state) {
    const status = await map.getByRole("status").textContent().catch(() => "(no status)");
    throw new Error(`explorer state is ${actual}, not ${state}: ${status}`);
  }
}

// Turbo, the explorer's colormap, as Mikhailov's polynomial fit: within a few
// levels of the real table, far closer than the gaps between the values the
// fixture uses, so a sampled colour is classified by the nearest candidate.
export function turbo(t) {
  const x = Math.min(1, Math.max(0, t));
  const poly = (c) => c.reduceRight((acc, k) => acc * x + k, 0);
  return [
    poly([0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943]),
    poly([0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604]),
    poly([0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973]),
  ].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

export const celsius = (value) => turbo((value + 40) / 90);

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The candidate whose colour is nearest `rgb`, with the distance. */
export function nearest(rgb, candidates) {
  return candidates
    .map((value) => ({ value, distance: distance(rgb, celsius(value)) }))
    .sort((a, b) => a.distance - b.distance)[0];
}

export { distance };

/** Rendered RGB at a longitude/latitude, read from a 1×1 screenshot. */
export async function pixelAt(page, lon, lat) {
  const point = await page.evaluate(([x, y]) => {
    const canvas = document.querySelector(".explore-map canvas");
    const box = canvas.getBoundingClientRect();
    const [px, py] = window.__explorer.project([x, y]);
    return { x: box.left + px, y: box.top + py, inside: px >= 0 && py >= 0 && px < box.width && py < box.height };
  }, [lon, lat]);
  if (!point.inside) throw new Error(`${lon}, ${lat} is outside the map`);
  const png = await page.screenshot({ clip: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 }, scale: "css" });
  return decodeOnePixel(png);
}

// A 1×1 PNG's single scanline is one filter byte then the pixel, and every PNG
// filter leaves a lone pixel unchanged, so inflating IDAT is all the decoding
// needed.
function decodeOnePixel(png) {
  let offset = 8;
  let colorType;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") colorType = data[9];
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`unexpected PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}
