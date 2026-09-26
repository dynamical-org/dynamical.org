import { expect, test } from "@playwright/test";

import {
  ANALYSIS_VARIABLES,
  FIXTURE_VARIABLES,
  PARTIAL_ANALYSIS_VARIABLES,
  PAGE,
  celsius,
  distance,
  expectState,
  isShardKey,
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

// average_temperature_2m (one-step chunks, the whole-grid facade path): lead 0
// is NaN, then uniform per lead.
const AVERAGE_C = [null, -20, -5, 10, 25, 40];
const AVERAGE_CANDIDATES = [...AVERAGE_C.slice(1), ...AVERAGE_C.slice(1).map((v) => v + 7.5)];

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

// What a pixel shows: the fixture value whose colour it is (within 40 of it),
// or "blank" when it is no colormap colour at all (the background through an
// undrawn tile).
async function drawnValue(page, candidates, where = PLAIN) {
  const rgb = await pixelAt(page, where.lon, where.lat);
  const match = nearest(rgb, candidates);
  return match.distance < 40 ? match.value : "blank";
}

async function expectBlank(page, where) {
  const rgb = await pixelAt(page, where.lon, where.lat);
  const scale = Array.from({ length: 256 }, (_, i) => celsius(-40 + (90 * i) / 255));
  const off = Math.min(...scale.map((c) => distance(rgb, c)));
  expect(off, `pixel at ${where.lon}, ${where.lat} should be blank but drew rgb(${rgb})`).toBeGreaterThan(60);
}

/** Poll until the pixel shows `value`: a Load or Retry need not pass through a
 * state the spec could wait on first. */
async function expectDrawnSoon(page, value, candidates, where = PLAIN) {
  await expect.poll(() => drawnValue(page, candidates, where), { timeout: 20_000 }).toBe(value);
}

/** The Variable dropdown, the legend and the drawn field all say humidity:
 * the legend is in percent, and the pixel is drawn but in neither
 * temperature_isobaric level's colour (humidity's range is sampled, so its
 * exact colour isn't fixed). */
async function expectHumidityDrawn(page) {
  await expect(page.getByRole("combobox", { name: "Variable" })).toHaveValue(/relative_humidity_2m$/);
  await expect(page.locator(".explore-map")).toContainText(/percent|%/);
  await expect.poll(async () => {
    const rgb = await pixelAt(page, PLAIN.lon, PLAIN.lat);
    const scale = Array.from({ length: 256 }, (_, i) => celsius(-40 + (90 * i) / 255));
    const drawn = Math.min(...scale.map((c) => distance(rgb, c))) < 40;
    const isobaric = Math.min(distance(rgb, celsius(-30)), distance(rgb, celsius(10))) < 25;
    return drawn && !isobaric;
  }, { timeout: 20_000 }).toBe(true);
}

/** Drag the map west by `dx` CSS px (moving the view east). */
async function dragWest(page, dx) {
  const box = await page.locator(".explore-map canvas").first().boundingBox();
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2 + dx / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - dx, y, { steps: 12 });
  await page.mouse.up();
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
    await expect(page.locator(".explore figcaption")).toContainText("~9 MB (temperature_2m)");
    await page.waitForLoadState("networkidle");
    expect(bundle).toEqual([]);

    await loadMap(page);
    expect(bundle.length).toBeGreaterThan(0);
  });

  test("a virtual store's caption names the GRIB reads and what its estimate covers", async ({ page }) => {
    await offline(page);
    await page.goto("/catalog/noaa-gfs-forecast-virtual/");
    const caption = page.locator(".explore figcaption");
    await expect(caption).toContainText("latest run");
    await expect(caption).toContainText("source GRIB files");
    await expect(caption).toContainText("(store metadata plus one GRIB message): ~7 MB (temperature_2m)");
    await expect(page.getByRole("button", { name: "Load interactive map" })).toBeVisible();
  });

  test("a regional default view is named in the caption", async ({ page }) => {
    await offline(page);
    await page.goto("/catalog/noaa-mrms-conus-analysis-hourly/");
    await expect(page.locator(".explore figcaption")).toContainText(
      "Estimated weather data for the Houston-area initial view: ~9 MB (precipitation_surface)",
    );
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
    // the 16:9 box's 320px floor grows it downward, never wider than the page
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect((await page.locator(".explore-map").boundingBox()).width).toBeLessThanOrEqual(390);

    // the media query is re-checked as the window changes
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("button", { name: "Load interactive map" })).toBeVisible();
    await expect(page.locator(".explore > p")).toBeHidden();
  });
});

// Recovery after failures (review pass 1, findings 1, 2, 3 and 6): each
// breaks something after the page has loaded, then checks the explorer draws
// real data again rather than an error, a blank Ready or a stale field.
test.describe("explorer, offline recovery", () => {
  test("Retry recovers after a coordinate read fails", async ({ page }) => {
    let failing = true;
    await offline(page, {
      store: storeRoute({ failFor: ({ key }) => failing && key.startsWith("chunks/") && !isShardKey(key) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await page.getByRole("button", { name: "Load interactive map" }).click();
    await expectState(page, "error");

    failing = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expectDrawn(page, LEAD_C[0], LEAD_C);
  });

  test("changing variable or level while unloaded, then Load, draws the new selection", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);
    const unload = page.getByRole("button", { name: "Unload", exact: true });
    const load = page.getByRole("button", { name: "Load", exact: true });
    const variable = page.getByRole("combobox", { name: "Variable" });
    const isobaric = [-30, 10, ...LEAD_C];

    // Each selection below is read for the first time after Unload, so none
    // comes from a cache.
    await unload.click();
    await expectBlank(page, PLAIN);
    await variable.selectOption("temperature_isobaric");
    await expect(load).toBeEnabled();
    await load.click();
    await expectDrawnSoon(page, -30, isobaric);
    await expectState(page, "ready");

    await unload.click();
    await page.getByRole("combobox", { name: /pressure_level/i }).selectOption({ index: 1 });
    await expect(load).toBeEnabled();
    await load.click();
    await expectDrawnSoon(page, 10, isobaric);
    await expectState(page, "ready");

    await unload.click();
    await variable.selectOption("relative_humidity_2m");
    await expect(load).toBeEnabled();
    await load.click();
    await expectState(page, "ready");
    await expect(page.locator(".explore-map")).toContainText(/percent|%/);
    // its range is sampled, so check it is drawn rather than which colour
    await expect.poll(async () => {
      const rgb = await pixelAt(page, PLAIN.lon, PLAIN.lat);
      return Math.min(...Array.from({ length: 256 }, (_, i) => distance(rgb, celsius(-40 + (90 * i) / 255))));
    }, { timeout: 20_000 }).toBeLessThan(40);
  });

  test("an analysis whose last written step is a window before its end opens on that step", async ({ page }) => {
    await offline(page, {
      overrides: {
        variables: PARTIAL_ANALYSIS_VARIABLES,
        defaultVariable: "temperature_2m_analysis_partial",
        maxTextureLayers: 128,
      },
    });
    await page.goto(PAGE);
    await loadMap(page);

    // written through t = 150 (2026-09-19 06:00, 5.15 °C); t = 151…299 are NaN
    const step = (t) => -40 + (90 * t) / 299;
    await expect(page.locator('.explore-map [data-label="time"]')).toContainText(/2026-09-19.*06:00/);
    await expectDrawn(page, step(150), [step(0), step(100), step(150), step(200), step(299)]);
  });

  test("a failed pan within a block blanks only the new tiles, and Retry fills them", async ({ page }) => {
    const log = [];
    const served = new Set();
    let failNew = false;
    await offline(page, {
      store: storeRoute({
        log,
        failFor: ({ key, entry }) => failNew && entry !== null && !served.has(`${key}#${entry}`),
      }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);
    for (const r of log) if (r.entry !== null && !r.failed) served.add(`${r.key}#${r.entry}`);

    // The CONUS view sits inside one inner chunk (lon -185.625…-5.625). Pan
    // east until the next chunk along longitude is on screen.
    const kept = { lon: -11.25, lat: 42 };
    const fresh = { lon: 22.5, lat: 42 };
    failNew = true;
    const onScreen = (p) =>
      page.evaluate(([lon, lat]) => {
        const canvas = document.querySelector(".explore-map canvas");
        const [x, y] = window.__explorer.project([lon, lat]);
        return x > 20 && y > 20 && x < canvas.clientWidth - 20 && y < canvas.clientHeight - 20;
      }, [p.lon, p.lat]);
    for (let i = 0; i < 8 && !(await onScreen(fresh)); i += 1) await dragWest(page, 300);
    expect(await onScreen(fresh)).toBe(true);
    expect(await onScreen(kept)).toBe(true);

    await expectState(page, "error");
    await expect(page.locator(".explore-map").getByRole("status")).toBeVisible();
    expect(log.some((r) => r.failed)).toBe(true);
    await expectBlank(page, fresh);
    await expectDrawn(page, LEAD_C[0], LEAD_C, kept);

    failNew = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expectDrawn(page, LEAD_C[0], LEAD_C, fresh);
    await expectDrawn(page, LEAD_C[0], LEAD_C, kept);
  });

  test("a failed block change after the first frame shows no stale field, and Retry draws it", async ({ page }) => {
    let failBlock1 = false;
    await offline(page, {
      store: storeRoute({ failFor: ({ block }) => failBlock1 && block === 1 }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);

    failBlock1 = true;
    await moveSlider(page, ["ArrowRight", "ArrowRight", "ArrowRight"]);
    await expect(leadLabel(page)).toContainText(hours(3));
    await expectState(page, "error");
    await expect(page.locator(".explore-map").getByRole("status")).toBeVisible();
    await expectBlank(page, PLAIN);

    failBlock1 = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expect(leadLabel(page)).toContainText(hours(3));
    await expectDrawn(page, LEAD_C[3], LEAD_C);
  });
});

// Review pass 2: selections changed while unloaded (finding 1), a whole-grid
// forecast whose first lead is empty (finding 3), the advisory GPU estimate
// (pass 1, finding 4), and stale draws through the whole-grid facade.
test.describe("explorer, offline review pass 2", () => {
  test("a variable and then a level chosen while unloaded load together", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);
    const variable = page.getByRole("combobox", { name: "Variable" });

    await page.getByRole("button", { name: "Unload", exact: true }).click();
    await variable.selectOption("temperature_isobaric");
    // the new variable's level select must be offered before any data is read
    const level = page.getByRole("combobox", { name: /pressure_level/i });
    await level.selectOption({ index: 1 }, { timeout: 10_000 });
    await page.getByRole("button", { name: "Load", exact: true }).click();

    await expectDrawnSoon(page, 10, [-30, 10, ...LEAD_C]);
    await expectState(page, "ready");
    await expect(variable).toHaveValue(/temperature_isobaric$/);
    await expect(level).toHaveValue(await level.locator("option").nth(1).getAttribute("value"));
  });

  test("a variable chosen while unloaded is not undone by the old variable's level select or a step", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES, defaultVariable: "temperature_isobaric" } });
    await page.goto(PAGE);
    await loadMap(page);
    const variable = page.getByRole("combobox", { name: "Variable" });
    const level = page.getByRole("combobox", { name: /pressure_level/i });

    await page.getByRole("button", { name: "Unload", exact: true }).click();
    await variable.selectOption("relative_humidity_2m");
    // The reported failure: the old variable's level select, still on screen,
    // replaced the pending humidity selection with temperature. Hiding or
    // disabling it is a fix too, so change it only if it can be changed.
    if ((await level.isVisible()) && (await level.isEnabled())) await level.selectOption({ index: 1 });
    await moveSlider(page, ["ArrowRight", "ArrowRight"]);
    await page.getByRole("button", { name: "Load", exact: true }).click();

    await expectState(page, "ready");
    await expect(variable).toHaveValue(/relative_humidity_2m$/);
    await expect(leadLabel(page)).toContainText(hours(2));
    await expectHumidityDrawn(page);
  });

  test("a one-step-chunk forecast whose first lead is empty opens on the next lead", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);

    await page.getByRole("combobox", { name: "Variable" }).selectOption("average_temperature_2m");
    await expectState(page, "ready");
    await expect(leadLabel(page)).toContainText(hours(1));
    await expectDrawn(page, AVERAGE_C[1], AVERAGE_CANDIDATES);
  });

  test("a view over the GPU-memory estimate still loads, with a warning", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES, maxTextureBytes: 1000 } });
    await page.goto(PAGE);
    await loadMap(page);

    await expect(page.locator('.explore-map [data-warning="gpu"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /load anyway/i })).toHaveCount(0);
    await expectDrawn(page, LEAD_C[0], LEAD_C);
    await expectDrawn(page, KNOWN.c, [KNOWN.c, LEAD_C[0]], KNOWN);
  });

  test("through the whole-grid facade, a slow lead the slider has left never draws", async ({ page }) => {
    // Hold the first data read after the slider moves (lead 2) well past the
    // next one (lead 4). Whole-grid chunk objects are the non-shard reads left
    // once the map has drawn, since the coordinates are read by then.
    let armed = false;
    let held = 0;
    await offline(page, {
      store: storeRoute({
        delayFor: ({ key }) => {
          if (!armed || !key.startsWith("chunks/") || isShardKey(key) || held > 0) return 0;
          held += 1;
          return 2_500;
        },
      }),
      overrides: { variables: FIXTURE_VARIABLES, defaultVariable: "average_temperature_2m" },
    });
    await page.goto(PAGE);
    await loadMap(page);
    // start from lead 1 explicitly, whichever lead the variable opened on
    await moveSlider(page, ["Home", "ArrowRight"]);
    await expect(leadLabel(page)).toContainText(hours(1));
    await expectState(page, "ready");
    await expectDrawn(page, AVERAGE_C[1], AVERAGE_CANDIDATES);

    armed = true;
    await moveSlider(page, ["ArrowRight"]);
    await moveSlider(page, ["ArrowRight", "ArrowRight"]);
    await expect(leadLabel(page)).toContainText(hours(4));
    await expectState(page, "ready", 15_000);
    await expectDrawn(page, AVERAGE_C[4], AVERAGE_CANDIDATES);
    expect(held).toBe(1);

    // let the held lead-2 reply land, then check nothing repainted
    await page.waitForTimeout(3_000);
    await expect(leadLabel(page)).toContainText(hours(4));
    await expectDrawn(page, AVERAGE_C[4], AVERAGE_CANDIDATES);
  });
});

// Final review, finding 1: the loaded counterpart of pass 2's finding 1. A
// level change on the old variable's select while a new variable is still
// loading must not commit the old variable under the new one's name.
test.describe("explorer, offline final review", () => {
  test("changing the old level while a new variable loads still draws the new variable", async ({ page }) => {
    const log = [];
    let seen = null;
    let held = 0;
    await offline(page, {
      store: storeRoute({
        log,
        // once armed, hold every read of a shard object not read before: the
        // humidity shards, since the isobaric ones were all read on load
        delayFor: ({ key }) => {
          if (!seen || !isShardKey(key) || seen.has(key)) return 0;
          held += 1;
          return 2_000;
        },
      }),
      overrides: { variables: FIXTURE_VARIABLES, defaultVariable: "temperature_isobaric" },
    });
    await page.goto(PAGE);
    await loadMap(page);
    await expectDrawn(page, -30, [-30, 10, ...LEAD_C]);
    seen = new Set(log.map((r) => r.key));

    await page.getByRole("combobox", { name: "Variable" }).selectOption("relative_humidity_2m");
    await expect.poll(() => held, { timeout: 5_000 }).toBeGreaterThan(0);
    // Hiding or disabling the old select is also a fix, so change it only if
    // it can still be changed.
    const level = page.getByRole("combobox", { name: /pressure_level/i });
    if ((await level.isVisible()) && (await level.isEnabled())) await level.selectOption({ index: 1 });

    await expectState(page, "ready", 15_000);
    await expectHumidityDrawn(page);
    // after every held reply has landed, nothing has switched back
    await page.waitForTimeout(2_500);
    await expectHumidityDrawn(page);
  });
});
