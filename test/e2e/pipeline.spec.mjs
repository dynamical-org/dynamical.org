import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

// /status/pipeline/ is drawn entirely by measurement: lead rows are sized by each
// group's share of a run and init columns by the width of the label beneath them.
// None of that is visible to `npm test`, which has no layout
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
const REPEATED_LEAD_LABELS = Array.from(
  { length: 5 },
  () => ["0h", "1d", "3d"],
).flat();

/* Match by filename, not by base: the dev server points the page at the published
   assets under `npm start` but at `/pipeline-preview/` under `npm run
   start:pipeline`, and a stub that only matched one of those would silently stop
   applying — leaving a test asserting against whatever the server happened to
   serve. */

/** Serve the pipeline page its data, optionally reshaped for one test. */
async function stubPipeline(page, mutate = (payload) => payload) {
  const payload = mutate(structuredClone(FIXTURE));
  await page.route("**/dashboard.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    }),
  );
  // the shared health strip is a separate feed; stub it so the spec neither
  // waits on the network nor reports its failures as ours
  await page.route("**/status.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoints: [{ status: "operational" }] }),
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
    const fieldNode = node.querySelector(".pipeline-field");
    const geometryRoot =
      fieldNode.querySelector(".pipeline-facet-lane") ?? fieldNode;
    const bands = [...geometryRoot.querySelectorAll(".pipeline-band[data-kind]")];
    const field = fieldNode.getBoundingClientRect();
    const body = node.querySelector(".pipeline-row-body").getBoundingClientRect();
    return {
      labels: bands.map(
        (band) => band.querySelector(".pipeline-band-label").textContent,
      ),
      cellHeights: bands.map(
        (band) => +band.querySelector(".pipeline-cell").getBoundingClientRect().height.toFixed(1),
      ),
      cellWidths: bands.map(
        (band) => +band.querySelector(".pipeline-cell").getBoundingClientRect().width.toFixed(1),
      ),
      fieldHeight: Math.round(field.height),
      reserve: getComputedStyle(fieldNode).getPropertyValue("--reserve").trim(),
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

test("the table of contents follows the rendered pipeline groups", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPipeline(page);
  const links = page.locator('[data-slot="pipeline-toc"] a');

  expect(
    await page
      .locator('[data-slot="pipeline-toc-rail"]')
      .evaluate((node) => getComputedStyle(node).position),
  ).toBe("absolute");

  await expect(links).toHaveText([
    "NOAA GFS forecast",
    "ECCC HRDPS continental 2.5 km",
  ]);
  expect(
    await links.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href")),
    ),
  ).toEqual(["#pipeline-group-noaa-gfs", "#pipeline-group-eccc-hrdps"]);

  await links.nth(1).click();
  await expect(page).toHaveURL(/#pipeline-group-eccc-hrdps$/);
  await expect(links.nth(1)).toHaveClass(/active/);
});

test("a source with no mirror and no facets draws one row that does not cycle", async ({
  page,
}) => {
  // HRDPS arrives as a group of one, with no facets and a baseline as short as
  // its monitoring: three lead bands, five runs, and nothing to cycle to
  await openPipeline(page);
  const group = page
    .locator(".pipeline-group")
    .filter({ hasText: "ECCC HRDPS continental 2.5 km" });
  const row = group.locator(".pipeline-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator("strong").first()).toHaveText("MSC Datamart");
  await expect(row.locator(".pipeline-source-meta")).toContainText("00/06/12/18z");
  await expect(row.locator(".pipeline-run-label")).toHaveCount(5);

  const geometry = await bandGeometry(row);
  expect(geometry.labels).toEqual(["2d", "1d", "0h"]);
  // the two 24-hour groups cover the same span; only 0h's single lead is thinner,
  // and even it stays tall enough to carry its own label
  const [longest, middle, shortest] = geometry.cellHeights;
  expect(longest).toBe(middle);
  expect(shortest).toBeLessThan(middle);
  expect(shortest).toBeGreaterThanOrEqual(12);
  expect(geometry.overflowsColumn).toBe(false);

  // one view means a click is inert: no facet lanes, and the field keeps its shape
  await row.locator(".pipeline-viz").click();
  await expect(row.locator(".pipeline-facet-lane")).toHaveCount(0);
  expect(await bandGeometry(row)).toEqual(geometry);
});

test("clicking cycles the rows through content-height facet dimensions", async ({
  page,
}) => {
  const row = await openPipeline(page);
  const viz = row.locator(".pipeline-viz");

  const lead = await bandGeometry(row);

  await viz.click();
  const component = await bandGeometry(row);
  expect(component.labels).toEqual(["pgrb2a", "pgrb2b", "pgrb2s"]);

  await viz.click();
  const member = await bandGeometry(row);
  expect(member.labels).toEqual(["ctl", "pert"]);

  // lead time owns the columns in a facet view, so each lane names it there
  const firstLane = row.locator(".pipeline-facet-lane").first();
  const columnLabels = (
    await firstLane.locator(".pipeline-column-label").allTextContents()
  ).filter(Boolean);
  expect(columnLabels).toEqual(REPEATED_LEAD_LABELS);

  // each view fits its content instead of reserving the tallest view's height
  expect(lead.reserve).toBe("");
  expect(component.reserve).toBe("");
  expect(member.reserve).toBe("");
  expect(component.fieldHeight).not.toBe(lead.fieldHeight);
  expect(member.fieldHeight).not.toBe(lead.fieldHeight);
  expect(member.overflowsColumn).toBe(false);

  // and it wraps back to where it started
  await viz.click();
  expect((await bandGeometry(row)).labels).toEqual(lead.labels);

  // the keyboard reaches it too
  await viz.focus();
  await page.keyboard.press("Enter");
  expect((await bandGeometry(row)).labels).toEqual(component.labels);
});

test("facet views use two compact lanes and show every available init", async ({ page }) => {
  const row = await openPipeline(page);
  await row.locator(".pipeline-viz").click();

  const lanes = row.locator(".pipeline-facet-lane");
  await expect(lanes).toHaveCount(2);
  for (const lane of await lanes.all()) {
    expect(
      await lane
        .locator(".pipeline-band[data-kind='facet'] .pipeline-band-label")
        .allTextContents(),
    ).toEqual(["pgrb2a", "pgrb2b", "pgrb2s"]);
    const leadLabels = (
      await lane.locator(".pipeline-column-label").allTextContents()
    ).filter(Boolean);
    expect(leadLabels).toEqual(REPEATED_LEAD_LABELS);
    await expect(lane.locator(".pipeline-run-label")).toHaveCount(5);
  }
  const rowGaps = await lanes.first().evaluate((lane) => {
    const cells = [
      ...lane.querySelectorAll(".pipeline-band[data-kind='facet']"),
    ].map((band) =>
      band.querySelector(".pipeline-cell").getBoundingClientRect(),
    );
    return cells.slice(1).map((cell, index) => cell.top - cells[index].bottom);
  });
  expect(rowGaps.length).toBeGreaterThan(0);
  for (const gap of rowGaps) expect(gap).toBeGreaterThanOrEqual(4);

  const times = await row.locator(".pipeline-run-label").allTextContents();
  expect(times).toHaveLength(10);
  expect(times.every(Boolean)).toBe(true);
  expect(await row.locator(".pipeline-lead-dot").count()).toBe(0);
  expect(
    await row
      .locator(".pipeline-cell")
      .first()
      .evaluate((cell) => cell.offsetHeight),
  ).toBe(8);
  expect((await bandGeometry(row)).overflowsColumn).toBe(false);
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

test("scan-confirmed late pending work is visibly delayed", async ({ page }) => {
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    const newest = product.recent_inits.at(-1);
    newest.status = "pending";
    newest.timing = "delayed";
    newest.completion_pct = 0;
    for (const group of newest.lead_groups ?? []) {
      group.status = "pending";
      group.timing = "delayed";
      group.completion_pct = 0;
      group.leads_available = 0;
    }
    return payload;
  });

  const cell = row.locator('.pipeline-cell.g-pending[data-timing="delayed"]').first();
  await expect(cell).toBeVisible();
  await expect(cell).toHaveCSS("border-color", "rgb(244, 185, 66)");
  await expect(row.locator('[data-slot="eta-state"]')).toHaveText("pending · delayed");
  await expect(row.locator('[data-slot="eta-state"]')).toHaveCSS(
    "color",
    "rgb(244, 185, 66)",
  );
});

test("details distinguish last, current or upcoming, and historical timings", async ({
  page,
}) => {
  const row = await openPipeline(page);
  await row.locator('[data-slot="details-button"]').click();
  const headings = await row
    .locator(
      ".pipeline-row-details .table-container:first-child thead tr:first-child th",
    )
    .allTextContents();

  expect(headings[0]).toBe("horizon");
  expect(headings[1]).toMatch(/^last run(?: · |$)/);
  expect(headings[2]).toMatch(/^(?:current|upcoming) run(?: · |$)/);
  expect(headings[3]).toMatch(/^time after init · [\d,]+ samples$/);
});

test("each details table scrolls itself, under a header that names its column", async ({
  page,
}) => {
  const row = await openPipeline(page);
  await row.locator('[data-slot="details-button"]').click();

  const measured = await row
    .locator(".pipeline-row-details")
    .evaluate((node) => {
      const [lead, facets] = node.querySelectorAll(".table-container");
      const subHeader = node.querySelector("thead tr + tr th:first-child");
      const statusColor = (state) => {
        const cell = node.querySelector(`td[data-status="${state}"]`);
        return cell && getComputedStyle(cell).color;
      };
      return {
        leadScrolls: lead.scrollWidth > lead.clientWidth,
        facetsFit: facets.scrollWidth <= facets.clientWidth,
        pageFits:
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
        subHeader: [subHeader.textContent, getComputedStyle(subHeader).textAlign],
        complete: statusColor("complete"),
        failed: statusColor("failed"),
      };
    });

  // the lead table is wider than the column, so it scrolls in its own container
  // rather than widening the row or the page; the facet table needs no scroll
  expect(measured.leadScrolls).toBe(true);
  expect(measured.facetsFit).toBe(true);
  expect(measured.pageFits).toBe(true);
  // "horizon" spans both header rows, so this cell heads the last run's status
  expect(measured.subHeader).toEqual(["status", "right"]);
  expect(measured.complete).toBe("rgb(91, 197, 74)");
  expect(measured.failed).toBe("rgb(197, 34, 31)");
});

test("pipeline exposes no history scrubber", async ({ page }) => {
  await openPipeline(page);
  await expect(page.locator("#pipeline-history-toggle")).toHaveCount(0);
  await expect(page.locator("#pipeline-history-panel")).toHaveCount(0);
});

test("a run that reported nothing does not empty the field", async ({ page }) => {
  // a newest run can report no lead groups while the product and runs beside it
  // carry full data; that must not empty the axis or make --run-width negative
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
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
