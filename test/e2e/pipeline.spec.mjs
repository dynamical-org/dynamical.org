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
  // what the first row was served, for the chart alignment check to read
  await page.addInitScript(() => {
    window.__pipelineInits = {};
  });
  await page.route("**/dashboard.json", async (route) => {
    served += 1;
    const payload = mutate(structuredClone(FIXTURE), served);
    await page.evaluate((inits) => {
      window.__pipelineInits = Object.fromEntries(inits.map((init) => [init.init_time, init]));
    }, payload.groups[0].products[0].recent_inits ?? []).catch(() => {});
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
      ".pipeline-row-details .table-container:first-of-type thead tr:first-child th",
    )
    .allTextContents();

  expect(headings[0]).toBe("horizon");
  expect(headings[1]).toMatch(/^last run(?: · |$)/);
  expect(headings[2]).toMatch(/^(?:current|upcoming) run(?: · |$)/);
  expect(headings[3]).toMatch(/^time after init · [\d,]+ samples$/);
  // the run columns name the same reference point the stats do
  const subheadings = await row
    .locator(
      ".pipeline-row-details .table-container:first-of-type thead tr:last-child th",
    )
    .allTextContents();
  expect(subheadings).toEqual([
    "status",
    "time",
    "after init",
    "status",
    "time",
    "after init",
    "p50",
    "p95",
    "p99",
    "delayed past",
  ]);
});

test("a dynamical row reports its lag after the source beneath its time after init", async ({
  page,
}) => {
  await openPipeline(page);
  const row = page.locator(
    '.pipeline-row[data-product-id="noaa-gfs-forecast-virtual"]',
  );
  await expect(row.locator("strong").first()).toHaveText("dynamical.org");
  await row.locator('[data-slot="details-button"]').click();
  const tables = row.locator(".pipeline-row-details .table-container");
  await expect(tables).toHaveCount(2);

  // the lead table reads like any other row's, note included
  const lead = tables.first();
  await expect(lead.locator("thead tr:first-child th").nth(3)).toHaveText(
    "time after init · 24 samples · insufficient history (24/30 days)",
  );
  await expect(lead.locator("thead tr:last-child th").nth(2)).toHaveText(
    "after init",
  );
  await expect(lead.locator("tbody tr:first-child td").nth(3)).toHaveText(
    "1h 40m",
  );

  // the lag is one row under the same run headers, with its own sample
  const lag = tables.nth(1);
  await expect(lag.locator("thead tr:first-child th")).toHaveText(
    "lag after source · 8 recent samples",
  );
  const heads = lag.locator("thead tr:last-child th");
  await expect(heads.nth(0)).toHaveText(/^last run · /);
  await expect(heads.nth(1)).toHaveText("p50");
  const cells = lag.locator("tbody tr td");
  await expect(cells).toHaveCount(4);
  await expect(cells.nth(0)).toHaveText("5m");
  await expect(cells.nth(1)).toHaveText("9m");
  await expect(cells.nth(2)).toHaveText("12m");
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

// The run chart is the one place the delayed threshold is drawn, and "visible"
// is a geometric claim: the line has to be there, labelled with its value, and
// the run judged delayed has to sit above it. The fixture's running init is
// hours old, so the payload is shifted to make it an hour old — an elapsed
// marker of forty-seven days would flatten every landed run, and an hour is
// past the 1d group's cutoff, so the run's bubbled delay is a state it can be in.
test("details open on a run chart with the delayed threshold drawn", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) =>
    withRecentRun(payload, 60 * 60 * 1000),
  );
  await row.locator('[data-slot="details-button"]').click();
  const chart = row.locator(".pipeline-row-details .pipeline-runs");
  await expect(chart.locator("svg")).toBeVisible();

  // a horizontal line has no height, so to Playwright it is never "visible";
  // its label is, and the geometry below checks the line itself
  await expect(chart.locator('[data-threshold="run"] line')).toHaveCount(1);
  await expect(chart.locator('[data-threshold="run"] text')).toBeVisible();
  await expect(chart.locator('[data-threshold="run"] text')).toHaveText(
    "delayed past 2h",
  );
  // the chart carries no caption: the line's label is its only legend
  await expect(chart.locator("figcaption")).toHaveCount(0);

  const geometry = await chart.evaluate((node) => {
    const at = (selector) => [...node.querySelectorAll(selector)];
    const lineY = +node.querySelector('[data-threshold="run"] line').getAttribute("y1");
    const cy = (circle) => +circle.getAttribute("cy");
    const svg = node.querySelector("svg").getBoundingClientRect();
    return {
      lineY,
      delayed: at('circle[data-status="complete"][data-timing="delayed"]').map(cy),
      onTime: at('circle[data-status="complete"][data-timing="on_time"]').map(cy),
      elapsed: at("circle[data-elapsed]").map((circle) => ({
        status: circle.getAttribute("data-status"),
        timing: circle.getAttribute("data-timing"),
        hollow: getComputedStyle(circle).fill,
        stroke: getComputedStyle(circle).strokeWidth,
      })),
      landedFill: getComputedStyle(
        node.querySelector('circle[data-timing="delayed"]:not([data-elapsed])'),
      ).fill,
      onTimeFill: getComputedStyle(node.querySelector('circle[data-timing="on_time"]')).fill,
      radii: {
        onTime: +node.querySelector('circle[data-timing="on_time"]').getAttribute("r"),
        delayed: +node.querySelector('circle[data-timing="delayed"]').getAttribute("r"),
      },
      keyMarks: [...node.querySelectorAll("li")].map((li) => {
        const mark = getComputedStyle(li, "::before");
        return { text: li.textContent, fill: mark.backgroundColor, ring: mark.borderTopColor };
      }),
      lineColor: getComputedStyle(node.querySelector('[data-threshold="run"] line')).stroke,
      fits: svg.width <= node.getBoundingClientRect().width + 0.5,
      pageFits:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  });
  // one run landed late, above the line; every on-time run below it — and
  // every shown run with a time is one or the other, or the run in flight
  const shown = await chartAlignment(row);
  expect(geometry.delayed).toHaveLength(1);
  expect(geometry.delayed[0]).toBeLessThan(geometry.lineY);
  expect(geometry.onTime).toHaveLength(shown.circles.length - 2);
  expect(geometry.onTime.length).toBeGreaterThanOrEqual(1);
  for (const y of geometry.onTime) expect(y).toBeGreaterThan(geometry.lineY);
  // the running init is hollow, and reads in the amber its cell reads in
  expect(geometry.elapsed).toEqual([
    // and, being only a ring, carries the delayed mark's heavier stroke
    { status: "in_flight", timing: "delayed", hollow: "rgb(255, 255, 255)", stroke: "2px" },
  ]);
  expect(geometry.landedFill).toBe("rgb(244, 185, 66)");
  // the line is a reference, not a verdict: muted, so amber on the chart is
  // only ever a run judged delayed
  expect(geometry.lineColor).toBe("rgb(102, 102, 102)");
  // amber is the chart's one color; an on-time run is ink, and a delayed one
  // is larger as well, so the verdict does not rest on color alone
  expect(geometry.onTimeFill).toBe("rgb(17, 17, 17)");
  expect(geometry.radii.delayed).toBeGreaterThan(geometry.radii.onTime);
  // the key names the marks drawn, each glyph drawn as its mark is: the
  // landed delayed run filled, the delayed run in flight hollow
  expect(geometry.keyMarks).toEqual([
    { text: "complete", fill: "rgb(17, 17, 17)", ring: "rgb(17, 17, 17)" },
    { text: "not yet complete: time so far", fill: "rgba(0, 0, 0, 0)", ring: "rgb(17, 17, 17)" },
    { text: "judged delayed", fill: "rgb(244, 185, 66)", ring: "rgb(244, 185, 66)" },
    { text: "judged delayed, not yet complete", fill: "rgba(0, 0, 0, 0)", ring: "rgb(244, 185, 66)" },
  ]);
  // a screen reader hears which runs were judged delayed, not only the color
  await expect(chart.locator("svg")).toHaveAttribute("aria-label", /2 judged delayed/);
  expect(geometry.fits).toBe(true);
  expect(geometry.pageFits).toBe(true);

  // the lead table names each group's own cutoff beside its percentiles
  const thresholds = row.locator(
    ".pipeline-row-details .table-container:first-of-type tbody tr td:last-child",
  );
  await expect(thresholds).toHaveText(["35m", "55m", "2h"]);
});

test("a product without a delayed threshold draws its runs and no line", async ({
  page,
}) => {
  await openPipeline(page);
  const row = page.locator(
    '.pipeline-row[data-product-id="noaa-gfs-forecast-virtual"]',
  );
  await row.locator('[data-slot="details-button"]').click();
  const chart = row.locator(".pipeline-row-details .pipeline-runs");
  await expect(chart.locator("svg")).toHaveCount(1);
  expectAligned(await chartAlignment(row));
  await expect(chart.locator("[data-threshold]")).toHaveCount(0);
  await expect(chart.locator("figcaption")).toHaveCount(0);
  await expect(
    row.locator(
      ".pipeline-row-details .table-container:first-of-type tbody td:last-child",
    ),
  ).toHaveText(["—"]);
  // no verdicts, so no color: every run is ink rather than a grey that reads
  // as a third kind of run, and the key says why there is no line
  await expect(chart.locator("li")).toHaveText([
    "no delayed threshold yet: 24 of 30 days with a completed run",
  ]);
  const fills = () =>
    chart.evaluate((node) => [
      ...new Set([...node.querySelectorAll("circle")].map((c) => getComputedStyle(c).fill)),
    ]);
  expect(await fills()).toEqual(["rgb(17, 17, 17)"]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await fills()).toEqual(["rgb(232, 232, 234)"]);
});

// The committed fixture's running init is weeks old by now, which is what a
// stalled feed looks like — and what the preview build reads from staging.
// A run that far past the landed ones is parked at the top edge with its time
// written beside it in words, so the landed runs keep the plot.
test("a run in flight for weeks is parked at the top with its time written", async ({ page }) => {
  const row = await openPipeline(page);
  await row.locator('[data-slot="details-button"]').click();
  const chart = row.locator(".pipeline-row-details .pipeline-runs");
  const geometry = await chart.evaluate((node) => {
    const cy = (circle) => +circle.getAttribute("cy");
    const parked = node.querySelector("circle[data-pinned]");
    const svg = node.querySelector("svg").getBoundingClientRect();
    const label = node.querySelector("svg text[data-pinned]");
    return {
      parked: parked && {
        cy: cy(parked),
        dash: getComputedStyle(parked).strokeDasharray,
      },
      label: label && {
        text: label.textContent,
        left: label.getBoundingClientRect().left,
        right: label.getBoundingClientRect().right,
      },
      // the title is the plot's first text
      titleRight: node.querySelector("svg text").getBoundingClientRect().right,
      svgRight: svg.right,
      lineY: +node.querySelector('[data-threshold="run"] line').getAttribute("y1"),
      delayed: [...node.querySelectorAll('circle[data-timing="delayed"]:not([data-elapsed])')].map(cy),
      onTime: [...node.querySelectorAll('circle[data-timing="on_time"]')].map(cy),
      baselineY: +node.querySelector('line[data-axis="x"]').getAttribute("y1"),
      ticks: [...node.querySelectorAll('[data-axis="y"] text')].map((t) => t.textContent),
    };
  });
  expect(geometry.parked).not.toBeNull();
  // a hollow ring like any run still arriving, no dash; its words say the rest
  expect(geometry.parked.dash).toBe("none");
  expect(geometry.label.text).toMatch(/^\d+d so far ↑$/);
  expect(geometry.label.right).toBeLessThanOrEqual(geometry.svgRight + 0.5);
  // the words sit clear of the title they share a row with
  expect(geometry.label.left).toBeGreaterThanOrEqual(geometry.titleRight);
  // and a screen reader hears the run's time and that it is off the scale
  await expect(chart.locator("svg")).toHaveAttribute(
    "aria-label",
    /not yet complete and above the chart's range: .*\d+d so far/,
  );
  // the landed runs still spread beneath it, either side of the line and
  // well off the floor, on an axis at their own scale
  for (const y of [...geometry.delayed, ...geometry.onTime]) {
    expect(y).toBeGreaterThan(geometry.parked.cy);
  }
  expect(geometry.delayed[0]).toBeLessThan(geometry.lineY);
  for (const y of geometry.onTime) {
    expect(y).toBeGreaterThan(geometry.lineY);
    expect(geometry.baselineY - y).toBeGreaterThan(10);
  }
  expect(geometry.ticks).not.toContain("0s");
  expect(geometry.ticks.some((tick) => /d$/.test(tick))).toBe(false);
  // and the key names no special mark: the label is its own explanation
  await expect(chart.locator("li")).not.toContainText(["dashed"]);
});

// Words in the title row would collide when two runs are parked, or when the
// plot is too narrow to fit them beside the title; each parked run is then
// named under the chart by its init, and nothing is written over the title.
test("parked runs that cannot be labelled beside the title are named under the chart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  for (const [name, mutate] of [
    [
      "two parked runs",
      (payload) => {
        const failed = payload.groups[0].products[0].recent_inits.at(-2);
        failed.status = "in_flight";
        failed.timing = null;
        delete failed.latency_s;
        return payload;
      },
    ],
    [
      "a two-run plot",
      (payload) => {
        const product = payload.groups[0].products[0];
        product.recent_inits = product.recent_inits.slice(-2);
        return payload;
      },
    ],
  ]) {
    // the aligned chart, and the chart across the row an arrival-group view draws
    for (const view of [0, 1]) {
      const label = `${name}, view ${view}`;
      const row = await openPipeline(page, mutate);
      if (view) await row.locator(".pipeline-viz").click();
      await row.locator('[data-slot="details-button"]').click();
      const chart = row.locator(".pipeline-row-details .pipeline-runs");
      await expect(chart.locator("circle[data-pinned]").first(), label).toBeVisible();
      const inRow = await chart.locator("svg text[data-pinned]").count();
      const keyLine = chart.locator("li").filter({ hasText: "above the chart:" });
      // every parked run is named once: in the title row when it is alone and
      // fits, otherwise under the chart
      if (name === "two parked runs") expect(inRow, label).toBe(0);
      if (inRow) {
        await expect(keyLine, label).toHaveCount(0);
      } else {
        await expect(keyLine, label).toHaveCount(1);
        await expect(keyLine, label).toContainText(/\d+d so far/);
      }
      // no piece of the plot's text (the title, ticks, the threshold label and
      // any parked words) overlaps another, and no parked ring sits on one; the
      // row chart's init tiers are the axis's own business
      const overlaps = await chart.evaluate((node) => {
        const meet = (a, b) =>
          a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const texts = [...node.querySelectorAll("svg text")]
          .filter((text) => !text.closest('[data-axis="x"]'))
          .map((text) => text.getBoundingClientRect());
        const rings = [...node.querySelectorAll("circle[data-pinned]")].map((circle) =>
          circle.getBoundingClientRect(),
        );
        return [
          ...texts.flatMap((a, i) => texts.slice(i + 1).filter((b) => meet(a, b))),
          ...rings.flatMap((ring) => texts.filter((text) => meet(ring, text))),
        ].length;
      });
      expect(overlaps, label).toBe(0);
      await expect(chart.locator("svg"), label).toHaveAttribute("aria-label", /above the chart's range/);
    }
  }
});

// What production renders until wxopticon's projection carries the field: an
// established baseline with no threshold published.
test("a feed that omits the threshold draws its runs and no line", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    delete product.latency_stats.delayed_threshold_s;
    for (const stats of product.lead_group_stats) delete stats.delayed_threshold_s;
    return withRecentRun(payload, 60 * 60 * 1000);
  });
  await row.locator('[data-slot="details-button"]').click();
  const chart = row.locator(".pipeline-row-details .pipeline-runs");
  // every run the field shows but the failed one
  const shown = await chartAlignment(row);
  expect(shown.circles).toHaveLength(shown.displayed - 1);
  await expect(chart.locator("[data-threshold]")).toHaveCount(0);
  await expect(chart.locator("figcaption")).toHaveCount(0);
  await expect(
    row.locator(
      ".pipeline-row-details .table-container:first-of-type tbody tr td:last-child",
    ),
  ).toHaveText(["—", "—", "—"]);
});

test("a manual threshold is drawn like any other", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) => {
    payload.groups[0].products[0].timing_baseline.method = "manual";
    return withRecentRun(payload, 60 * 60 * 1000);
  });
  await row.locator('[data-slot="details-button"]').click();
  const chart = row.locator(".pipeline-row-details .pipeline-runs");
  await expect(chart.locator('[data-threshold="run"] text')).toHaveText(
    "delayed past 2h",
  );
  await expect(chart.locator("figcaption")).toHaveCount(0);
});

/** How the chart under a row's lead-group field lines up with it: each point
 * against the column of its run in the field (its first square), and each
 * repeated init label against the field's own. */
function chartAlignment(row) {
  return row.evaluate((node) => {
    const field = node.querySelector(".pipeline-field");
    const figure = node.querySelector(".pipeline-runs");
    const center = (element) => {
      const box = element.getBoundingClientRect();
      return box.left + box.width / 2;
    };
    const columnOf = (init) =>
      field.querySelector(`.pipeline-cell[data-init-time="${init}"]`);
    const labels = (root, selector) =>
      [...root.querySelectorAll(selector)].map((label) => ({
        text: label.textContent,
        x: Math.round(center(label) * 10) / 10,
      }));
    const boxes = [...figure.querySelectorAll("svg text")].map((text) => ({
      text: text.textContent,
      box: text.getBoundingClientRect(),
    }));
    return {
      displayed: new Set(
        [...field.querySelectorAll("[data-init-time]")].map((e) => e.dataset.initTime),
      ).size,
      failed: [...field.querySelectorAll(".pipeline-cell.g-failed")].map(
        (cell) => cell.dataset.initTime,
      ),
      // which shown runs the chart owes a point: those with a completion time
      // or still arriving, read from the feed the page was served
      plottable: [
        ...new Set([...field.querySelectorAll("[data-init-time]")].map((e) => e.dataset.initTime)),
      ].filter((init) => {
        const run = window.__pipelineInits?.[init];
        return run && (run.status === "pending" || run.status === "in_flight" || Number.isFinite(run.latency_s));
      }),
      circles: [...figure.querySelectorAll("circle")].map((circle) => ({
        init: circle.dataset.initTime,
        dx: center(circle) - center(columnOf(circle.dataset.initTime)),
      })),
      fieldLabels: labels(field, ".pipeline-run-label"),
      chartLabels: labels(figure, ".pipeline-run-label"),
      fieldDates: labels(field, ".pipeline-run-date"),
      chartDates: labels(figure, ".pipeline-run-date"),
      // no two pieces of text in a plot may overlap
      textOverlaps: boxes.flatMap((a, i) =>
        boxes.slice(i + 1).filter(
          (b) =>
            a.box.left < b.box.right && a.box.right > b.box.left &&
            a.box.top < b.box.bottom && a.box.bottom > b.box.top,
        ).map((b) => `"${a.text}" and "${b.text}"`),
      ),
      labelCount: boxes.length,
      thresholdY: figure.querySelector("[data-threshold] text")?.getAttribute("y"),
      // a tick label inside the plot must not sit on a point
      coveredPoints: [...figure.querySelectorAll('[data-axis="y"] text')].filter((text) => {
        const box = text.getBoundingClientRect();
        return [...figure.querySelectorAll("circle")].some((circle) => {
          const dot = circle.getBoundingClientRect();
          return dot.left < box.right && dot.right > box.left && dot.top < box.bottom && dot.bottom > box.top;
        });
      }).length,
      insideLabels:
        figure.querySelectorAll("svg text[text-anchor]").length > 0 &&
        [...figure.querySelectorAll("svg text[text-anchor]")].every(
          (text) => text.getBoundingClientRect().right <= text.closest("svg").getBoundingClientRect().right + 0.5,
        ),
      pageFits:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  });
}

function expectAligned(alignment) {
  // every shown run with a time has a point, and each sits under its square
  expect(alignment.circles.map((c) => c.init).sort()).toEqual(alignment.plottable.sort());
  for (const circle of alignment.circles) {
    expect(Math.abs(circle.dx), `${circle.init} sits under its square`).toBeLessThanOrEqual(1);
  }
  for (const tier of ["Labels", "Dates"]) {
    const chart = alignment[`chart${tier}`];
    const field = alignment[`field${tier}`];
    expect(chart.map((l) => l.text)).toEqual(field.map((l) => l.text));
    chart.forEach((label, index) => {
      expect(Math.abs(label.x - field[index].x), `"${label.text}" under its column`).toBeLessThanOrEqual(1);
    });
  }
  expect(alignment.textOverlaps).toEqual([]);
  expect(alignment.coveredPoints).toBe(0);
  expect(alignment.pageFits).toBe(true);
}

// The chart draws the runs the field shows, one column each, under the
// field's own columns: a run without a time keeps its column empty rather
// than shifting the runs after it, and a missing init closes up in both.
test("the run chart shares the field's columns and repeats its init axis", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    // a landed run with no time in the middle of the window, and an init gone
    // from it altogether
    const landed = product.recent_inits.filter((init) => init.status === "complete");
    delete landed.at(-2).latency_s;
    product.recent_inits.splice(product.recent_inits.indexOf(landed.at(-4)), 1);
    return withRecentRun(payload, 60 * 60 * 1000);
  });
  await row.locator('[data-slot="details-button"]').click();
  await expect(row.locator(".pipeline-runs svg")).toHaveCount(1);
  const alignment = await chartAlignment(row);
  expectAligned(alignment);
  // the failed run and the run with no time have no point; every other shown run does
  expect(alignment.failed).toHaveLength(1);
  expect(alignment.circles).toHaveLength(alignment.displayed - 2);
  expect(alignment.circles.map((c) => c.init)).not.toContain(alignment.failed[0]);
  expect(alignment.labelCount).toBeGreaterThanOrEqual(3);
  // the plot fills most of its column, so the labels sit inside it
  expect(alignment.insideLabels).toBe(true);

  // enlarged text keeps the chart on its columns and its labels apart: the
  // plot's band and the field's share their gutter and gap, and the labels
  // are laid out in the chart's own em
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  // the chart lays its labels out for the size it reads on its next tick
  await expect
    .poll(async () => (await chartAlignment(row)).thresholdY)
    .not.toBe(alignment.thresholdY);
  expectAligned(await chartAlignment(row));
});

// An arrival-group view lays its runs in two lanes, which no single plot can
// sit under; there the chart stays as it was, across the whole row on a
// proportional time axis, with every run the payload carries.
test("in an arrival-group view the chart draws every run across the row", async ({
  page,
}) => {
  const row = await openPipeline(page, (payload) =>
    withRecentRun(payload, 60 * 60 * 1000),
  );
  await row.locator(".pipeline-viz").click();
  await expect(row).toHaveAttribute("data-view", "1");
  await row.locator('[data-slot="details-button"]').click();
  const chart = row.locator(".pipeline-row-details .pipeline-runs");
  await expect(chart.locator("svg")).toHaveCount(1);
  await expect(chart).not.toHaveAttribute("data-aligned", "");
  // nine of the payload's ten runs have a time; the axis is the chart's own
  await expect(chart.locator("circle")).toHaveCount(9);
  await expect(chart.locator('[data-axis="x"] text').first()).toBeVisible();
  await expect(chart.locator(".pipeline-run-label")).toHaveCount(0);
  const geometry = await row.evaluate((node) => ({
    chart: node.querySelector(".pipeline-runs svg").getBoundingClientRect(),
    details: node.querySelector(".pipeline-row-details").getBoundingClientRect(),
    field: node.querySelector(".pipeline-field").getBoundingClientRect(),
  }));
  expect(Math.abs(geometry.chart.left - geometry.details.left)).toBeLessThanOrEqual(1);
  expect(geometry.chart.width).toBeGreaterThan(geometry.field.width);

  // round to the lead view, and the chart lines up with the field again
  while ((await row.getAttribute("data-view")) !== "0") {
    await row.locator(".pipeline-viz").click();
  }
  await expect(chart).toHaveAttribute("data-aligned", "");
  expectAligned(await chartAlignment(row));
});

// An init column is as wide as its label, and the label's width is the
// zone's: "06z" in UTC, "06 CDT" in Chicago. How many runs fit, and so
// whether the plot leaves room beside it, follows — so the cases that turn
// on it are pinned to a zone with a letter abbreviation.
test.describe("in a zone with a letter abbreviation", () => {
  test.use({ timezoneId: "America/Chicago", locale: "en-US" });

  // A column of another width shows another number of runs, and the chart
  // follows the field: at 1280px the row's column holds fewer than the ten
  // runs the payload carries; a single-column layout holds them all.
  test("a column that changes width re-fits the chart with the field", async ({
    page,
  }) => {
    const row = await openPipeline(page, (payload) =>
      withRecentRun(payload, 60 * 60 * 1000),
    );
    await row.locator('[data-slot="details-button"]').click();
    await expect(row.locator(".pipeline-runs svg")).toHaveCount(1);
    const alignment = await chartAlignment(row);
    expectAligned(alignment);
    expect(alignment.displayed).toBeLessThan(10);

    await page.setViewportSize({ width: 700, height: 900 });
    await expect.poll(async () => (await chartAlignment(row)).displayed).toBe(10);
    expectAligned(await chartAlignment(row));
  });

  // On a phone the field fills the column, so there is no room beside the
  // plot for its labels: they move inside it rather than off the page.
  test("on a phone the chart's labels sit inside the plot and the page does not scroll sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 520, height: 900 });
    const row = await openPipeline(page, (payload) =>
      withRecentRun(payload, 60 * 60 * 1000),
    );
    await row.locator('[data-slot="details-button"]').click();
    await expect(row.locator(".pipeline-runs svg")).toHaveCount(1);
    const alignment = await chartAlignment(row);
    expectAligned(alignment);
    expect(alignment.displayed).toBe(10);
    expect(alignment.insideLabels).toBe(true);
    await expect(row.locator('.pipeline-runs [data-threshold="run"] text')).toHaveText(
      "delayed past 2h",
    );
  });

  // A threshold far above the runs puts the lowest tick on the baseline, where
  // the oldest run sits: that tick label gives way to the point.
  test("a tick label inside the plot gives way to a point in its place", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    const row = await openPipeline(page, (payload) => {
      payload.groups[0].products[0].latency_stats.delayed_threshold_s = 12.5 * 3600;
      return withRecentRun(payload, 60 * 60 * 1000);
    });
    await row.locator('[data-slot="details-button"]').click();
    await expect(row.locator('.pipeline-runs [data-threshold="run"] text')).toHaveText(
      "delayed past 12h 30m",
    );
    const alignment = await chartAlignment(row);
    expectAligned(alignment);
    expect(alignment.insideLabels).toBe(true);
    // the gridlines are all there; the label the oldest run sits on is not, nor
    // the one the threshold label stands on
    await expect(row.locator('.pipeline-runs [data-axis="y"] line')).toHaveCount(5);
    await expect(row.locator('.pipeline-runs [data-axis="y"] text')).toHaveText(["3h", "6h", "9h"]);
  });
});

// With few runs the plot is a sliver, and the labels would not fit inside it:
// they hang off its right edge, in the room the column has to spare — where
// the title, wider than the plot, also is, so a top tick gives way to it.
test("with a run or two the chart's labels hang beside the plot", async ({ page }) => {
  const row = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    product.recent_inits = product.recent_inits.slice(-2);
    return withRecentRun(payload, 60 * 60 * 1000);
  });
  await row.locator('[data-slot="details-button"]').click();
  await expect(row.locator(".pipeline-runs circle")).toHaveCount(1);
  const alignment = await chartAlignment(row);
  expectAligned(alignment);
  expect(alignment.displayed).toBe(2);
  expect(alignment.insideLabels).toBe(false);

  // one landed run just under an hour and no line: the top tick lands where
  // the title is, and is not drawn there
  const lone = await openPipeline(page, (payload) => {
    const product = payload.groups[0].products[0];
    const landed = product.recent_inits.findLast((init) => init.status === "complete");
    landed.latency_s = 3585;
    product.recent_inits = [landed];
    delete product.latency_stats.delayed_threshold_s;
    return payload;
  });
  await lone.locator('[data-slot="details-button"]').click();
  await expect(lone.locator(".pipeline-runs circle")).toHaveCount(1);
  const single = await chartAlignment(lone);
  expectAligned(single);
  expect(single.insideLabels).toBe(false);
  const gridlines = await lone.locator('.pipeline-runs [data-axis="y"] line').count();
  expect(gridlines).toBeGreaterThanOrEqual(2);
  await expect(lone.locator('.pipeline-runs [data-axis="y"] text')).toHaveCount(gridlines - 1);
});

// A product whose runs all lack a completion time keeps the field's columns
// and init axis under an empty plot that says so, and gets its points when a
// poll brings a run with a time.
test("a product whose runs all lack a completion time draws an empty plot that says so", async ({
  page,
}) => {
  await page.clock.install();
  await openPipeline(page, (payload, served) => {
    const shifted = withRecentRun(payload, 20 * 60 * 1000);
    if (served === 1) {
      const product = shifted.groups[0].products[0];
      product.recent_inits = product.recent_inits
        .filter((init) => init.status === "complete")
        .map(({ latency_s, ...init }) => init);
      // and no line either, or the axis would be the line's
      delete product.latency_stats.delayed_threshold_s;
    }
    return shifted;
  });
  const row = page.locator(".pipeline-row").first();
  await row.locator('[data-slot="details-button"]').click();
  const figure = row.locator(".pipeline-runs");
  await expect(figure.locator("svg")).toHaveCount(1);
  await expect(figure.locator("circle")).toHaveCount(0);
  await expect(figure.locator("[data-axis='y'], [data-threshold]")).toHaveCount(0);
  await expect(figure.locator("svg")).toContainText("no completion time recorded");
  const empty = await chartAlignment(row);
  expect(empty.chartLabels.map((l) => l.text)).toEqual(empty.fieldLabels.map((l) => l.text));

  // the next poll brings runs with times, and the points with them
  await page.clock.runFor(15_000);
  await expect(figure.locator("circle").first()).toBeVisible();
  expectAligned(await chartAlignment(row));
});

// The figure exists only while the product has runs, and draws the runs the
// row's measured width fits. A product whose first run arrives by poll while
// its details are open must get its chart then — not on a later reopen.
test("a product that gains its first run while its details are open draws its chart", async ({
  page,
}) => {
  // a fake clock makes the poll happen on demand
  await page.clock.install();
  await openPipeline(page, (payload, served) => {
    const shifted = withRecentRun(payload, 20 * 60 * 1000);
    if (served === 1) shifted.groups[0].products[0].recent_inits = [];
    return shifted;
  });
  const row = page.locator(".pipeline-row").first();
  await row.locator('[data-slot="details-button"]').click();
  await expect(row.locator(".pipeline-row-details table")).toHaveCount(1);
  await expect(row.locator(".pipeline-runs")).toHaveCount(0);

  // the next poll brings the runs, and the chart with them: every run the
  // field shows but the failed one
  await page.clock.runFor(15_000);
  await expect(row.locator(".pipeline-runs svg")).toBeVisible();
  const alignment = await chartAlignment(row);
  expect(alignment.circles).toHaveLength(alignment.displayed - 1);
  expectAligned(alignment);
});
