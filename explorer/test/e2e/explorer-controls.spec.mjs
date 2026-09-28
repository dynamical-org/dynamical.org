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

const onScreen = (page, p) =>
  page.evaluate(([lon, lat]) => {
    const canvas = document.querySelector(".explore-map canvas");
    const [x, y] = window.__explorer.project([lon, lat]);
    return x > 20 && y > 20 && x < canvas.clientWidth - 20 && y < canvas.clientHeight - 20;
  }, [p.lon, p.lat]);

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

  // explorer.spec's "a slow lead the slider has left" hung now and then at its
  // Home, ArrowRight: when both moves land in one frame, the layer on screen leaves the
  // layer list and comes back before deck draws. Deck keeps it, loaded; the explorer
  // retired it anyway (textures destroyed, not counted as loaded) and never left loading.
  test("away from the drawn block and back within one frame, the field stays drawn and Ready", async ({ page }) => {
    // average_temperature_2m: one-step blocks through the whole-grid facade
    const average = [-20, -5, 10, 25, 40];
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES, defaultVariable: "average_temperature_2m" } });
    await page.goto(PAGE);
    await loadMap(page);
    const lead = await page.evaluate(() => window.__explorer.debug().step.index);
    await expect.poll(() => drawnValue(page, average)).toBe(average[lead - 1]);

    await page.evaluate((i) => {
      window.__explorer.setStep(i + 1);
      window.__explorer.setStep(i);
    }, lead);
    await expectState(page, "ready", 10_000);
    await expect.poll(() => drawnValue(page, average)).toBe(average[lead - 1]);
  });

  // Review 4, finding 1: Stop must stop. Tiles deck had queued for a request slot started
  // after Stop with a fresh controller and drew; a pan while stopped read new tiles.
  test("after Stop, queued tiles neither read nor upload, and Retry loads them", async ({ page }) => {
    const log = [];
    let hold = true;
    await offline(page, {
      store: storeRoute({ log, delayFor: ({ entry }) => (hold && entry !== null ? 2_000 : 0) }),
      // the whole grid: four tiles through one request slot, so three wait in deck's queue
      overrides: { variables: FIXTURE_VARIABLES, maxRequests: 1, initialView: { bounds: [-170, -70, 170, 70] } },
    });
    await page.goto(PAGE);
    await page.getByRole("button", { name: "Load interactive map" }).click();
    // the reference read has landed and a tile read is held behind it
    await expect.poll(() => log.filter((r) => r.entry !== null).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "Stop loading" }).click();
    const stopAt = Date.now();
    await expectState(page, "stopped");
    const textures = await page.evaluate(() => window.__explorer.debug().textures);

    // every held reply settles, and the queue would have run by now
    await page.waitForTimeout(5_000);
    await expect(page.locator(".explore-map")).toHaveAttribute("data-state", "stopped");
    expect(log.filter((r) => r.entry !== null && r.at > stopAt + 100)).toEqual([]);
    expect(await page.evaluate(() => window.__explorer.debug().textures)).toBe(textures);

    hold = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(LEAD_C[0]);
  });

  test("a pan while stopped reads nothing, and a new step resumes", async ({ page }) => {
    const log = [];
    let hold = false;
    await offline(page, {
      store: storeRoute({ log, delayFor: ({ entry }) => (hold && entry !== null ? 2_000 : 0) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);

    hold = true;
    await moveSlider(page, ["ArrowRight", "ArrowRight", "ArrowRight"]); // lead 3: a new block, held
    await page.getByRole("button", { name: "Stop loading" }).click();
    const stopAt = Date.now();
    await expectState(page, "stopped");
    // pan east until the next inner chunk along longitude is on screen
    const fresh = { lon: 22.5, lat: 42 };
    for (let i = 0; i < 8 && !(await onScreen(page, fresh)); i += 1) await dragWest(page, 300);
    expect(await onScreen(page, fresh)).toBe(true);
    await page.waitForTimeout(2_500);
    await expect(page.locator(".explore-map")).toHaveAttribute("data-state", "stopped");
    expect(log.filter((r) => r.entry !== null && r.at > stopAt + 100)).toEqual([]);

    hold = false;
    await moveSlider(page, ["ArrowLeft"]); // lead 2: a new selection resumes loading
    await expectState(page, "ready");
    await expect.poll(() => drawnValue(page, CANDIDATES, fresh)).toBe(LEAD_C[2]);
  });

  // Review 4, finding 2: a slider move while an init change loads was overwritten when
  // the held change landed, with the step it had captured.
  test("a slider move while an init loads is the step that init draws", async ({ page }) => {
    const log = [];
    let seen = null;
    await offline(page, {
      store: storeRoute({ log, delayFor: ({ key }) => (seen !== null && isShardKey(key) && !seen.has(key) ? 2_000 : 0) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);
    seen = new Set(log.map((r) => r.key));
    const [, older] = await initSelect(page).locator("option").allTextContents();

    await initSelect(page).selectOption({ label: older });
    await moveSlider(page, ["ArrowRight", "ArrowRight", "ArrowRight"]);
    await expectState(page, "ready", 20_000);
    await expect(page.locator('.explore-map [data-label="init"]')).toHaveText(older);
    await expect(page.locator('.explore-map [data-label="lead"]')).toContainText(/\b3\s*h/);
    await expect(page.getByRole("slider", { name: /lead time/i })).toHaveValue("3");
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(OLDER_INIT_C[3]);
    // no reply still in flight takes it back to lead 0
    await page.waitForTimeout(2_500);
    await expect(page.locator('.explore-map [data-label="lead"]')).toContainText(/\b3\s*h/);
    expect(await drawnValue(page, CANDIDATES)).toBe(OLDER_INIT_C[3]);
  });

  test("a slider move while an init loads is part of what Retry applies after it fails", async ({ page }) => {
    let seen = null;
    let fail = true;
    const log = [];
    const store = storeRoute({ log });
    await offline(page, {
      // the older init's reads are held, then fail
      store: async (route) => {
        const key = new URL(route.request().url()).pathname.split(".icechunk/")[1] ?? "";
        if (fail && seen !== null && route.request().method() !== "OPTIONS" && isShardKey(key) && !seen.has(key)) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return route.abort("connectionreset").catch(() => {});
        }
        return store(route);
      },
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);
    seen = new Set(log.map((r) => r.key));
    const [, older] = await initSelect(page).locator("option").allTextContents();

    await initSelect(page).selectOption({ label: older });
    await moveSlider(page, ["ArrowRight", "ArrowRight", "ArrowRight"]);
    await expectState(page, "error", 20_000);

    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expect(initSelect(page)).toHaveValue("0");
    await expect(page.locator('.explore-map [data-label="lead"]')).toContainText(/\b3\s*h/);
    await expect.poll(() => drawnValue(page, CANDIDATES)).toBe(OLDER_INIT_C[3]);
  });

  // Review 4, finding 3: Stop while startup read the variables' metadata was undone when
  // the metadata arrived. A plain zarr store reads each zarr.json over the network, so its
  // metadata read can be held (the Icechunk fixture's metadata is in its snapshot).
  test("Stop while startup reads metadata stays stopped, and Retry starts up again", async ({ page }) => {
    const requests = [];
    let hold = true;
    const meta = {
      zarr_format: 3,
      node_type: "array",
      shape: [2, 4],
      data_type: "float32",
      chunk_grid: { name: "regular", configuration: { chunk_shape: [2, 4] } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: "NaN",
      codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      dimension_names: ["latitude", "longitude"],
      attributes: {},
    };
    await offline(page, {
      overrides: {
        href: "https://fixture.test/store.zarr",
        variables: [{ path: "t", name: "t", dims: ["latitude", "longitude"] }],
        defaultVariable: "t",
      },
    });
    await page.route(/fixture\.test\//, async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push({ path, at: Date.now() });
      const headers = { "access-control-allow-origin": "*" };
      if (path === "/store.zarr/t/zarr.json") {
        if (hold) await new Promise((resolve) => setTimeout(resolve, 2_000));
        return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(meta) }).catch(() => {});
      }
      return route.fulfill({ status: 404, headers }).catch(() => {});
    });
    await page.goto(PAGE);
    await page.getByRole("button", { name: "Load interactive map" }).click();
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Stop loading" }).click();
    const stopAt = Date.now();
    await expectState(page, "stopped");

    await page.waitForTimeout(3_000); // the metadata reply lands
    await expect(page.locator(".explore-map")).toHaveAttribute("data-state", "stopped");
    expect(requests.filter((r) => r.at > stopAt + 100)).toEqual([]);
    await expect(page.getByRole("combobox", { name: "Variable" })).toBeDisabled();

    hold = false;
    await page.getByRole("button", { name: "Retry" }).click();
    // startup runs again: the variables are read and listed, and loading moves on (to
    // an error here: this store has no coordinates)
    await expect(page.getByRole("combobox", { name: "Variable" })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "Variable" })).toHaveValue("/t");
    await expectState(page, "error");
    await expect(status(page)).toContainText(/latitude/);
  });
});
