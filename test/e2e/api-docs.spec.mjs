import { expect, test } from "@playwright/test";

// The /api/ page documents a service this repo does not build, and its `run it`
// buttons issue real cross-origin requests to api.dynamical.org. Nothing in the
// Eleventy build or the unit tests can notice when that contract moves: a field
// renamed in a response, a request body the API starts rejecting (it forbids
// unknown fields, so one added key is a 422), a CORS change that stops exposing
// `X-Dynamical-Work-Units`, or a data product being withdrawn. All of those leave
// the page building perfectly and every button failing.
//
// This spec is the only thing that exercises page → browser fetch → Cloudflare →
// Modal → Icechunk end to end, and it reports the status line the page itself
// showed, so a failure names the reason rather than timing out.

const PATH = "/api/";

// Set by the runner while a request is in flight — the one state that is not yet
// a verdict.
const RUNNING_TEXT = "running…";

/** Click one run-it button and return the status line it settled on. */
async function runButton(page, name) {
  const button = page.locator(`button[data-try="${name}"]`);
  const status = page.locator(`button[data-try="${name}"] ~ .try-status`);
  await button.scrollIntoViewIfNeeded();
  await button.click();

  let settled = RUNNING_TEXT;
  await expect
    .poll(
      async () => {
        settled = (await status.textContent())?.trim() || "";
        return settled !== "" && settled !== RUNNING_TEXT;
      },
      {
        message: `run it (${name}) never settled`,
        // A cold container plus an Icechunk read is seconds; this ceiling only
        // bounds an outright hang, which `retries` in the config covers.
        timeout: 120_000,
        intervals: [500],
      }
    )
    .toBe(true);
  return settled;
}

test("every documented request still answers 200", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`uncaught: ${err.message}`));

  // `page.goto` resolves for a 404 as readily as a 200, so a page that stopped
  // being generated would otherwise look like a button that never fires.
  const response = await page.goto(PATH);
  expect(response?.status(), `${PATH} did not return 200`).toBe(200);

  const names = await page.locator("button[data-try]").evaluateAll((buttons) => [
    ...new Set(buttons.map((b) => b.dataset.try)),
  ]);
  expect(names.length, "the page renders no run-it buttons").toBeGreaterThan(0);

  for (const name of names) {
    const settled = await runButton(page, name);
    expect(settled, `run it (${name}) reported: ${settled}`).toContain("HTTP 200");
  }

  // The work-units and dataset-cache figures in the status line are only readable
  // because the API lists them in Access-Control-Expose-Headers; losing that is a
  // silent regression for every browser client, not just this page.
  const forecastStatus = await page
    .locator('button[data-try="forecast"] ~ .try-status')
    .textContent();
  expect(forecastStatus, "cross-origin response headers are not readable").toContain(
    "work units"
  );

  expect(errors, "the page logged errors").toEqual([]);
});

// The api repo used to guard its own docs against drift by deriving the numbers
// from the code that enforces them. Across repos that guard has to run against
// the published contract instead, so the caps that appear in the schema are
// checked here. The 31-day analysis span and the 100,000-value work budget are
// not expressed in OpenAPI and stay review-only.
test("documented bounds match the published schema", async ({ page, request }) => {
  await page.goto(PATH);
  const base = await page.locator("#api-docs").getAttribute("data-api-base");

  const schema = await (await request.get(`${base}/openapi.json`)).json();
  const schemas = schema.components.schemas;

  const bounds = await page.evaluate(() => {
    const table = [...document.querySelectorAll("table.data")].find(
      (t) => t.querySelector("th")?.textContent.trim() === "Bound"
    );
    return Object.fromEntries(
      [...table.rows]
        .slice(1)
        .map((row) => [row.cells[0].textContent.trim(), row.cells[1].textContent.trim()])
    );
  });

  expect(bounds["Queries per batch"]).toBe(
    String(schemas.ForecastBatch.properties.queries.maxItems)
  );
  expect(bounds["Queries per batch"]).toBe(
    String(schemas.AnalysisBatch.properties.queries.maxItems)
  );
  expect(bounds["Variables per query"]).toBe(
    String(schemas.ForecastQuery.properties.variables.maxItems)
  );
});
