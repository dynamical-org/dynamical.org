import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

// /status/pipeline/ is drawn entirely by measurement: lead rows are sized by each
// group's share of a run, init columns by the width of the label beneath them,
// and every view reserves the tallest view's height so clicking through them does
// not move the page. None of that is visible to `npm test`, which has no layout
// engine — and three defects found in review were geometry: an init label that
// overflowed its tier in any timezone rendered as a GMT offset, a snapshot whose
// newest run reported nothing rendering an empty field, and a negative
// `--run-width` reaching CSS. This spec is the check for that class of bug.
//
// Unlike the scorecard specs, nothing here touches the network: the payloads are
// stubbed from the repo's own fixture, so a run is fast and deterministic, and
// the page under test is the real built page rather than a harness.

const PATH = "/status/pipeline/";
const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/pipeline-dashboard.json", import.meta.url)),
);

const JSON_HEADERS = { "access-control-allow-origin": "*" };

/** Serve the pipeline page its data, optionally reshaped for one test. */
async function stubPipeline(page, mutate = (payload) => payload) {
  const payload = mutate(structuredClone(FIXTURE));
  await page.route("**/wxopticon/dashboard.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    }),
  );
  // the shared health strip and the history index are separate feeds; stub them
  // so the spec neither waits on the network nor reports their failures as ours
  await page.route("**/status/status.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoints: [{ status: "operational" }] }),
    }),
  );
  await page.route("**/wxopticon/history/index.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: "[]",
    }),
  );
}

async function openPipeline(page, mutate) {
  await stubPipeline(page, mutate);
  const response = await page.goto(PATH);
  expect(response?.status(), `${PATH} did not return 200`).toBe(200);
  // the field is rendered from the fetched payload, not the build
  await expect(page.locator(".pipeline-row .pipeline-cell").first()).toBeVisible();
  await expect(page.locator('[data-slot="banners"]')).toHaveText("");
  return page.locator(".pipeline-row").first();
}

/** What one band's cells actually measure, in the row's first band. */
function bandGeometry(row) {
  return row.evaluate((node) => {
    const bands = [...node.querySelectorAll(".pipeline-band[data-kind]")];
    const field = node.querySelector(".pipeline-field").getBoundingClientRect();
    const body = node.querySelector(".pipeline-row-body").getBoundingClientRect();
    return {
      labels: bands.map((band) => band.querySelector(".pipeline-band-label").textContent),
      cellHeights: bands.map(
        (band) => +band.querySelector(".pipeline-cell").getBoundingClientRect().height.toFixed(1),
      ),
      cellWidths: bands.map(
        (band) => +band.querySelector(".pipeline-cell").getBoundingClientRect().width.toFixed(1),
      ),
      fieldHeight: Math.round(field.height),
      overflowsColumn: field.width > body.width + 0.5,
    };
  });
}

test("the default view is lead groups by init, sized by group and labelled per column", async ({
  page,
}) => {
  const row = await openPipeline(page);
  const geometry = await bandGeometry(row);

  // rows are lead groups, longest horizon first
  expect(geometry.labels).toEqual(["3d", "1d", "0h"]);

  // each row's height is its group's share of the run: 3d covers more forecast
  // hours than 1d, which covers more than 0h. This is what main's bar segments
  // encoded, and a uniform grid would silently drop it.
  const [longest, middle, shortest] = geometry.cellHeights;
  expect(longest).toBeGreaterThan(middle);
  expect(middle).toBeGreaterThan(shortest);
  // and no group is thinner than the label it has to carry
  expect(shortest).toBeGreaterThanOrEqual(12);

  // every column names its own init, in two tiers, with the date only where it
  // turns over — and each time sits centred on the squares above it
  const offsets = await row.evaluate((node) => {
    const cells = [...node.querySelector(".pipeline-band[data-kind] .pipeline-cells").children];
    const times = [...node.querySelectorAll(".pipeline-run-label")];
    const centre = (el) => {
      const box = el.getBoundingClientRect();
      return box.left + box.width / 2;
    };
    return cells.map((cell, index) => +(centre(times[index]) - centre(cell)).toFixed(1));
  });
  expect(offsets.length).toBeGreaterThan(1);
  for (const offset of offsets) expect(Math.abs(offset)).toBeLessThan(1);

  const dates = await row.locator(".pipeline-run-date").allTextContents();
  expect(dates.filter(Boolean).length).toBeGreaterThan(0);
  expect(geometry.overflowsColumn).toBe(false);
});

test("clicking cycles the rows through each facet dimension without moving the page", async ({
  page,
}) => {
  const row = await openPipeline(page);
  const viz = row.locator(".pipeline-viz");
  const pageHeight = () => page.evaluate(() => document.body.scrollHeight);

  const lead = await bandGeometry(row);
  const heightBefore = await pageHeight();

  await viz.click();
  const component = await bandGeometry(row);
  expect(component.labels).toEqual(["pgrb2a", "pgrb2b", "pgrb2s"]);

  await viz.click();
  const member = await bandGeometry(row);
  expect(member.labels).toEqual(["control", "perturbed"]);

  // lead time owns the columns in a facet view, so it is named there instead
  expect(await row.locator(".pipeline-column-label").first()).toBeTruthy();
  const columnLabels = (await row.locator(".pipeline-column-label").allTextContents()).filter(
    Boolean,
  );
  expect(columnLabels).toEqual(["0h", "1d", "3d"]);

  // the views share one box: a cycle must not shift what is below the row
  expect(component.fieldHeight).toBe(lead.fieldHeight);
  expect(member.fieldHeight).toBe(lead.fieldHeight);
  expect(await pageHeight()).toBe(heightBefore);
  expect(member.overflowsColumn).toBe(false);

  // and it wraps back to where it started
  await viz.click();
  expect((await bandGeometry(row)).labels).toEqual(lead.labels);

  // the keyboard reaches it too
  await viz.focus();
  await page.keyboard.press("Enter");
  expect((await bandGeometry(row)).labels).toEqual(component.labels);
});

test("progress fills along whichever axis lead time owns", async ({ page }) => {
  const row = await openPipeline(page);

  const fillShape = () =>
    row.evaluate((node) => {
      const cell = [...node.querySelectorAll(".pipeline-cell.g-in_flight")].find((candidate) => {
        const pct = parseFloat(
          candidate.querySelector(".pipeline-cell-fill")?.style.getPropertyValue("--fill"),
        );
        return pct > 5 && pct < 95;
      });
      if (!cell) return null;
      const box = cell.getBoundingClientRect();
      const fill = cell.querySelector(".pipeline-cell-fill").getBoundingClientRect();
      return {
        widthRatio: +(fill.width / (box.width - 2)).toFixed(2),
        heightRatio: +(fill.height / (box.height - 2)).toFixed(2),
      };
    });

  // the default view stacks lead time vertically, so a part-arrived cell fills
  // from its floor, as the bars did
  const stacked = await fillShape();
  if (stacked) {
    expect(stacked.widthRatio).toBe(1);
    expect(stacked.heightRatio).toBeLessThan(1);
  }

  // a facet view puts lead time across, so the same cell fills from its left edge
  await row.locator(".pipeline-viz").click();
  const across = await fillShape();
  expect(across, "no part-arrived facet cell in the fixture").not.toBeNull();
  expect(across.heightRatio).toBe(1);
  expect(across.widthRatio).toBeLessThan(1);
});

test("expected-but-absent and never-observed do not look the same", async ({ page }) => {
  // one is a measurement, the other is the absence of one; rendering them alike
  // would report unknown evidence as though the data were merely late
  // both states are constructed rather than hoped for: the fixture's own runs are
  // complete, failed and in flight, so neither would appear by chance
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    // the field draws the most recent runs that fit, so both states have to be
    // put on runs that are actually displayed
    const blind = product.recent_inits.at(-2);
    blind.status = "unobserved";
    for (const group of blind.lead_groups ?? []) group.status = "unobserved";

    const newest = product.recent_inits.at(-1);
    for (const group of newest.lead_groups ?? []) {
      group.status = "pending";
      group.completion_pct = 0;
      group.leads_available = 0;
      for (const facet of group.facets ?? []) {
        facet.status = "pending";
        facet.completion_pct = 0;
        facet.dependencies_available = 0;
      }
    }
    return payload;
  });

  await expect(row.locator(".pipeline-cell.g-pending").first()).toBeVisible();
  await expect(row.locator(".pipeline-cell.g-unobserved").first()).toBeVisible();

  const [pending, unobserved] = await Promise.all([
    row.locator(".pipeline-cell.g-pending").first().evaluate((cell) => {
      const style = getComputedStyle(cell);
      return { border: style.borderStyle, background: style.backgroundImage };
    }),
    row.locator(".pipeline-cell.g-unobserved").first().evaluate((cell) => {
      const style = getComputedStyle(cell);
      return { border: style.borderStyle, background: style.backgroundImage };
    }),
  ]);
  expect(unobserved).not.toEqual(pending);
  // the unknown one is hatched; the pending one carries no pattern
  expect(unobserved.background).toContain("gradient");
  expect(pending.background).not.toContain("gradient");
});

test("a run that reported nothing does not empty the field", async ({ page }) => {
  // history snapshots declare no lead groups of their own, so a newest run with
  // none used to leave the axis empty — no bands, and a negative --run-width
  // reaching CSS — while the runs beside it carried full data
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    delete product.lead_groups;
    const newest = product.recent_inits.at(-1);
    newest.status = "unobserved";
    delete newest.lead_groups;
    return payload;
  });

  const geometry = await bandGeometry(row);
  expect(geometry.labels.length).toBeGreaterThan(0);
  await expect(row.locator(".pipeline-cell").first()).toBeVisible();

  const runWidth = await row.evaluate((node) =>
    getComputedStyle(node.querySelector(".pipeline-field")).getPropertyValue("--run-width").trim(),
  );
  expect(parseFloat(runWidth)).toBeGreaterThan(0);
  expect(geometry.overflowsColumn).toBe(false);
});

test.describe("in a timezone rendered as a GMT offset", () => {
  // `en-US` has no letter abbreviation for these zones, so it formats them as
  // "18 GMT+5:30" — nearly twice the width of "08 CDT". Budgeting a fixed number
  // of characters overflowed the label tier for every reader outside the zones
  // that happen to have abbreviations.
  test.use({ timezoneId: "Asia/Kolkata", locale: "en-US" });

  test("init labels still fit their tier", async ({ page }) => {
    const row = await openPipeline(page);
    await page.selectOption("#status-time-toggle", "local");
    await expect(row.locator(".pipeline-run-label").first()).toContainText("GMT");

    const labels = await row.evaluate((node) => {
      const spans = [...node.querySelectorAll(".pipeline-run-label")];
      const cells = [...node.querySelector(".pipeline-band[data-kind] .pipeline-cells").children];
      return {
        sample: spans[0].textContent,
        clipped: spans.filter((span) => span.scrollWidth > span.clientWidth + 0.5).length,
        wrapped: spans.filter((span) => span.getBoundingClientRect().height > 13).length,
        widthMatchesColumn:
          Math.abs(
            spans[0].getBoundingClientRect().width - cells[0].getBoundingClientRect().width,
          ) < 0.5,
      };
    });

    expect(labels.clipped, `"${labels.sample}" is clipped`).toBe(0);
    expect(labels.wrapped, `"${labels.sample}" wrapped onto a second line`).toBe(0);
    expect(labels.widthMatchesColumn).toBe(true);
    expect((await bandGeometry(row)).overflowsColumn).toBe(false);
  });
});
