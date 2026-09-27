import { statSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
  ANALYSIS_VARIABLES,
  ENSEMBLE_VARIABLES,
  FIXTURE_VARIABLES,
  PAGE,
  expectState,
  isShardKey,
  loadMap,
  nearest,
  offline,
  pixelAt,
  storeRoute,
} from "./explorer-harness.mjs";

// Offline, against the fixture store (see explorer.spec.mjs): Play, the data-received
// readout beside the status, Stop loading as a link, and the legend's plain text.

// temperature_2m at the latest init: uniform per lead. Leads 0–2 are block 0, 3–5 block 1.
const LEAD_C = [-25, -10, 5, 20, 35, 50];
const PLAIN = { lon: -78.75, lat: 30 };

const status = (page) => page.locator(".explore-map").getByRole("status");
const playButton = (page) => page.locator(".explore-map").getByRole("button", { name: /^(Play|Pause)$/ });
const bytesText = (page) => page.locator(".explore-map [data-bytes]");
const debug = (page) => page.evaluate(() => window.__explorer.debug());

/**
 * Record every ready/empty judgement with the step it was for, as the page makes them:
 * window.__frames is [{ step, state, at }].
 */
async function recordFrames(page) {
  await page.evaluate(() => {
    window.__frames = [];
    const el = document.querySelector(".explore-map");
    new MutationObserver(() => {
      const state = el.dataset.state;
      if (state === "ready" || state === "empty") {
        window.__frames.push({ step: window.__explorer.debug().step.index, state, at: performance.now() });
      }
    }).observe(el, { attributes: true, attributeFilter: ["data-state"] });
  });
}
const frames = (page) => page.evaluate(() => window.__frames);

async function moveSlider(page, keys) {
  const slider = page.getByRole("slider", { name: /lead time|time/i });
  await slider.focus();
  for (const key of keys) await slider.press(key);
}

/** The frames a play produced, one per step in order, each shown before the next asked for. */
function expectSequence(list, steps) {
  const seen = list.map((f) => f.step).filter((s, i, a) => i === 0 || a[i - 1] !== s);
  expect(seen).toEqual(steps);
}

test.describe("explorer, offline: play", () => {
  test("Play steps through the leads, one drawn frame at a time, and stops at the last", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);
    await recordFrames(page);

    await playButton(page).click();
    await expect(playButton(page)).toHaveText("Pause");
    await expect(playButton(page)).toHaveText("Play", { timeout: 20_000 });
    const list = await frames(page);
    expectSequence(list, [1, 2, 3, 4, 5]);
    // each frame is on screen for about the dwell before the next is asked for
    const firsts = [1, 2, 3, 4, 5].map((s) => list.find((f) => f.step === s).at);
    for (let i = 1; i < firsts.length; i++) expect(firsts[i] - firsts[i - 1]).toBeGreaterThan(450);
    expect((await debug(page)).step.index).toBe(5);
    const rgb = await pixelAt(page, PLAIN.lon, PLAIN.lat);
    expect(nearest(rgb, LEAD_C).value).toBe(LEAD_C[5]);
  });

  test("a step whose block is slow holds Play (Buffering…) until it draws, then Play continues", async ({ page }) => {
    let slowBlock = null;
    await offline(page, {
      store: storeRoute({ delayFor: ({ block }) => (block !== null && block === slowBlock ? 2_000 : 0) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);
    await moveSlider(page, ["ArrowRight"]); // lead 1: the next step, lead 2, is the last of block 0
    await expectState(page, "ready");
    slowBlock = 1;
    await recordFrames(page);

    await playButton(page).click();
    await expect(status(page)).toHaveText("Buffering…", { timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Stop loading" })).toBeVisible();
    await expect(playButton(page)).toHaveText("Play", { timeout: 20_000 });
    const list = await frames(page);
    expectSequence(list, [2, 3, 4, 5]);
    // lead 3 (block 1) drew only after its held reply: no step was asked for past it meanwhile
    const at2 = list.find((f) => f.step === 2).at;
    const at3 = list.find((f) => f.step === 3).at;
    expect(at3 - at2).toBeGreaterThan(1_900);
    expect(nearest(await pixelAt(page, PLAIN.lon, PLAIN.lat), LEAD_C).value).toBe(LEAD_C[5]);
  });

  test("from the last step Play starts again at the first, and an empty step is a frame it shows", async ({ page }) => {
    // average_temperature_2m (one-step chunks through the whole-grid facade): lead 0 is empty.
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES, defaultVariable: "average_temperature_2m" } });
    await page.goto(PAGE);
    await loadMap(page);
    await moveSlider(page, ["End"]);
    await expectState(page, "ready");
    await recordFrames(page);

    await playButton(page).click();
    await expect(playButton(page)).toHaveText("Play", { timeout: 20_000 });
    const list = await frames(page);
    expectSequence(list, [0, 1, 2, 3, 4, 5]);
    expect(list.find((f) => f.step === 0).state).toBe("empty");
    expect(list.find((f) => f.step === 1).state).toBe("ready");
    // the empty frame was shown for the dwell before lead 1 was asked for
    expect(list.find((f) => f.step === 1).at - list.find((f) => f.step === 0).at).toBeGreaterThan(450);
  });

  test("an analysis opens on its latest time, and Play replays it from the first", async ({ page }) => {
    await offline(page, {
      overrides: { variables: ANALYSIS_VARIABLES, defaultVariable: "temperature_2m_analysis", maxTextureLayers: 128 },
    });
    await page.goto(PAGE);
    await loadMap(page);
    const opened = (await debug(page)).step;
    expect(opened.index).toBe(opened.n - 1);
    await recordFrames(page);

    await playButton(page).click();
    await expect(page.locator('.explore-map [data-label="time"]')).toContainText("2026-09-13");
    await expect.poll(async () => (await debug(page)).step.index, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await playButton(page).click();
    await expect(playButton(page)).toHaveText("Play");
    const list = await frames(page);
    const seen = list.map((f) => f.step).filter((s, i, a) => i === 0 || a[i - 1] !== s);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen).toEqual(seen.map((_, i) => i)); // 0, 1, 2, … in order, none skipped
    const at = (await debug(page)).step.index;
    await page.waitForTimeout(1_500);
    expect((await debug(page)).step.index, "paused: no further steps").toBe(at);
  });

  test("the slider pauses Play, and a step already drawn doesn't advance after it", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);

    await playButton(page).click();
    // Right after lead 1 draws, its dwell timer is armed: a manual move must cancel it.
    await expect.poll(async () => (await debug(page)).step.index).toBe(1);
    await expectState(page, "ready");
    await moveSlider(page, ["End"]);
    await expect(playButton(page)).toHaveText("Play");
    await expectState(page, "ready");
    await page.waitForTimeout(1_500);
    expect((await debug(page)).step.index).toBe(5);
    expect((await debug(page)).playing).toBe(false);
  });

  test("Pause while a step is buffering: when it lands it is drawn, and Play goes no further", async ({ page }) => {
    let slowBlock = null;
    await offline(page, {
      store: storeRoute({ delayFor: ({ block }) => (block !== null && block === slowBlock ? 1_500 : 0) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);
    await moveSlider(page, ["ArrowRight", "ArrowRight"]); // lead 2: next is block 1
    await expectState(page, "ready");
    slowBlock = 1;

    await playButton(page).click();
    await expect(status(page)).toHaveText("Buffering…");
    await playButton(page).click(); // Pause
    await expect(playButton(page)).toHaveText("Play");
    await expectState(page, "ready", 10_000);
    await expect(status(page)).toHaveText("Ready");
    expect((await debug(page)).step.index).toBe(3);
    await page.waitForTimeout(1_500);
    expect((await debug(page)).step.index).toBe(3);
  });

  test("a variable change, Stop, or an error pauses Play; Retry doesn't restart it", async ({ page }) => {
    let failBlock = null;
    await offline(page, {
      store: storeRoute({
        delayFor: ({ block }) => (block === 1 && failBlock === "slow" ? 3_000 : 0),
        failFor: ({ block }) => block === 1 && failBlock === "fail",
      }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);

    // a variable change
    await playButton(page).click();
    await page.getByRole("combobox", { name: "Variable" }).selectOption("relative_humidity_2m");
    await expect(playButton(page)).toHaveText("Play");
    await expectState(page, "ready");
    await page.getByRole("combobox", { name: "Variable" }).selectOption("temperature_2m");
    await expectState(page, "ready");

    // Stop while buffering
    await moveSlider(page, ["Home", "ArrowRight", "ArrowRight"]);
    await expectState(page, "ready");
    failBlock = "slow";
    await playButton(page).click();
    await expect(status(page)).toHaveText("Buffering…");
    await page.getByRole("button", { name: "Stop loading" }).click();
    await expectState(page, "stopped");
    await expect(playButton(page)).toHaveText("Play");

    failBlock = null;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");

    // an error while playing, then Retry
    await moveSlider(page, ["Home", "ArrowRight", "ArrowRight"]);
    await expectState(page, "ready");
    failBlock = "fail";
    await playButton(page).click();
    await expectState(page, "error");
    await expect(playButton(page)).toHaveText("Play");
    failBlock = null;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    const at = (await debug(page)).step.index;
    await page.waitForTimeout(1_500);
    expect((await debug(page)).step.index).toBe(at);
    expect((await debug(page)).playing).toBe(false);
  });

  test("the handle's step move pauses Play like the slider does", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);
    await playButton(page).click();
    expect((await debug(page)).playing).toBe(true);
    await page.evaluate(() => window.__explorer.setStep(0));
    expect((await debug(page)).playing).toBe(false);
    await expect(playButton(page)).toHaveText("Play");
  });
});

test.describe("explorer, offline: data received, Stop link, legend", () => {
  test("the data received counts the store's response bytes and adds nothing for a cached step", async ({ page }) => {
    const log = [];
    await offline(page, { store: storeRoute({ log }), overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);

    const STORE = new URL("../fixtures/explorer-store/", import.meta.url);
    const served = () => log.reduce((n, r) => n + (r.range ? r.range[1] - r.range[0] + 1 : statSync(new URL(r.key, STORE)).size), 0);
    await expect.poll(async () => (await debug(page)).bytes).toBeGreaterThan(0);
    // what the store served (whole objects and ranges) is what was received
    await expect.poll(async () => (await debug(page)).bytes).toBe(served());
    const first = (await debug(page)).bytes;
    await expect(bytesText(page)).toHaveText(`· ${(first / 1e6).toFixed(2)} MB received`);
    // outside the live region, beside it
    await expect(status(page)).not.toContainText("MB");

    // a new block reads more, and the total grows
    await moveSlider(page, ["End"]);
    await expectState(page, "ready");
    await expect.poll(async () => (await debug(page)).bytes).toBeGreaterThan(first);
    await expect.poll(async () => (await debug(page)).bytes).toBe(served());

    // a step inside the drawn block reads nothing and adds nothing
    const before = (await debug(page)).bytes;
    const reads = log.length;
    await moveSlider(page, ["ArrowLeft"]);
    await expectState(page, "ready");
    await page.waitForTimeout(400);
    expect(log.length).toBe(reads);
    expect((await debug(page)).bytes).toBe(before);
  });

  test("through the whole-grid facade, a lead read again from its cache adds nothing", async ({ page }) => {
    const log = [];
    await offline(page, { store: storeRoute({ log }), overrides: { variables: FIXTURE_VARIABLES, defaultVariable: "average_temperature_2m" } });
    await page.goto(PAGE);
    await loadMap(page);
    await moveSlider(page, ["Home", "ArrowRight"]);
    await expectState(page, "ready");
    await moveSlider(page, ["ArrowRight"]);
    await expectState(page, "ready");
    const before = (await debug(page)).bytes;
    const reads = log.filter((r) => r.key.startsWith("chunks/") && !isShardKey(r.key)).length;
    await moveSlider(page, ["ArrowLeft"]); // back to lead 1: a new layer, but the decoded grid is cached
    await expectState(page, "ready");
    await page.waitForTimeout(400);
    expect(log.filter((r) => r.key.startsWith("chunks/") && !isShardKey(r.key)).length).toBe(reads);
    expect((await debug(page)).bytes).toBe(before);
  });

  test("Stop loading is a link-styled button beside the status, only while loading; the total survives Stop and Retry", async ({ page }) => {
    let slow = false;
    await offline(page, {
      store: storeRoute({ delayFor: ({ block }) => (slow && block === 1 ? 3_000 : 0) }),
      overrides: { variables: FIXTURE_VARIABLES },
    });
    await page.goto(PAGE);
    await loadMap(page);
    const stop = page.getByRole("button", { name: "Stop loading" });
    await expect(stop).toBeHidden();

    slow = true;
    await moveSlider(page, ["End"]);
    await expect(stop).toBeVisible();
    // in the status row, and drawn as a link: no box, link colour, underlined
    const look = await stop.evaluate((b) => {
      const cs = getComputedStyle(b);
      const row = b.parentElement;
      return {
        sameRow: row.contains(row.querySelector('[role="status"]')),
        border: cs.borderStyle,
        background: cs.backgroundColor,
        underline: cs.textDecorationLine,
        linkColour: cs.color === getComputedStyle(document.createElement("a")).color || cs.color !== getComputedStyle(row).color,
        height: b.getBoundingClientRect().height,
      };
    });
    expect(look.sameRow).toBe(true);
    expect(look.border).toBe("none");
    expect(look.background).toBe("rgba(0, 0, 0, 0)");
    expect(look.underline).toBe("underline");
    expect(look.linkColour).toBe(true);
    expect(look.height).toBeGreaterThanOrEqual(20);
    await stop.focus();
    expect(await stop.evaluate((b) => getComputedStyle(b).outlineStyle)).toBe("solid");

    const before = (await debug(page)).bytes;
    await stop.click();
    await expectState(page, "stopped");
    await expect(stop).toBeHidden();
    expect((await debug(page)).bytes).toBeGreaterThanOrEqual(before);
    slow = false;
    const stopped = (await debug(page)).bytes;
    await page.getByRole("button", { name: "Retry" }).click();
    await expectState(page, "ready");
    await expect.poll(async () => (await debug(page)).bytes).toBeGreaterThan(stopped);
    await expect(bytesText(page)).toContainText("MB received");
  });

  test("the legend reads low value, colour bar, high value and units", async ({ page }) => {
    await offline(page, { overrides: { variables: FIXTURE_VARIABLES } });
    await page.goto(PAGE);
    await loadMap(page);
    const legend = page.locator(".explore-map .explorer-legend");
    const low = legend.locator("span").nth(0);
    const high = legend.locator("span").nth(1);
    // temperature: the fixed Celsius range
    await expect(low).toHaveText("-40");
    await expect(legend.locator("canvas")).toBeVisible();
    await expect(high).toHaveText("50 °C");
    // humidity: sampled, in %, with no sample or percentile wording
    await page.getByRole("combobox", { name: "Variable" }).selectOption("relative_humidity_2m");
    await expectState(page, "ready");
    await expect(low).toHaveText(/^-?[\d.]+$/);
    await expect(high).toHaveText(/^-?[\d.]+ %$/);
    expect(await low.textContent()).not.toBe((await high.textContent()).replace(" %", ""));
    await expect(page.locator(".explore-map")).not.toContainText(/sample|percent|fixed range|98%/);
  });
});

test.describe("explorer, offline: layout", () => {
  test("at 390 px, with a long variable name and every select, no strip control runs past the map box", async ({ page }) => {
    // A name as long as a real product's longest path, so the Variable select's natural width
    // is far wider than a phone.
    const long = { ...FIXTURE_VARIABLES[0], name: "temperature_2m_mean_over_the_previous_six_hours_above_ground_level" };
    await offline(page, {
      overrides: { variables: [long, ...FIXTURE_VARIABLES.slice(1), ...ENSEMBLE_VARIABLES], defaultVariable: "temperature_ensemble" },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE);
    await loadMap(page);

    const overflow = () =>
      page.evaluate(() => {
        const box = document.querySelector(".explore-map").getBoundingClientRect();
        const out = [];
        for (const node of document.querySelectorAll(".explore-map .explorer-strip *")) {
          const r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // hidden
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5) {
            out.push(`${node.tagName.toLowerCase()} "${(node.ariaLabel ?? node.textContent).slice(0, 30)}" ${Math.round(r.left)}–${Math.round(r.right)} (box ${Math.round(box.left)}–${Math.round(box.right)})`);
          }
        }
        return out;
      });
    const variable = page.getByRole("combobox", { name: "Variable" });

    // the ensemble: Init time and member selects
    expect(await overflow()).toEqual([]);
    // the long name, selected
    await variable.selectOption({ label: long.name });
    await expectState(page, "ready");
    expect(await overflow()).toEqual([]);
    // a level select
    await variable.selectOption("temperature_isobaric");
    await expectState(page, "ready");
    expect(await overflow()).toEqual([]);
    // the long name is still usable: the select's value and option text are whole
    await variable.selectOption({ label: long.name });
    await expectState(page, "ready");
    await expect(variable.locator("option:checked")).toHaveText(long.name);
    // and the map keeps a usable height above the strip
    expect((await page.locator(".explore-map .explorer-map").boundingBox()).height).toBeGreaterThanOrEqual(200);
  });
});
