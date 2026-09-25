import { expect, test } from "@playwright/test";

import { celsius, distance, expectState, pixelAt, wrapBundle } from "./explorer-harness.mjs";

// The offline spec proves the explorer against a fixture. This one opens real
// catalog pages against the live stores, like the scorecard specs do with their
// parquet: it is the check that catches a store drifting out from under the
// explorer (a new format version, codec, CORS or layout change). One page per
// read path: a materialized store (sharded blosc chunks in our bucket) and a
// virtual one (GRIB messages in NOAA's bucket, decoded in the browser). Needs
// the network; each cold first frame reads about 7 MB.

for (const [id, kind] of [
  ["noaa-gfs-forecast", "materialized"],
  ["noaa-gfs-forecast-virtual", "virtual"],
]) {
  test(`the ${kind} GFS forecast page draws a live frame from the published store`, async ({ page }) => {
    await wrapBundle(page);
    await page.goto(`/catalog/${id}/`);
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
}
