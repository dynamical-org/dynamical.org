import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { reshapeStacCollection } = require("../_data/catalog.js");

// A categorical dimension's labels come from the datacube `values` array; its
// extent is [null, null], so min/max alone left the catalog table blank.
test("passes a categorical dimension's values through to the template", () => {
  const { dimensions } = reshapeStacCollection({
    id: "example-forecast",
    "cube:dimensions": {
      init_time: { type: "temporal", extent: ["2026-01-01T00:00:00Z", null], size: 100 },
      lead_time: { type: "other", extent: [0, 172800], unit: "seconds", size: 49 },
      statistic: { type: "other", extent: [null, null], unit: "1", size: 2, values: ["mean", "spread"] },
    },
  });
  assert.deepEqual(dimensions, [
    { name: "init_time", units: undefined, size: 100, values: null, statistics_approximate: { min: "2026-01-01T00:00:00Z", max: null } },
    { name: "lead_time", units: "seconds", size: 49, values: null, statistics_approximate: { min: 0, max: 172800 } },
    { name: "statistic", units: "1", size: 2, values: ["mean", "spread"], statistics_approximate: { min: null, max: null } },
  ]);
});
