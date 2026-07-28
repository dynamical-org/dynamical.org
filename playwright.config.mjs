import { defineConfig } from "@playwright/test";

// End-to-end specs are deliberately kept out of `npm test`: they boot a browser,
// pull DuckDB-WASM and Observable Plot from CDNs, and run real queries against
// the published parquet files, so a run takes minutes and can fail for reasons
// that have nothing to do with this repo. Run them with `npm run test:e2e`.
export default defineConfig({
  testDir: "./test/e2e",
  // The scorecard queries scan tens of MB over the network before anything is
  // drawn; a whole page's worth of charts needs room to finish.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  // One worker: parallel pages would each boot their own DuckDB instance and
  // re-download the same parquet, which is slower than running in sequence.
  workers: 1,
  retries: 1,
  // The HTML report is what the CI job uploads on failure, so build it there too.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:8081",
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://localhost:8081/scorecard/",
    reuseExistingServer: !process.env.CI,
    // A cold build fetches every STAC collection and processes images; on a CI
    // runner with no .cache that takes considerably longer than locally.
    timeout: 300_000,
  },
});
