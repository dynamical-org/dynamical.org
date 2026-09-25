import { expect, test } from "@playwright/test";

import {
  ANALYSIS_VARIABLES,
  FIXTURE_VARIABLES,
  PAGE,
  celsius,
  distance,
  expectState,
  loadMap,
  nearest,
  offline,
  pixelAt,
  storeRoute,
} from "./explorer-harness.mjs";

// The Explore section on a catalog page lazy-loads the map explorer (explorer/)
// and reads an Icechunk store straight from S3. Offline, every request is
// stubbed: S3 from test/fixtures/explorer-store/ (a tiny GFS-shaped repo, see
// test/fixtures/make-explorer-store.py for its values) and the borders from a
// one-country topology. What only a browser can show, and so what this checks:
// the bundle stays unloaded until asked for, cells land where their coordinates
// say, a lead or time step draws that step's data, a slow reply never paints an
// older block under newer labels, and failures read as failures.
//
// Colours are read back from the page and matched to the nearest fixture value
// on the turbo scale, so a check names the value that drew rather than a hex.

// temperature_2m at the latest init: uniform per lead, one cold cell.
const LEAD_C = [-25, -10, 5, 20, 35, 50];
const OLDER_INIT_C = LEAD_C.map((v) => v + 7.5);
const KNOWN = { lon: -101.25, lat: 42, c: -40 };
// Away from the known cell and the stub border, inside the CONUS view.
const PLAIN = { lon: -78.75, lat: 30 };

async function expectDrawn(page, value, candidates, where = PLAIN) {
  const rgb = await pixelAt(page, where.lon, where.lat);
  const match = nearest(rgb, candidates);
  expect(match.value, `pixel at ${where.lon}, ${where.lat} is rgb(${rgb}) — nearest ${match.value}`).toBe(value);
  expect(match.distance).toBeLessThan(40);
}

const leadLabel = (page) => page.locator('.explore-map [data-label="lead"]');
const hours = (n) => new RegExp(`\\b${n}\\s*h`);
const validLabel = (page) => page.locator('.explore-map [data-label="valid"]');

async function moveSlider(page, keys) {
  const slider = page.getByRole("slider", { name: /lead time|time/i });
  await slider.focus();
  for (const key of keys) await slider.press(key);
}

test.describe("explorer, offline", () => {
  test("the explorer bundle is not requested until the button is clicked", async ({ page }) => {
    const bundle = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/explorer/")) bundle.push(request.url());
    });
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await expect(page.locator(".explore img")).toBeVisible();
    await expect(page.locator(".explore figcaption")).toContainText("~7 MB (temperature_2m)");
    await page.waitForLoadState("networkidle");
    expect(bundle).toEqual([]);

    await loadMap(page);
    expect(bundle.length).toBeGreaterThan(0);
  });

  test("cells register on their coordinates and the latest init is drawn", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);

    await expect(page.locator('.explore-map [data-label="init"]')).toContainText(/2026-09-25.*12:00/);
    await expectDrawn(page, LEAD_C[0], [...LEAD_C, ...OLDER_INIT_C]);

    // The cold cell spans 36–48° N and 106.875–95.625° W. Points 35% of a cell
    // from its centre are inside it; 65% out are in the neighbours. A field
    // shifted by half a cell (edge rather than centre registration) fails one
    // side of each pair.
    const inside = [
      [KNOWN.lon, KNOWN.lat],
      [KNOWN.lon - 3.94, KNOWN.lat],
      [KNOWN.lon + 3.94, KNOWN.lat],
      [KNOWN.lon, KNOWN.lat - 4.2],
      [KNOWN.lon, KNOWN.lat + 4.2],
    ];
    const outside = [
      [KNOWN.lon - 7.31, KNOWN.lat],
      [KNOWN.lon + 7.31, KNOWN.lat],
      [KNOWN.lon, KNOWN.lat - 7.8],
      [KNOWN.lon, KNOWN.lat + 7.8],
    ];
    for (const [lon, lat] of inside) await expectDrawn(page, KNOWN.c, [KNOWN.c, LEAD_C[0]], { lon, lat });
    for (const [lon, lat] of outside) await expectDrawn(page, LEAD_C[0], [KNOWN.c, LEAD_C[0]], { lon, lat });
  });

  test("the lead slider crosses a block boundary and draws that lead", async ({ page }) => {
    const log = [];
    await offline(page, { store: storeRoute({ log }), overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);

    await moveSlider(page, ["ArrowRight", "ArrowRight"]);
    await expect(leadLabel(page)).toContainText(hours(2));
    await expectDrawn(page, LEAD_C[2], LEAD_C);
    expect(log.some((r) => r.block === 1)).toBe(false);

    await moveSlider(page, ["ArrowRight"]);
    await expect(leadLabel(page)).toContainText(hours(3));
    await expect(validLabel(page)).toContainText("15:00");
    await expectState(page, "ready");
    await expectDrawn(page, LEAD_C[3], LEAD_C);
    expect(log.some((r) => r.block === 1)).toBe(true);
  });

  for (const scenario of [
    {
      name: "a slow block the slider has already left never draws",
      slow: 1,
      keys: [["End"], ["Home", "ArrowRight"]],
      lead: 1,
    },
    {
      name: "a slow older block never draws under a newer lead",
      slow: 0,
      keys: [["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"], ["Home", "ArrowRight", "ArrowRight"], ["End"]],
      lead: 5,
    },
  ]) {
    test(`rapid slider moves: ${scenario.name}`, async ({ page }) => {
      let slowBlock = null;
      await offline(page, {
        store: storeRoute({ delayFor: ({ block }) => (block !== null && block === slowBlock ? 2_000 : 0) }),
        overrides: { variables: FIXTURE_VARIABLES },
      });
      await page.goto(PAGE);
      await loadMap(page);
      slowBlock = scenario.slow;

      for (const keys of scenario.keys) await moveSlider(page, keys);
      await expect(leadLabel(page)).toContainText(hours(scenario.lead));
      await expectState(page, "ready", 15_000);
      await expectDrawn(page, LEAD_C[scenario.lead], LEAD_C);

      // let every held reply land, then check nothing repainted under the labels
      await page.waitForTimeout(2_500);
      await expect(leadLabel(page)).toContainText(hours(scenario.lead));
      await expectDrawn(page, LEAD_C[scenario.lead], LEAD_C);
    });
  }

  test("switching variable and pressure level redraws with the new data", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);

    const variable = page.getByRole("combobox", { name: "Variable" });
    await variable.selectOption("relative_humidity_2m");
    await expectState(page, "ready");
    await expect(page.locator(".explore-map")).toContainText(/percent|%/);

    await variable.selectOption("temperature_isobaric");
    await expectState(page, "ready");
    const level = page.getByRole("combobox", { name: /pressure_level/i });
    await expect(level).toBeVisible();
    await expectDrawn(page, -30, [-30, 10, ...LEAD_C]);
    await level.selectOption({ index: 1 });
    await expectState(page, "ready");
    await expectDrawn(page, 10, [-30, 10, ...LEAD_C]);
  });

  test("an integer field's fill_value sentinel is left undrawn", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES, defaultVariable: "total_cloud_cover_atmosphere" } });
    await page.goto(PAGE);
    await loadMap(page);

    const hole = await pixelAt(page, KNOWN.lon, KNOWN.lat);
    const filled = await pixelAt(page, KNOWN.lon + 11.25, KNOWN.lat);
    // The filled neighbour is drawn in the colormap; the -1 cell shows the map
    // background through it, which is far from every turbo colour.
    const nearestTurbo = Math.min(...Array.from({ length: 256 }, (_, i) => distance(hole, celsius(-40 + (90 * i) / 255))));
    expect(nearestTurbo, `fill cell drew rgb(${hole})`).toBeGreaterThan(60);
    expect(distance(hole, filled)).toBeGreaterThan(60);
  });

  test("an analysis longer than the texture window scrubs its whole time range", async ({ page }) => {
    await offline(page, {
      overrides: { variables: ANALYSIS_VARIABLES, defaultVariable: "temperature_2m_analysis", maxTextureLayers: 128 },
    });
    await page.goto(PAGE);
    await loadMap(page);

    // step t is -40 + 90 t / 299 °C; the latest (t = 299) is 50 °C
    const step = (t) => -40 + (90 * t) / 299;
    const candidates = [step(0), step(100), step(170), step(299)];
    await expectDrawn(page, step(299), candidates);
    await expect(page.locator('.explore-map [data-label="time"]')).toContainText("2026-09-25");

    await moveSlider(page, ["Home"]);
    await expectState(page, "ready");
    await expect(page.locator('.explore-map [data-label="time"]')).toContainText("2026-09-13");
    await expectDrawn(page, step(0), candidates);
  });

  test("with S3 unreachable the explorer says so", async ({ page }) => {
    await offline(page, { store: (route) => route.abort("connectionrefused"), overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await page.getByRole("button", { name: "Load interactive map" }).click();
    await expectState(page, "error");
    const status = page.locator(".explore-map").getByRole("status");
    await expect(status).toBeVisible();
    await expect(status).toHaveText(/\w{4,}.*\w{4,}/);
    await expect(status).not.toContainText(/undefined|\[object/);
  });

  test("small screens get the preview and a note instead of the button", async ({ page }) => {
    await offline(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE);
    await expect(page.locator(".explore img")).toBeVisible();
    await expect(page.getByRole("button", { name: "Load interactive map" })).toBeHidden();
    await expect(page.locator(".explore > p")).toHaveText(/isn't enabled on small screens or touch-only devices/);

    // the media query is re-checked as the window changes
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("button", { name: "Load interactive map" })).toBeVisible();
    await expect(page.locator(".explore > p")).toBeHidden();
  });
});
