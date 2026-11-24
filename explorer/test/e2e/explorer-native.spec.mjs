import { expect, test } from "@playwright/test";
import { celsius, distance, expectState, loadMap, offline, PAGE, pixelAt, storeRoute } from "./explorer-harness.mjs";

const STORE = new URL("../fixtures/native-store/", import.meta.url);
const DIMS = ["init_time", "lead_time", "cell"];
const FIRST = [10.97, 50.95];
const SECOND = [11.12, 51.08];
const BLANK = [11.1, 51.24];
const WEST = [5.065, 50.95];

async function open(page, { delayFor, failFor } = {}) {
  const log = [];
  await offline(page, {
    store: storeRoute({ store: STORE, shardCounts: [3], log, delayFor, failFor }),
    overrides: {
      variables: ["temperature_2m", "dew_point_2m"].map((path) => ({ name: path, path, dims: DIMS })),
      initialView: { bounds: [10.65, 50.70, 11.35, 51.30] },
    },
  });
  await page.goto(PAGE);
  await loadMap(page);
  return () => log.filter(({ entry }) => entry !== null).map(({ entry }) => entry);
}

async function drawn(page, point, value) {
  await expect.poll(async () => distance(await pixelAt(page, ...point), celsius(value))).toBeLessThan(15);
}

function pan(page, [longitude, latitude]) {
  return page.evaluate(([longitude, latitude]) => {
    const { deck } = window.__explorer;
    const { zoom } = deck.getViewports()[0];
    deck.setProps({ initialViewState: { longitude, latitude, zoom, minZoom: 0, maxPitch: 0 } });
  }, [longitude, latitude]);
}

const textures = (page) => page.evaluate(() => window.__explorer.debug().textures);

test("native faces draw their own values and only visible chunks are read, once for all leads", async ({ page }) => {
  const reads = await open(page);
  await drawn(page, FIRST, -30);
  await drawn(page, SECOND, 0);
  await expect.poll(() => pixelAt(page, ...BLANK)).toEqual([255, 0, 255]);
  expect(reads()).toEqual([0]);

  await page.getByRole("slider", { name: /lead time/i }).press("ArrowRight");
  await expectState(page, "ready");
  await drawn(page, FIRST, -15);
  expect(reads()).toEqual([0]);

  await pan(page, WEST);
  await drawn(page, WEST, -15);
  await expectState(page, "ready");
  expect(reads()).toEqual([0, 1]);
  expect(await textures(page)).toBe(1);

  const outside = [-60, 0];
  await pan(page, outside);
  await expect.poll(() => pixelAt(page, ...outside)).toEqual([255, 0, 255]);
  await expect(page.locator(".explore-map").getByRole("status"))
    .not.toHaveAttribute("title", /this run may not be written/i, { timeout: 2_000 });
  await expectState(page, "ready");
});

test("native faces decode scale, offset and missing values exactly once", async ({ page }) => {
  await open(page);
  await page.getByRole("combobox", { name: "Variable" }).selectOption("/dew_point_2m");
  await expectState(page, "ready");

  await drawn(page, FIRST, -15);
  await drawn(page, SECOND, 15);
  await expect.poll(() => pixelAt(page, 10.74, 50.94), { message: "missing_value face" })
    .toEqual([255, 0, 255]);
  await expect.poll(() => pixelAt(page, 10.76, 51.07), { message: "fill value face" })
    .toEqual([255, 0, 255]);
});

test("stopping a native variable switch keeps the drawn faces until retry replaces them", async ({ page }) => {
  let hold = false;
  const reads = await open(page, { delayFor: ({ entry }) => hold && entry !== null ? 4_000 : 0 });
  const variable = page.getByRole("combobox", { name: "Variable" });
  await drawn(page, FIRST, -30);

  hold = true;
  await variable.selectOption("/dew_point_2m");
  await expect.poll(() => reads().length).toBe(2);
  await page.getByRole("button", { name: "Stop loading" }).click();
  await expectState(page, "stopped");
  await drawn(page, FIRST, -30);

  // A retiring layer must release its textures before the replacement frame
  // draws, even when the explorer's safety net would clean them up afterward.
  await page.evaluate(() => {
    const explorer = window.__explorer;
    const { deck } = explorer;
    const { onAfterRender } = deck.props;
    const original = explorer.debug().layers[0];
    const retired = window.retiredTextures = [];
    let before;
    deck.setProps({
      onBeforeRender: () => { before = explorer.debug().textures; },
      onAfterRender: (...args) => {
        onAfterRender(...args);
        const { layers, textures } = explorer.debug();
        if (layers[0] !== original) retired.push(before - textures);
      },
    });
  });
  hold = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expectState(page, "ready");
  await drawn(page, FIRST, -15);
  await drawn(page, SECOND, 15);
  await expect(variable).toHaveValue("/dew_point_2m");
  expect(await textures(page)).toBe(1);
  const releasedAfterDraw = await page.evaluate(() => window.retiredTextures);
  expect(releasedAfterDraw.length).toBeGreaterThan(0);
  expect(releasedAfterDraw).not.toContain(1);
});

test("panning away cancels a native chunk and discards a texture returned after cancellation", async ({ page }) => {
  let hold = true;
  const reads = await open(page, { delayFor: ({ entry }) => hold && entry === 1 ? 5_000 : 0 });
  await pan(page, WEST);
  await expect.poll(reads).toEqual([0, 1]);
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().includes(".icechunk/chunks/"),
    timeout: 3_000,
  });
  await pan(page, FIRST);
  await cancelled;
  await drawn(page, FIRST, -30);
  await expectState(page, "ready");
  expect(await textures(page)).toBe(1);

  // Hold the next load at the tile callback boundary after the GPU upload.
  // The resulting texture must still be released if the viewport has moved.
  hold = false;
  await page.evaluate(() => {
    const { deck } = window.__explorer;
    const release = Promise.withResolvers();
    window.releaseNativeRead = release.resolve;
    let holdNext = true;
    deck.setProps({ layers: deck.props.layers.map((layer) => {
      const getTileData = layer.props.getTileData;
      if (!getTileData) return layer;
      return layer.clone({
        getTileData: async (...args) => {
          const held = holdNext;
          holdNext = false;
          const content = await getTileData(...args);
          if (held) {
            window.nativeReadUploaded = true;
            await release.promise;
          }
          return content;
        },
      });
    }) });
  });
  await pan(page, WEST);
  await expect.poll(reads).toEqual([0, 1, 1]);
  await page.waitForFunction(() => window.nativeReadUploaded);
  expect(await textures(page)).toBe(1);
  await expect.poll(() => pixelAt(page, ...WEST)).toEqual([255, 0, 255]);
  await pan(page, FIRST);
  await drawn(page, FIRST, -30);
  await expect.poll(() => textures(page)).toBe(2);
  await page.evaluate(() => window.releaseNativeRead());
  await expect.poll(() => textures(page)).toBe(1);
  await drawn(page, FIRST, -30);
  await expect.poll(() => pixelAt(page, ...BLANK)).toEqual([255, 0, 255]);
});

test("a failed native chunk waits for Retry before requesting and drawing again", async ({ page }) => {
  let fail = true;
  const reads = await open(page, { failFor: ({ entry }) => fail && entry === 1 });
  await pan(page, WEST);
  await expectState(page, "error");
  // A failed chunk must stay idle across subsequent frames until Retry.
  await page.waitForTimeout(300);
  expect(reads()).toEqual([0, 1]);

  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expectState(page, "ready");
  await drawn(page, WEST, -30);
  expect(reads()).toEqual([0, 1, 1]);
});
