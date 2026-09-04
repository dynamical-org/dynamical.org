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

/** Serve the pipeline page its data, optionally reshaped for one test. The
 * reshaping sees which request this is, counted from one, so a spec can hand
 * the poll something different from what the page loaded with. */
async function stubPipeline(page, mutate = (payload) => payload) {
  let served = 0;
  await page.route("**/dashboard.json", (route) => {
    served += 1;
    const payload = mutate(structuredClone(FIXTURE), served);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
  });
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

/** Every timestamp in the payload shifted so the running init began `agoMs`
 * ago. The committed fixture pins its times so tests can assert on them, which
 * leaves its running init hours old and its elapsed duration reading in whole
 * minutes; a run twenty minutes old reads "19m 40s" and ticks every second. */
function withRecentRun(payload, agoMs) {
  const product = payload.groups[0].products[0];
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
  );
  const shift = Date.now() - agoMs - Date.parse(running.init_time);
  return JSON.parse(
    JSON.stringify(payload, (_key, value) =>
      typeof value === "string" &&
      /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value))
        ? new Date(Date.parse(value) + shift).toISOString()
        : value,
    ),
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

/** What each row of the field measures: its label, and its first cell's size.
 * In the lead grid a row is a band; in a facet grid the labels sit in a gutter
 * column and the cells in each run's clump for that facet. */
function bandGeometry(row) {
  return row.evaluate((node) => {
    const fieldNode = node.querySelector(".pipeline-field");
    const firstInit = fieldNode
      .querySelector(".pipeline-run-head")
      ?.getAttribute("data-init-time");
    const rows = fieldNode.classList.contains("pipeline-field--runs")
      ? [...fieldNode.querySelectorAll('.pipeline-band-label[data-lane="0"]')].map(
          (label, index) => ({
            label,
            cell: fieldNode
              .querySelectorAll(
                `.pipeline-clump[data-facet][data-init-time="${firstInit}"]`,
              )[index]
              .querySelector(".pipeline-cell"),
          }),
        )
      : [...fieldNode.querySelectorAll(".pipeline-band[data-kind]")].map((band) => ({
          label: band.querySelector(".pipeline-band-label"),
          cell: band.querySelector(".pipeline-cell"),
        }));
    const field = fieldNode.getBoundingClientRect();
    const body = node.querySelector(".pipeline-row-body").getBoundingClientRect();
    return {
      labels: rows.map(({ label }) => label.textContent),
      cellHeights: rows.map(
        ({ cell }) => +cell.getBoundingClientRect().height.toFixed(1),
      ),
      cellWidths: rows.map(
        ({ cell }) => +cell.getBoundingClientRect().width.toFixed(1),
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
  const columnLabels = (
    await row
      .locator('.pipeline-run-head[data-lane="0"] .pipeline-column-label')
      .allTextContents()
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

  // a lane is a set of grid rows the runs are placed into, not a subtree
  for (const lane of ["0", "1"]) {
    expect(
      await row
        .locator(`.pipeline-band-label[data-kind="facet"][data-lane="${lane}"]`)
        .allTextContents(),
    ).toEqual(["pgrb2a", "pgrb2b", "pgrb2s"]);
    const heads = row.locator(`.pipeline-run-head[data-lane="${lane}"]`);
    await expect(heads).toHaveCount(5);
    const leadLabels = (
      await heads.locator(".pipeline-column-label").allTextContents()
    ).filter(Boolean);
    expect(leadLabels).toEqual(REPEATED_LEAD_LABELS);
    await expect(
      row.locator(`.pipeline-run-label[data-lane="${lane}"]`),
    ).toHaveCount(5);
  }
  // the second lane sits below the first, not beside it
  const laneTops = await row.evaluate((node) =>
    ["0", "1"].map(
      (lane) =>
        node
          .querySelector(`.pipeline-clump[data-facet][data-lane="${lane}"] .pipeline-cell`)
          .getBoundingClientRect().top,
    ),
  );
  expect(laneTops[1]).toBeGreaterThan(laneTops[0] + 8);
  const rowGaps = await row.evaluate((node) => {
    const init = node
      .querySelector(".pipeline-run-head")
      .getAttribute("data-init-time");
    const cells = [
      ...node.querySelectorAll(
        `.pipeline-clump[data-facet][data-init-time="${init}"]`,
      ),
    ].map((clump) => clump.querySelector(".pipeline-cell").getBoundingClientRect());
    return cells.slice(1).map((cell, index) => cell.top - cells[index].bottom);
  });
  // the DOM reads the way the picture does: a lane's lead labels, then each
  // facet's label followed by its squares, then the times, then the dates
  const order = await row.evaluate((node) =>
    [...node.querySelector(".pipeline-field").children].map((child) =>
      child.classList.contains("pipeline-run-head")
        ? "head"
        : child.classList.contains("pipeline-band-label")
          ? `label:${child.textContent}`
          : child.dataset.facet
            ? `cells:${child.dataset.facet}`
            : child.className,
    ),
  );
  const lane = order.slice(0, order.length / 2);
  expect(lane.slice(0, 5)).toEqual(Array(5).fill("head"));
  expect(lane[5]).toBe("label:pgrb2a");
  expect(lane.slice(6, 11).every((item) => item.startsWith("cells:"))).toBe(true);
  expect(lane.slice(-10, -5)).toEqual(Array(5).fill("pipeline-run-label"));
  expect(lane.slice(-5)).toEqual(Array(5).fill("pipeline-run-date"));
  expect(order.slice(order.length / 2)).toEqual(lane);
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

test("a dynamical row reports lag after its source, not time after init", async ({
  page,
}) => {
  await openPipeline(page);
  const row = page
    .locator(".pipeline-row")
    .filter({ hasText: "dynamical.org · virtual" });
  await row.locator('[data-slot="details-button"]').click();
  const table = row.locator(".pipeline-row-details .table-container").first();

  await expect(table.locator("thead tr:first-child th").nth(3)).toHaveText(
    "lag after source · 8 recent samples · insufficient history (24/30 days)",
  );
  // the lag replaces the duration column; the time beside it stays wall-clock
  const cells = table.locator("tbody tr:first-child td");
  await expect(cells.nth(2)).toHaveText(/^\d{2}:\d{2}$/);
  await expect(cells.nth(3)).toHaveText("5m");
  await expect(cells.nth(7)).toHaveText("9m");
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

// The fixture's running init is delayed, which colors both tables amber and so
// hides a disagreement. On an on-time run the lead table read green while the
// facet table stayed amber, because a facet reports no timing of its own.
test("the same status reads the same color in both details tables", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    const running = product.recent_inits.findLast(
      (init) => init.status === "in_flight",
    );
    running.timing = "on_time";
    for (const group of running.lead_groups) group.timing = "on_time";
    return payload;
  });
  await row.locator('[data-slot="details-button"]').click();

  const colors = await row
    .locator(".pipeline-row-details")
    .evaluate((node) =>
      [...node.querySelectorAll('td[data-status="in_flight"]')].map(
        (cell) => getComputedStyle(cell).color,
      ),
    );

  expect(colors.length).toBeGreaterThan(1);
  expect(new Set(colors)).toEqual(new Set(["rgb(91, 197, 74)"]));
});

// Open details re-render once a second so their elapsed durations tick. The
// rebuild used to recreate each table's scroll box and so snap it back to the
// left edge every tick, which made a wide table impossible to read. Now the
// keyed diff keeps the box, so the check holds on to the node itself: the same
// element, still connected, still scrolled, after the tick has visibly happened.
test("details keep their horizontal scroll across the live refresh", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) =>
    withRecentRun(payload, 20 * 60 * 1000),
  );
  await row.locator('[data-slot="details-button"]').click();
  const table = row.locator(".pipeline-row-details .table-container").first();
  const container = await table.elementHandle();

  const scrolled = await container.evaluate((node) => {
    node.scrollLeft = 120;
    return node.scrollLeft;
  });
  expect(scrolled).toBeGreaterThan(0);

  // the 3d horizon is the one the current run is still working on, so its
  // duration counts up from the init: wait for the countdown to have actually
  // changed it, rather than for the clock
  const duration = table.locator("tbody tr:last-child td").nth(6);
  const before = await duration.textContent();
  expect(before).toMatch(/^\d+m \d+s$/);
  await expect(duration).not.toHaveText(before);
  expect(await container.evaluate((node) => node.isConnected)).toBe(true);
  expect(await container.evaluate((node) => node.scrollLeft)).toBe(scrolled);

  // view cycling re-renders the row through the same path as the dashboard
  // poll, a resize, and the time-zone toggle
  await row.locator(".pipeline-viz").click();
  await expect(row).toHaveAttribute("data-view", "1");
  expect(await container.evaluate((node) => node.isConnected)).toBe(true);
  expect(await container.evaluate((node) => node.scrollLeft)).toBe(scrolled);
});

// Every refresh — the countdown each second, the poll every fifteen — used to
// rebuild subtrees, and whatever the reader had done to them went with the old
// nodes. These specs hold on to the nodes and check that the same ones are
// still there afterwards, carrying the same state: nothing restores it by hand.
test.describe("what the reader has done survives a refresh", () => {
  // a fake clock makes the refresh happen on demand rather than by waiting
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });

  /** Open the first row's details, scroll its table, focus the button that
   * opened it, and select the row's source line. */
  async function settleIn(page, row) {
    await row.locator('[data-slot="details-button"]').click();
    const table = row.locator(".pipeline-row-details .table-container").first();
    const container = await table.elementHandle();
    const scrolled = await container.evaluate((node) => {
      node.scrollLeft = 120;
      return node.scrollLeft;
    });
    expect(scrolled).toBeGreaterThan(0);
    const button = await row
      .locator('[data-slot="details-button"]')
      .elementHandle();
    await button.focus();
    const selected = await row
      .locator(".pipeline-source-meta > div")
      .first()
      .evaluate((node) => {
        getSelection().selectAllChildren(node);
        return getSelection().toString();
      });
    expect(selected).not.toBe("");
    return { container, scrolled, button, selected };
  }

  async function stillSettled(page, row, { container, scrolled, button, selected }) {
    expect(await container.evaluate((node) => node.isConnected)).toBe(true);
    expect(await container.evaluate((node) => node.scrollLeft)).toBe(scrolled);
    expect(
      await button.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await expect(row.locator('[data-slot="details-button"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(row.locator('[data-slot="details"]')).toBeVisible();
    expect(await page.evaluate(() => getSelection().toString())).toBe(selected);
  }

  test("a countdown tick", async ({ page }) => {
    const row = await openPipeline(page, (payload) =>
      withRecentRun(payload, 20 * 60 * 1000),
    );
    const settled = await settleIn(page, row);
    // the 3d horizon is the one the current run is still working on
    const duration = row
      .locator(".pipeline-row-details .table-container")
      .first()
      .locator("tbody tr:last-child td")
      .nth(6);
    const before = await duration.textContent();
    expect(before).toMatch(/^\d+m \d+s$/);

    await page.clock.runFor(1000);

    await expect(duration).not.toHaveText(before);
    await stillSettled(page, row, settled);
  });

  test("a poll that brings new data", async ({ page }) => {
    const row = await openPipeline(page, (payload, served) => {
      if (served > 1) payload.groups[0].label = "NOAA GFS forecast · refreshed";
      return payload;
    });
    const settled = await settleIn(page, row);

    await page.clock.runFor(15_000);

    // the second response was rendered, not just requested
    await expect(page.locator(".pipeline-group h3").first()).toHaveText(
      "NOAA GFS forecast · refreshed",
    );
    await stillSettled(page, row, settled);
  });

  // the facet table comes and goes with the run that is showing: a run that
  // has reported no facets yet, then does, must not hand the lead table a new
  // scroll box
  test("a poll whose run starts reporting facets", async ({ page }) => {
    const row = await openPipeline(page, (payload, served) => {
      if (served === 1) {
        const product = payload.groups[0].products[0];
        for (const init of product.recent_inits) delete init.facets;
      }
      return payload;
    });
    await expect(row.locator(".pipeline-row-details table")).toHaveCount(0);
    const settled = await settleIn(page, row);
    await expect(row.locator(".pipeline-row-details table")).toHaveCount(1);

    await page.clock.runFor(15_000);

    await expect(row.locator(".pipeline-row-details table")).toHaveCount(2);
    // the held box is still the one the lead table scrolls in
    expect(
      await settled.container.evaluate((node) =>
        node.contains(node.parentNode.querySelector("table:not(.pipeline-facets)")),
      ),
    ).toBe(true);
    await stillSettled(page, row, settled);
  });

  // the window rolls forward one run per cadence; every run still in it keeps
  // its squares — in the lead grid, and in the facet grid even for the run
  // that moves from the newer lane up into the older one
  test("a poll that rolls the window forward", async ({ page }) => {
    const roll = (payload) => {
      const product = payload.groups[0].products[0];
      const [, ...rest] = product.recent_inits;
      const newest = structuredClone(rest.at(-1));
      newest.init_time = new Date(
        Date.parse(newest.init_time) + 6 * 3600 * 1000,
      ).toISOString();
      newest.status = "pending";
      product.recent_inits = [...rest, newest];
      return payload;
    };
    // each poll rolls one run further than the one before it
    const row = await openPipeline(page, (payload, served) => {
      for (let turn = 1; turn < served; turn += 1) roll(payload);
      return payload;
    });
    const running = FIXTURE.groups[0].products[0].recent_inits.findLast(
      (init) => init.status === "in_flight",
    ).init_time;
    const square = (lane) =>
      row
        .locator(`${lane} .pipeline-cell[data-init-time="${running}"]`)
        .first()
        .elementHandle();
    const labels = () => row.locator(".pipeline-run-label").allTextContents();

    const leadCell = await square(".pipeline-field");
    const before = await labels();
    await page.clock.runFor(15_000);
    // the window moved on, and the held square is the same node
    await expect.poll(labels).not.toEqual(before);
    expect(await leadCell.evaluate((node) => node.isConnected)).toBe(true);

    await row.locator(".pipeline-viz").click();
    await expect(row).toHaveAttribute("data-view", "1");
    const facetCell = await square('.pipeline-clump[data-lane="1"]');
    // the run that opens the newer lane is the one the next roll moves up:
    // hold one of its squares, not just a container
    const crossingInit = await row
      .locator('.pipeline-run-head[data-lane="1"]')
      .first()
      .getAttribute("data-init-time");
    const crossing = await row
      .locator(`.pipeline-clump[data-facet][data-init-time="${crossingInit}"] .pipeline-cell`)
      .first()
      .elementHandle();
    const between = await labels();
    await page.clock.runFor(15_000);
    await expect.poll(labels).not.toEqual(between);
    expect(await facetCell.evaluate((node) => node.isConnected)).toBe(true);
    expect(await crossing.evaluate((node) => node.isConnected)).toBe(true);
    expect(
      await crossing.evaluate((node) => node.parentNode.dataset.lane),
    ).toBe("0");
    await expect(
      row.locator('.pipeline-run-head[data-lane="0"]').last(),
    ).toHaveAttribute("data-init-time", crossingInit);
  });

  // the run count is fitted to the measured row body, which is watched by a
  // ResizeObserver: the body alone gets narrower here, with no window resize
  // for a resize listener to hear
  test("a column that changes width re-fits the runs", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = await openPipeline(page);
    const before = await row.locator(".pipeline-run-label").count();
    expect(before).toBeGreaterThan(3);

    await row
      .locator(".pipeline-row-body")
      .evaluate((node) => {
        node.style.maxWidth = "240px";
      });

    await expect
      .poll(() => row.locator(".pipeline-run-label").count())
      .toBeLessThan(before);
    expect((await bandGeometry(row)).overflowsColumn).toBe(false);
  });

  // a view that the payload stops offering and later offers again does not
  // reappear on its own: the row stays on the grid it fell back to, and it
  // falls back the way the old page did — from the view it showed, not from
  // however many times the field was clicked to get there
  test("a poll that takes a view away and one that brings it back", async ({
    page,
  }) => {
    const row = await openPipeline(page, (payload, served) => {
      if (served === 2) {
        // only the member dimension goes; component stays, so two views remain
        const product = payload.groups[0].products[0];
        for (const init of product.recent_inits) {
          for (const group of init.lead_groups ?? []) {
            group.facets = group.facets?.filter(
              (facet) => facet.dimension !== "member",
            );
          }
        }
      }
      return payload;
    });
    // five clicks through three views: one full turn and then two more
    for (let click = 0; click < 5; click += 1) {
      await row.locator(".pipeline-viz").click();
    }
    await expect(row).toHaveAttribute("data-view", "2");

    await page.clock.runFor(15_000);
    await expect(row).toHaveAttribute("data-view", "0");
    await expect(row.locator(".pipeline-viz")).toHaveAttribute(
      "aria-label",
      /activate for component$/,
    );

    await page.clock.runFor(15_000);
    await expect(row).toHaveAttribute("data-view", "0");
    await expect(row.locator(".pipeline-viz")).toHaveAttribute(
      "aria-label",
      /activate for component$/,
    );
  });

  test("a poll that adds a product above an expanded one", async ({ page }) => {
    await openPipeline(page, (payload, served) => {
      if (served > 1) {
        const [group] = payload.groups;
        const twin = structuredClone(group.products[0]);
        twin.id = "external-noaa-gfs-twin";
        twin.row_label = "twin";
        group.products.unshift(twin);
      }
      return payload;
    });
    // by id, not position: the point is that this row is about to move
    const row = page.locator('.pipeline-row[data-product-id="external-noaa-gfs-aws"]');
    const settled = await settleIn(page, row);

    await page.clock.runFor(15_000);

    await expect(page.locator(".pipeline-row").first()).toHaveAttribute(
      "data-product-id",
      "external-noaa-gfs-twin",
    );
    // the row moved down a slot; it is the same row, in the same state
    await stillSettled(page, row, settled);
    await expect(
      page.locator(".pipeline-row").first().locator('[data-slot="details"]'),
    ).toBeHidden();
  });
});

// A product too new for a statistical delayed threshold publishes no timing at
// all; the state line says why rather than reading as if the run were on time.
test("a product without enough history says so instead of a timing", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    product.timing_baseline = {
      status: "insufficient_history",
      history_days: 23,
      required_history_days: 30,
    };
    const running = product.recent_inits.findLast(
      (init) => init.status === "in_flight",
    );
    delete running.timing;
    for (const group of running.lead_groups ?? []) delete group.timing;
    return payload;
  });

  const state = row.locator('[data-slot="eta-state"]');
  await expect(state).toHaveText(
    "processing · insufficient history (23/30 days)",
  );
  await expect(state).not.toHaveAttribute("data-timing");
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
