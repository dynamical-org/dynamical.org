import { expect, test } from "@playwright/test";

// /api/ embeds responses fetched from api.dynamical.org during the build, so the
// build itself is the check that every documented request is still valid — a
// request the API starts rejecting fails `npm run build` rather than misleading a
// reader. What the build cannot check is the prose around those payloads: the
// bounds table is hand-written, and nothing in this repo enforces the numbers in
// it.
//
// The api repo used to guard its own docs by deriving those numbers from the code
// that enforces them. Across repos that guard has to run against the published
// contract instead, which is what this spec does. The 31-day analysis span and
// the 100,000-value work budget are not expressed in OpenAPI and stay
// review-only.

const PATH = "/api/";

test("documented bounds match the published schema", async ({ page, request }) => {
  // `page.goto` resolves for a 404 as readily as a 200, so a page that stopped
  // being generated would otherwise surface as a confusing selector failure.
  const response = await page.goto(PATH);
  expect(response?.status(), `${PATH} did not return 200`).toBe(200);

  // The page records which API it was built against; read the contract from the
  // same one rather than assuming production.
  const base = await page.locator("[data-api-base]").getAttribute("data-api-base");
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
  expect(bounds["Variables per query"]).toBe(
    String(schemas.AnalysisQuery.properties.variables.maxItems)
  );
});

test("every documented endpoint exists on the deployed API", async ({ page, request }) => {
  // The endpoint index and the section headings are prose. A route renamed or
  // withdrawn upstream would leave them pointing at nothing, and only the
  // examples that happen to exercise that route would fail the build.
  await page.goto(PATH);

  const base = await page.locator("[data-api-base]").getAttribute("data-api-base");
  const schema = await (await request.get(`${base}/openapi.json`)).json();
  // Placeholder names are labels, not contract — the deployed schema has spelled
  // them both `{collection_id}` and `{dataProductId}` across releases while the
  // URL shape stayed identical. Compare the shape, which is what a caller builds.
  const shape = (path) => path.replace(/\{[^}]*\}/g, "{}");
  const published = Object.keys(schema.paths).map(shape);

  const documented = await page.evaluate(() =>
    [...document.querySelectorAll(".index-list code")].map((el) => el.textContent.trim())
  );
  expect(documented.length, "the endpoint index is empty").toBeGreaterThan(0);

  for (const entry of documented) {
    const path = shape(entry.split(" ")[1]);
    expect(published, `${entry} is documented but not in the published schema`).toContain(path);
  }
});
