import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ValidationReportPage = require("../content/catalog/validation.11ty.js");

const datasetId = "noaa-rtma-analysis-virtual";
const baseUrl = `https://dataset-validation-reports.dynamical.org/${datasetId}/latest/`;

test("RTMA validation evidence and plots resolve under the stable report path", () => {
  const page = new ValidationReportPage();
  const html = page.render({
    entry: {
      datasetId,
      baseUrl,
      markdown: [
        "## Summary",
        "### Review notes",
        "The cause of the NODD gaps is unconfirmed.",
        "See [exact hours](unavailable_timestamps.txt) and [source checks](evidence/boundary-verification.json).",
        "[NOAA source](https://www.nco.ncep.noaa.gov/pmb/products/rtma/)",
        "## Per-variable details",
        "### `cloud_ceiling_height`",
        "**Point time series**",
        "**Spatial**",
        "**Temporal**",
        "**Availability**",
      ].join("\n\n"),
    },
    catalog: { entries: [{ id: datasetId, title: "NOAA RTMA analysis, virtual" }] },
  });

  assert.match(html, /NOAA RTMA analysis, virtual validation report/);
  assert.match(html, /The cause of the NODD gaps is unconfirmed\./);
  for (const filename of [
    "unavailable_timestamps.txt",
    "evidence/boundary-verification.json",
    "value_timeseries_cloud_ceiling_height.png",
    "spatial_cloud_ceiling_height.png",
    "temporal_cloud_ceiling_height.png",
    "availability_cloud_ceiling_height.png",
  ]) {
    assert.ok(html.includes(`href="${baseUrl}${filename}"`), filename);
    if (filename.endsWith(".png")) {
      assert.ok(html.includes(`src="${baseUrl}${filename}"`), filename);
    }
  }
  assert.ok(html.includes('href="https://www.nco.ncep.noaa.gov/pmb/products/rtma/"'));
  assert.doesNotMatch(html, /\/drafts\/|href="evidence\//);
});
