import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { PAGE, expectState, loadMap, offline } from "./explorer-harness.mjs";

// Marsh (2026-09-29): the legend wrapped. It sat at the end of the times row
// ("Init … · Lead … · Valid …"), which alone nearly fills the strip, so for anything
// but °C it hung on a line of its own under the times at every width, right-aligned.
// It now shares the slider's row: the slider gives up room down to a usable minimum,
// and past that the legend takes its own line from the left edge.
//
// Measured in the site's font. The page loads IBM Plex Mono from Google Fonts, which
// the offline harness blocks, and a fallback monospace is wider; so the font is served
// here from explorer/test/fixtures/fonts/ (the Latin subset, the one the strip's text
// uses; SIL OFL, see OFL.txt there).

const FONTS = new URL("../fixtures/fonts/", import.meta.url);
const FONT_CSS = [400, 700]
  .map(
    (w) =>
      `@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: ${w}; font-display: swap; ` +
      `src: url(https://fonts.gstatic.com/fixture/ibm-plex-mono-${w}-latin.woff2) format('woff2'); ` +
      `unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }`,
  )
  .join("\n");

async function siteFont(page) {
  const headers = { "access-control-allow-origin": "*" };
  await page.route(/fonts\.googleapis\.com\//, (route) => route.fulfill({ status: 200, headers, contentType: "text/css", body: FONT_CSS }));
  await page.route(/fonts\.gstatic\.com\/fixture\//, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({ status: 200, headers, contentType: "font/woff2", body: readFileSync(new URL(name, FONTS)) });
  });
}

// ---- a plain zarr store, built here, so units and value ranges can be anything ----
const LE = { name: "bytes", configuration: { endian: "little" } };
const TYPED = { float32: Float32Array, float64: Float64Array, int32: Int32Array };
function array(shape, dataType, dims, attributes, values) {
  return {
    meta: {
      zarr_format: 3,
      node_type: "array",
      shape,
      data_type: dataType,
      chunk_grid: { name: "regular", configuration: { chunk_shape: shape } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: dataType === "int32" ? 0 : "NaN",
      codecs: [LE],
      dimension_names: dims,
      attributes,
    },
    chunkKey: `c/${shape.map(() => 0).join("/")}`,
    chunk: Buffer.from(TYPED[dataType].from(values).buffer),
  };
}

const LAT = Array.from({ length: 8 }, (_, i) => 40 - i);
const LON = Array.from({ length: 16 }, (_, i) => -100 + i);
// 17 leads, +0 h to +384 h, so the times row's lead label grows as the slider moves.
const LEADS = Array.from({ length: 17 }, (_, i) => i * 24 * 3600);
const TIMES = Array.from({ length: 17 }, (_, i) => 1_790_000_000 + i * 1800);

/**
 * One variable, forecast-shaped (init, [member,] lead, lat, lon), analysis-shaped (time,
 * lat, lon) or untimed (lat, lon), with values from lo to hi (for the legend's range).
 */
function variable({ name, units, lo, hi, shape: kind = "forecast", ensemble = false }) {
  const dims = {
    forecast: ensemble ? ["init_time", "ensemble_member", "lead_time", "latitude", "longitude"] : ["init_time", "lead_time", "latitude", "longitude"],
    analysis: ["time", "latitude", "longitude"],
    untimed: ["latitude", "longitude"],
  }[kind];
  const sizes = { init_time: 1, ensemble_member: 3, lead_time: LEADS.length, time: TIMES.length, latitude: 8, longitude: 16 };
  const shape = dims.map((d) => sizes[d]);
  const n = shape.reduce((a, b) => a * b, 1);
  const values = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i % 128)) / 127);
  return { name, units, dims, array: array(shape, "float32", dims, { units, long_name: name }, values) };
}

const COORDS = {
  init_time: array([1], "float64", ["init_time"], { units: "seconds since 1970-01-01" }, [1_790_000_000]),
  lead_time: array([LEADS.length], "float64", ["lead_time"], { units: "seconds" }, LEADS),
  time: array([TIMES.length], "float64", ["time"], { units: "seconds since 1970-01-01" }, TIMES),
  ensemble_member: array([3], "int32", ["ensemble_member"], { units: "realization" }, [0, 1, 2]),
  latitude: array([8], "float64", ["latitude"], { units: "degree_north" }, LAT),
  longitude: array([16], "float64", ["longitude"], { units: "degree_east" }, LON),
};

/** Serve `vars` (and the coordinates) at https://fixture.test/store.zarr/ and open the page. */
async function openWith(page, vars, viewport) {
  await page.setViewportSize(viewport);
  const arrays = { ...COORDS, ...Object.fromEntries(vars.map((v) => [v.name, v.array])) };
  await offline(page, {
    overrides: {
      href: "https://fixture.test/store.zarr",
      variables: vars.map((v) => ({ path: v.name, name: v.name, units: v.units, dims: v.dims })),
      defaultVariable: vars[0].name,
      initialView: { bounds: [-101, 32, -84, 41] },
      maxCacheBytes: 256e6,
    },
  });
  await siteFont(page);
  await page.route(/fixture\.test\//, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/store\.zarr\//, "");
    const headers = { "access-control-allow-origin": "*" };
    const [name, ...rest] = path.split("/");
    const a = arrays[name];
    if (a && rest.join("/") === "zarr.json") {
      return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(a.meta) });
    }
    if (a && rest.join("/") === a.chunkKey) {
      return route.fulfill({ status: 200, headers, contentType: "application/octet-stream", body: a.chunk });
    }
    return route.fulfill({ status: 404, headers });
  });
  await page.goto(PAGE);
  await loadMap(page);
  expect(await page.evaluate(async () => (await document.fonts.ready, document.fonts.check('14px "IBM Plex Mono"'))), "site font loaded").toBe(true);
}

/**
 * Where the legend is, relative to the strip's content box and the slider:
 * inside, in one piece, and either on the slider's line (at its end) or on its own line
 * below it (flush left).
 */
const legendLayout = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector(".explorer-strip");
    const legend = strip.querySelector(".explorer-legend");
    const slider = strip.querySelector('input[type="range"]');
    const cs = getComputedStyle(strip);
    const s = strip.getBoundingClientRect();
    const content = { left: s.left + parseFloat(cs.paddingLeft), right: s.right - parseFloat(cs.paddingRight) };
    const l = legend.getBoundingClientRect();
    // Lines each text of the legend takes: a Range's rects, grouped by their top.
    const lines = [...legend.querySelectorAll("span")]
      .filter((e) => e.textContent)
      .map((e) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
      });
    const canvas = legend.querySelector("canvas");
    const sliderShown = slider.getClientRects().length > 0;
    const sl = sliderShown ? slider.getBoundingClientRect() : null;
    return {
      visible: l.width > 0 && l.height > 0,
      inside: l.left >= content.left - 0.5 && l.right <= content.right + 0.5,
      lines,
      canvasWidth: canvas.hidden ? null : canvas.getBoundingClientRect().width,
      sliderWidth: sl ? sl.width : null,
      // on the slider's line: their vertical extents overlap
      withSlider: sl ? l.top < sl.bottom && sl.top < l.bottom : false,
      belowSlider: sl ? l.top >= sl.bottom - 0.5 : null,
      flushRight: Math.abs(l.right - content.right) <= 1,
      flushLeft: Math.abs(l.left - content.left) <= 1,
      text: legend.textContent,
    };
  });

function expectWellPlaced(at, label) {
  expect(at.visible, `${label}: legend visible`).toBe(true);
  expect(at.inside, `${label}: legend inside the strip`).toBe(true);
  expect(at.lines, `${label}: each legend value on one line (${at.text})`).toEqual(at.lines.map(() => 1));
  if (at.canvasWidth !== null) expect(at.canvasWidth, `${label}: colour bar`).toBeGreaterThanOrEqual(39);
  if (at.sliderWidth !== null) {
    expect(at.sliderWidth, `${label}: slider stays scrubbable`).toBeGreaterThanOrEqual(119);
    if (at.withSlider) expect(at.flushRight, `${label}: on the slider's line, at its end`).toBe(true);
    else expect(at.belowSlider && at.flushLeft, `${label}: on its own line under the slider, from the left`).toBe(true);
  }
}

const CASES = [
  { key: "°C", vars: [variable({ name: "temperature_2m", units: "degree_Celsius", lo: -30, hi: 40 })] },
  { key: "precipitation", vars: [variable({ name: "precipitation_surface", units: "kg m-2 s-1", lo: 0.00001, hi: 0.0031 })] },
  { key: "ensemble precipitation", vars: [variable({ name: "precipitation_surface", units: "kg m-2 s-1", lo: 0.00001, hi: 0.0031, ensemble: true })] },
  {
    key: "ensemble, long name",
    vars: [variable({ name: "downward_short_wave_radiation_flux_surface", units: "W m-2", lo: 0, hi: 1034.5, ensemble: true })],
  },
];
// A phone through desktop, closer together around where the legend joins the slider.
const WIDTHS = [320, 360, 375, 390, 414, 480, 540, 600, 640, 660, 680, 700, 720, 768, 820, 900, 1024, 1280];
// From here up, every case fits the legend beside the slider.
const FITS_FROM = 700;

for (const c of CASES) {
  test(`legend placement across widths: ${c.key}`, async ({ page }) => {
    await openWith(page, c.vars, { width: 1280, height: 900 });
    const slider = page.getByRole("slider", { name: /lead time|time/i });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      // both ends of the lead range: the times row's label changes length between them
      const ends = [];
      for (const key of ["Home", "End"]) {
        await slider.focus();
        await slider.press(key);
        await expectState(page, "ready");
        const at = await legendLayout(page);
        expectWellPlaced(at, `${c.key} at ${width}px, ${key}`);
        ends.push(at);
      }
      expect(ends[1].withSlider, `${c.key} at ${width}px: the legend doesn't move as the lead changes`).toBe(ends[0].withSlider);
      if (width >= FITS_FROM) expect(ends[0].withSlider, `${c.key} at ${width}px: beside the slider`).toBe(true);
    }
  });
}

test("a time-only analysis keeps the legend beside its Time slider", async ({ page }) => {
  await openWith(page, [variable({ name: "precipitation_surface", units: "kg m-2 s-1", lo: 0.00001, hi: 0.0031, shape: "analysis" })], {
    width: 1280,
    height: 900,
  });
  await expect(page.getByRole("slider", { name: "Time" })).toBeVisible();
  const at = await legendLayout(page);
  expectWellPlaced(at, "analysis at 1280px");
  expect(at.withSlider).toBe(true);
});

test("a variable with no time dim keeps its legend, and the slider comes back with the next", async ({ page }) => {
  const timed = variable({ name: "temperature_2m", units: "degree_Celsius", lo: -30, hi: 40 });
  const untimed = variable({ name: "surface_height", units: "m", lo: 0, hi: 4200, shape: "untimed" });
  await openWith(page, [timed, untimed], { width: 1280, height: 900 });
  const select = page.getByRole("combobox", { name: "Variable" });

  await select.selectOption("/surface_height");
  await expectState(page, "ready");
  await expect(page.getByRole("slider")).toBeHidden();
  let at = await legendLayout(page);
  expectWellPlaced(at, "untimed");
  expect(at.text).toContain("m");

  await select.selectOption("/temperature_2m");
  await expectState(page, "ready");
  await expect(page.getByRole("slider", { name: "Lead time" })).toBeVisible();
  at = await legendLayout(page);
  expectWellPlaced(at, "timed again");
  expect(at.withSlider).toBe(true);
});
