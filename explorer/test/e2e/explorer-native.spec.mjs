import { expect, test } from "@playwright/test";
import { celsius, distance, expectState, loadMap, offline, PAGE, pixelAt, storeRoute } from "./explorer-harness.mjs";

const STORE = new URL("../fixtures/native-store/", import.meta.url);
const DIMS = ["init_time", "lead_time", "cell"];
const FIRST = [10.97, 50.95];
const SECOND = [11.12, 51.08];
const BLANK = [11.1, 51.24];
const WEST = [5.065, 50.95];

async function open(page, delayFor) {
  const log = [];
  await offline(page, {
    store: storeRoute({ store: STORE, shardCounts: [3], log, delayFor }),
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

  await page.evaluate(() => {
    const { deck } = window.__explorer;
    const { zoom } = deck.getViewports()[0];
    deck.setProps({ initialViewState: { longitude: 5.14, latitude: 51, zoom, minZoom: 0, maxPitch: 0 } });
  });
  await drawn(page, WEST, -15);
  await expectState(page, "ready");
  expect(reads()).toEqual([0, 1]);
});

test("stopping a native variable switch keeps the drawn faces until retry replaces them", async ({ page }) => {
  let hold = false;
  const reads = await open(page, ({ entry }) => hold && entry !== null ? 4_000 : 0);
  const variable = page.getByRole("combobox", { name: "Variable" });
  await drawn(page, FIRST, -30);

  hold = true;
  await variable.selectOption("/dew_point_2m");
  await expect.poll(() => reads().length).toBe(2);
  await page.getByRole("button", { name: "Stop loading" }).click();
  await expectState(page, "stopped");
  await drawn(page, FIRST, -30);

  hold = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expectState(page, "ready");
  await drawn(page, FIRST, -15);
  await drawn(page, SECOND, 15);
  await expect(variable).toHaveValue("/dew_point_2m");
});
