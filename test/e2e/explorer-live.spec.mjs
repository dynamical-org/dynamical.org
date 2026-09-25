import { expect, test } from "@playwright/test";

import { PAGE, celsius, distance, expectState, pixelAt, wrapBundle } from "./explorer-harness.mjs";

// The offline spec proves the explorer against a fixture. This one opens the
// real GFS forecast page against the live Icechunk store, like the scorecard
// specs do with their parquet: it is the check that catches the store drifting
// out from under the explorer (a new format version, codec, CORS or layout
// change). Needs the network; a cold first frame reads about 7 MB.

test("the GFS forecast page draws a live frame from the published store", async ({ page }) => {
  await wrapBundle(page);
  await page.goto(PAGE);
  await page.getByRole("button", { name: "Load interactive map" }).click();
  await expectState(page, "ready", 120_000);

  await expect(page.locator('.explore-map [data-label="init"]')).toContainText(/\d{4}-\d{2}-\d{2}/);
  // A drawn frame, not a blank canvas: land points in the CONUS view are
  // coloured from the temperature scale.
  const scale = Array.from({ length: 256 }, (_, i) => celsius(-40 + (90 * i) / 255));
  for (const [lon, lat] of [[-100, 40], [-90, 35], [-110, 45]]) {
    const rgb = await pixelAt(page, lon, lat);
    const off = Math.min(...scale.map((c) => distance(rgb, c)));
    expect(off, `${lon}, ${lat} drew rgb(${rgb})`).toBeLessThan(40);
  }
});
