import { expect, test } from "@playwright/test";

import {
  FIXTURE_VARIABLES,
  PAGE,
  PARTIAL_ANALYSIS_VARIABLES,
  expectState,
  loadMap,
  offline,
  storeRoute,
} from "./explorer-harness.mjs";

// Marsh (2026-09-28): the explorer's height jumped a few pixels when the status went from
// Ready to Buffering. Stop loading and Retry are taller than a line of text, and long
// messages (errors, No data, the GPU warning) wrapped onto more lines, so the status row,
// the strip's last, changed height and moved everything below the explorer. The row now
// holds one height in every state; these measure it and the whole widget.

// temperature_2m at the latest init: leads 0–2 are block 0, 3–5 block 1.
const status = (page) => page.locator(".explore-map").getByRole("status");
const playButton = (page) => page.locator(".explore-map").getByRole("button", { name: /^(Play|Pause)$/ });

/**
 * The status row's height and the whole widget's, in CSS px, and the visible children that
 * stick out of the row (a fixed height must not come from clipping them).
 */
const heights = (page) =>
  page.evaluate(() => {
    const map = document.querySelector(".explore-map");
    const row = map.querySelector('[role="status"]').parentElement;
    const r = row.getBoundingClientRect();
    const outside = [...row.children]
      .filter((c) => !c.hidden && c.getBoundingClientRect().width > 0)
      .filter((c) => {
        const b = c.getBoundingClientRect();
        return b.top < r.top - 0.5 || b.bottom > r.bottom + 0.5 || b.left < r.left - 0.5 || b.right > r.right + 0.5;
      })
      .map((c) => c.textContent);
    return { row: r.height, widget: map.getBoundingClientRect().height, outside };
  });

const warning = (page) => page.locator('.explore-map [data-warning="gpu"]');
const details = (page) => page.locator(".explore-map").getByRole("button", { name: "Details" });

/** The status and the GPU warning texts that are cut short in the row. */
const cutTexts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.explore-map [role="status"], .explore-map [data-warning="gpu"]')]
      .filter((e) => !e.hidden && e.scrollWidth > e.clientWidth)
      .map((e) => e.textContent),
  );

/** When the status or the warning is cut short, Details shows and opens the whole of each. */
async function expectWhole(page) {
  const cut = await cutTexts(page);
  if (!cut.length) return expect(details(page)).toBeHidden();
  await details(page).click();
  await expect(page.locator(".explorer-details")).toBeVisible();
  for (const text of cut) await expect(page.locator(".explorer-details")).toContainText(text);
  await page.keyboard.press("Escape");
  await expect(page.locator(".explorer-details")).toBeHidden();
}

async function moveSlider(page, keys) {
  const slider = page.getByRole("slider", { name: /lead time|time/i });
  await slider.focus();
  for (const key of keys) await slider.press(key);
}

for (const [device, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test.describe(`explorer, offline: status height (${device})`, () => {
    test.use({ viewport });

    test("the status row and the widget keep one height through loading, Stop, Buffering and an error", async ({ page }) => {
      let slowBlock = null;
      let failBlock = null;
      await offline(page, {
        store: storeRoute({
          delayFor: ({ block }) => (block !== null && block === slowBlock ? 4_000 : 0),
          failFor: ({ block }) => block !== null && block === failBlock,
        }),
        // Re-reading block 1 must go to the network each time, not the byte cache.
        overrides: { variables: FIXTURE_VARIABLES, maxCacheBytes: 0 },
      });
      await page.goto(PAGE);
      await loadMap(page);
      await expect(status(page)).toHaveText("Ready");
      const ready = await heights(page);
      const seen = [];
      const record = async (label) => seen.push({ label, ...(await heights(page)) });

      // loading, with Stop loading beside the status
      slowBlock = 1;
      await moveSlider(page, ["End"]);
      await expectState(page, "loading");
      await expect(page.getByRole("button", { name: "Stop loading" })).toBeVisible();
      await record("loading");

      // stopped, with Retry
      await page.getByRole("button", { name: "Stop loading" }).click();
      await expectState(page, "stopped");
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await record("stopped");
      slowBlock = null;
      await page.getByRole("button", { name: "Retry" }).click();
      await expectState(page, "ready");
      await record("ready again");

      // Buffering: Play from the last step of block 0 into the slow block 1
      await moveSlider(page, ["Home", "ArrowRight", "ArrowRight"]);
      await expectState(page, "ready");
      slowBlock = 1;
      await playButton(page).click();
      await expect(status(page)).toHaveText("Buffering…");
      await record("buffering");
      await playButton(page).click();
      slowBlock = null;
      await expectState(page, "ready");

      // an error, with Retry and a long message
      await moveSlider(page, ["Home"]);
      await expectState(page, "ready");
      failBlock = 1;
      await moveSlider(page, ["End"]);
      await expectState(page, "error");
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await record("error");

      await expectWhole(page);

      for (const h of seen) {
        expect(h.outside, `children outside the row, ${h.label}`).toEqual([]);
        expect(h.row, `status row, ${h.label}`).toBeCloseTo(ready.row, 1);
        expect(h.widget, `widget, ${h.label}`).toBeCloseTo(ready.widget, 1);
      }
    });

    test("no data and the GPU warning keep the same status height as Ready", async ({ browser }) => {
      const measure = async (overrides, reach) => {
        const page = await browser.newPage({ viewport });
        await offline(page, { overrides });
        await page.goto(PAGE);
        await loadMap(page);
        await reach(page);
        const h = await heights(page);
        await page.close();
        return h;
      };
      const ready = await measure({ variables: FIXTURE_VARIABLES }, async (page) => {
        await expect(status(page)).toHaveText("Ready");
      });
      // No data: a step inside a written chunk that holds only NaN (a long message)
      const empty = await measure(
        { variables: PARTIAL_ANALYSIS_VARIABLES, defaultVariable: "temperature_2m_analysis_partial", maxTextureLayers: 128 },
        async (page) => {
          await moveSlider(page, ["ArrowRight"]);
          await expectState(page, "empty");
          await expect(status(page)).toContainText(/No data for/);
          await expectWhole(page);
        },
      );
      // The GPU-memory warning: a long sentence beside the status
      const warned = await measure({ variables: FIXTURE_VARIABLES, maxTextureBytes: 1000 }, async (page) => {
        await expect(warning(page)).toBeAttached();
        await expect(warning(page)).not.toHaveAttribute("hidden");
        // the warning takes only the room the status leaves
        await expect(status(page)).toHaveText("Ready");
        expect(await status(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
        // the warning's long sentence is cut short, and Details opens it whole
        expect(await cutTexts(page)).toContain(await warning(page).textContent());
        await expectWhole(page);
      });
      expect([...empty.outside, ...warned.outside], "children outside the row").toEqual([]);
      expect(empty.row, "status row, no data").toBeCloseTo(ready.row, 1);
      expect(warned.row, "status row, GPU warning").toBeCloseTo(ready.row, 1);
      // The same fixture and controls, so the whole widget matches too (No data's fixture
      // has other controls, so only its row is compared).
      expect(warned.widget, "widget, GPU warning").toBeCloseTo(ready.widget, 1);
    });

    test("a focused Details keeps focus as the row refits", async ({ page }) => {
      await offline(page, {
        overrides: { variables: PARTIAL_ANALYSIS_VARIABLES, defaultVariable: "temperature_2m_analysis_partial", maxTextureLayers: 128 },
      });
      await page.goto(PAGE);
      await loadMap(page);
      await moveSlider(page, ["ArrowRight"]);
      await expectState(page, "empty");
      // make sure the long No data message is cut short, whatever the width
      await page.setViewportSize({ width: 390, height: viewport.height });
      await expect(details(page)).toBeVisible();
      await details(page).focus();
      // a resize refits the row
      await page.setViewportSize({ width: 380, height: viewport.height });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(details(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator(".explorer-details")).toBeVisible();
    });
  });
}
