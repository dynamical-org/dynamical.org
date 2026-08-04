import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { abbreviateDuration } = require("../lib/catalog-format.js");

test("abbreviates catalog durations", () => {
  const cases = [
    ["every hour", "every 1h"],
    ["every 6 hours", "every 6h"],
    ["1 hour", "1h"],
    ["3.0 hours", "3h"],
    ["30 minutes", "30m"],
    ["0-384 hours (0-16 days)", "0-384h (0-16 days)"],
    ["3 km", "3 km"],
    [null, ""],
  ];

  for (const [input, expected] of cases) {
    assert.equal(abbreviateDuration(input), expected);
  }
});
