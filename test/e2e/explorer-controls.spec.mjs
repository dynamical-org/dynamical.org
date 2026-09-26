import { expect, test } from "@playwright/test";

import {
  FIXTURE_VARIABLES,
  PAGE,
  PARTIAL_ANALYSIS_VARIABLES,
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

// Offline, against the fixture store (see explorer.spec.mjs): a step whose data is
// missing reads as missing, not "Ready" (Marsh's staging report that GEFS failed at
// the 6-hourly steps), the Init time select, and Stop loading.

// temperature_2m: uniform per (init, lead); the older init is 7.5 °C warmer.
const LEAD_C = [-25, -10, 5, 20, 35, 50];
const OLDER_INIT_C = LEAD_C.map((v) => v + 7.5);
const CANDIDATES = [...LEAD_C, ...OLDER_INIT_C];
const PLAIN = { lon: -78.75, lat: 30 };

const status = (page) => page.locator(".explore-map").getByRole("status");
const initSelect = (page) => page.getByRole("combobox", { name: "Init time", exact: true });

async function drawnValue(page, candidates, where = PLAIN) {
  const rgb = await pixelAt(page, where.lon, where.lat);
  const match = nearest(rgb, candidates);
  return match.distance < 40 ? match.value : "blank";
}

async function expectBlank(page, where = PLAIN) {
  const rgb = await pixelAt(page, where.lon, where.lat);
  const scale = Array.from({ length: 256 }, (_, i) => celsius(-40 + (90 * i) / 255));
  const off = Math.min(...scale.map((c) => distance(rgb, c)));
  expect(off, `pixel at ${where.lon}, ${where.lat} should be blank but drew rgb(${rgb})`).toBeGreaterThan(60);
}

async function moveSlider(page, keys) {
  const slider = page.getByRole("slider", { name: /lead time|time/i });
  await slider.focus();
  for (const key of keys) await slider.press(key);
}

test.describe("explorer, offline: missing data, init time, stop", () => {
  // GEFS 35-day's newest run was the default (its lead-0 chunk is written) but held
  // values only through +384 h: its later lead chunks exist and are all NaN. The map
  // was blank there and still said "Ready". The partial analysis is the same shape: a
  // written chunk whose steps after 150 are NaN.
  test("a step inside a written chunk with no values reads as no data, not Ready", async ({ page }) => {
    await offline(page, {
      overrides: { variables: PARTIAL_ANALYSIS_VARIABLES, defaultVariable: "temperature_2m_analysis_partial", maxTextureLayers: 128 },
    });
    await page.goto(PAGE);
    await loadMap(page);
    await expect(page.locator('.explore-map [data-label="time"]')).toContainText(/2026-09-19.*06:00/);

    await moveSlider(page, ["ArrowRight"]);
    await expectState(page, "empty");
    await expect(status(page)).toContainText(/No data for temperature_2m_analysis_partial, time 2026-09-19 07:00/);
    await expect(status(page)).toContainText(/Values in view end at time 2026-09-19 06:00/);
    await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
    await expectBlank(page);

    // back onto a written step: drawn and Ready again
    await moveSlider(page, ["ArrowLeft"]);
    await expectState(page, "ready");
  });

  test("through the whole-grid facade, an empty lead reads as no data", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);
    await page.getByRole("combobox", { name: "Variable" }).selectOption("average_temperature_2m");
    await expectState(page, "ready");

    // lead 0 of a time mean is all NaN
    await moveSlider(page, ["ArrowLeft"]);
    await expectState(page, "empty");
    await expect(status(page)).toContainText(/No data for average_temperature_2m, init .*, lead \+0 h/);
  });

  test("an older init time draws the same lead of that run", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);
    const init = initSelect(page);
    // newest first, the latest usable run selected
    await expect(init.locator("option")).toHaveText(["2026-09-25 12:00 UTC", "2026-09-25 06:00 UTC"]);
    const [latest, older] = await init.locator("option").allTextContents();
    await expect(init).toHaveValue("1");

    await moveSlider(page, ["ArrowRight", "ArrowRight", "ArrowRight"]); // lead 3, the second block
    await expectState(page, "ready");
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(LEAD_C[3]);

    await init.selectOption({ label: older });
    await expectState(page, "ready");
    await expect(page.locator('.explore-map [data-label="init"]')).toHaveText(older);
    await expect(page.locator('.explore-map [data-label="lead"]')).toContainText(/\b3\s*h/);
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(OLDER_INIT_C[3]);
    const debug = await page.evaluate(() => window.__explorer.debug());
    expect(debug.init.index).toBe(0);
    expect(debug.layers.every((id) => id.includes("|i0|"))).toBe(true);

    // a variable switch keeps the chosen run
    await page.getByRole("combobox", { name: "Variable" }).selectOption("temperature_isobaric");
    await expectState(page, "ready");
    await expect(page.locator('.explore-map [data-label="init"]')).toHaveText(older);
    await expect(initSelect(page)).toHaveValue("0");
    expect(latest).not.toBe(older);
  });

  test("an init whose read fails is an error, keeps the drawn run, and Retry loads that init", async ({ page }) => {
    const log = [];
    let seen = null;
    let fail = true;
    await offline(page, {
      store: storeRoute({ log, failFor: ({ key }) => fail && seen !== null && isShardKey(key) && !seen.has(key) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);
    seen = new Set(log.map((r) => r.key));
    const [, older] = await initSelect(page).locator("option").allTextContents();

    await initSelect(page).selectOption({ label: older });
    await expectState(page, "error");
    await expect(status(page)).toContainText(/Still showing the previous selection/);
    // everything describes what is drawn: the latest run
    await expect(initSelect(page)).toHaveValue("1");
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(LEAD_C[0]);

    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expect(initSelect(page)).toHaveValue("0");
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(OLDER_INIT_C[0]);
  });

  test("Stop loading aborts a change in flight, keeps the drawn field, and Retry resumes it", async ({ page }) => {
    const log = [];
    let seen = null;
    await offline(page, {
      store: storeRoute({ log, delayFor: ({ key }) => (seen !== null && isShardKey(key) && !seen.has(key) ? 3_000 : 0) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    const stop = page.getByRole("button", { name: "Stop loading" });
    await page.getByRole("button", { name: "Load interactive map" }).click();
    await expectState(page, "ready");
    await expect(stop).toBeHidden();
    seen = new Set(log.map((r) => r.key));
    const [, older] = await initSelect(page).locator("option").allTextContents();

    await initSelect(page).selectOption({ label: older });
    await expect(stop).toBeVisible();
    await stop.click();
    await expectState(page, "stopped");
    await expect(stop).toBeHidden();
    await expect(initSelect(page)).toHaveValue("1");
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(LEAD_C[0]);
    // the held reply lands after Stop: nothing changes
    await page.waitForTimeout(3_500);
    await expect(page.locator(".explore-map")).toHaveAttribute("data-state", "stopped");
    expect(await drawnValue(page, CANDIDATES)).toBe(LEAD_C[0]);

    seen = null;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expect(initSelect(page)).toHaveValue("0");
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(OLDER_INIT_C[0]);
  });
});
