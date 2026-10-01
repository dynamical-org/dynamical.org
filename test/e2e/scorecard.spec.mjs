import { expect, test } from "@playwright/test";

// Every scorecard chart is drawn in the browser from parquet files the site does
// not build: `statistics.parquet` for the metric charts and `asos-parquet` for
// the observation timeseries. Nothing in the Eleventy build reads those files, so
// a change on the publishing side — a renamed column, a dropped metric, a
// duration column switching from nanosecond to microsecond precision — cannot
// fail a build or a unit test. It just makes a query return no rows, and the page
// renders an empty-state box where a plot should be.
//
// These specs are the only thing that exercises the real chain end to end:
// template wiring → the CDN modules → DuckDB-WASM → the SQL and its unit
// arithmetic → Observable Plot. They assert a plot actually appeared, and report
// the empty/error text when one didn't, which names the failure directly.

// Must match the placeholder `showStatus` writes while a query is in flight; it
// is the one chart state that is not yet a verdict.
const LOADING_TEXT = "Loading…";

// A chart container holds a status <p> (loading, empty, or error) or a Plot
// figure/svg. Any status other than the loading placeholder is terminal — the
// render finished and put a message where the plot belongs — so waiting settles
// as soon as either a plot or a message appears, and a broken chart is reported
// in seconds with its own text rather than as "svg not found" after a timeout.
async function expectPlot(page, id) {
  const box = page.locator(`#${id}`);
  let state = "an empty container";

  await expect
    .poll(
      async () => {
        // One `evaluate` reading the container directly, rather than a
        // `locator("p").textContent()`: that auto-waits for a <p> to exist with
        // no timeout of its own, so an empty container — a chart whose module
        // never loaded, the case this ceiling exists for — hangs the very first
        // poll and burns the whole timeout instead of reporting in seconds.
        const seen = await box.evaluate((el) => ({
          plot: Boolean(el.querySelector("svg")),
          status: el.querySelector("p")?.textContent?.trim() || null,
        }));
        if (seen.plot) {
          state = "rendered a plot";
          return true;
        }
        state = seen.status || "an empty container";
        return Boolean(seen.status) && seen.status !== LOADING_TEXT;
      },
      {
        message: `#${id} never settled into a plot or a message`,
        // Charts normally settle in seconds; this ceiling only bounds the case
        // where a DuckDB query or a CDN range request hangs outright, which does
        // happen occasionally over this many sequential queries. `retries` in the
        // config covers it — a lower ceiling just makes the retry come sooner.
        timeout: 90_000,
        intervals: [500],
      },
    )
    .toBe(true);

  expect(state, `#${id} should have rendered a plot`).toBe("rendered a plot");
}

// `page.goto` resolves for a 404 as readily as for a 200, so a page that stops
// being generated — a station leaving the ASOS network, a state slug changing —
// would otherwise surface as an unexplained chart timeout on a 404 body rather
// than as the missing page it is.
async function gotoOk(page, path) {
  const response = await page.goto(path);
  expect(response?.status(), `${path} did not return 200`).toBe(200);
}

// A page that draws its charts but logs an exception is still broken — that is
// how the maps shipped an invalid `height="auto"` on their <svg> for months.
function collectPageErrors(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`uncaught: ${err.message}`));
  return errors;
}

const PAGES = [
  {
    name: "scorecard index",
    path: "/scorecard/",
    charts: ["temperature-chart", "precipitation-chart"],
  },
  {
    name: "state page",
    path: "/scorecard/us-state/wa/",
    charts: ["temperature-chart", "precipitation-chart"],
  },
  {
    // A station page is the only one with observation timeseries, so it is the
    // only place the asos-parquet queries get exercised. YKM is a long-lived
    // ASOS site; if it ever leaves the network this 404s rather than failing
    // quietly, which is the outcome we want.
    name: "station page",
    path: "/scorecard/station/YKM/",
    charts: [
      "temperature_2m-obs",
      "temperature_2m-score",
      "precipitation_surface-obs",
      "precipitation_surface-score",
    ],
  },
];

for (const { name, path, charts } of PAGES) {
  test(`${name} renders every chart`, async ({ page }) => {
    const errors = collectPageErrors(page);
    await gotoOk(page, path);

    for (const id of charts) await expectPlot(page, id);

    // The parquet names virtual products "…, virtual"; legendLabel drops that.
    const legends = await page.locator('[class*="-swatches"]').allTextContents();
    expect(legends.length, `${name} drew no legend`).toBeGreaterThan(0);
    expect(legends.join("\n")).not.toContain(", virtual");

    expect(errors, `${name} logged console errors`).toEqual([]);
  });
}

// A query that returns no rows is the failure mode that hid the 2026-07-19 units
// change for nine days: nothing throws, so Sentry's global handlers see nothing
// and the page just shows an empty-state box. `windowIsPublished` is what turns
// that into an alert, and it is only useful if it fires on real drift and stays
// silent otherwise — an alert that cries wolf on every offline station would be
// muted within a week. Both directions are checked here against live data.
test("an unpublished window is reported and says so, an empty station is not", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__sentryEvents = [];
    window.Sentry = {
      captureException: (error, hint) =>
        window.__sentryEvents.push({ message: error.message, hint }),
    };
  });
  await gotoOk(page, "/scorecard/station/YKM/");
  // Let the page finish its own charts first: the module and DuckDB are then warm
  // and the probe below is the only thing left to explain a captured event.
  await expectPlot(page, "temperature_2m-score");

  const result = await page.evaluate(async () => {
    // Import the exact specifier the page used, cache-busting query string and
    // all. A bare "/scorecard.js" is a different module key, so it would get a
    // second module instance with its own cold `_dbReady` — booting a second
    // DuckDB-WASM worker and leaving the page's warm one untouched, which is the
    // opposite of what the comment above is relying on.
    const spec = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((n) => n.includes("/scorecard.js"));
    const { renderMetric } = await import(spec ?? "/scorecard.js");
    const box = document.getElementById("temperature_2m-score");
    const events = () => window.__sentryEvents.map((e) => e.message);
    const shown = () => box.querySelector("p")?.textContent ?? "";

    // A window the pipeline does not publish stands in for a units change: the
    // query succeeds, matches nothing, and the day value is nowhere in the file.
    await renderMetric(box, {
      variable: "temperature_2m",
      metric: "RMSE",
      stationIds: ["YKM"],
      windowDays: 999,
    });
    const unknownWindow = { events: events(), message: shown() };

    // A station id that matches no rows at a window the file does hold is
    // ordinary absence, not drift.
    window.__sentryEvents = [];
    await renderMetric(box, {
      variable: "temperature_2m",
      metric: "RMSE",
      stationIds: ["NOSUCHSTATION"],
      windowDays: 180,
    });
    return { unknownWindow, emptyStation: { events: events(), message: shown() } };
  });

  expect(result.unknownWindow.events.join("\n")).toMatch(
    /holds no 999-day window/,
  );
  expect(
    result.emptyStation.events,
    "a station with no rows must not report drift",
  ).toEqual([]);

  // The two cases must not read alike. One is our bug and the other is an honest
  // gap in the data; the visible text is all a reader gets, and which window went
  // missing is detail for the Sentry event above rather than for the page.
  expect(result.unknownWindow.message).toBe(
    "There was an error loading this plot.",
  );
  expect(result.emptyStation.message).toBe(
    "No RMSE data for the last 180 days.",
  );
});

// The default view only proves one lookback window and one metric work. Both are
// user-driven inputs to the same WHERE clause — the window is compared against a
// duration column, so a units change can break some windows and not others, and
// each metric is matched by name against a column of strings the pipeline writes.
// Walking both selectors covers every combination the UI offers.
//
// This runs on a station page rather than the index: the queries are identical
// apart from a station filter, and filtering to one station keeps a dozen
// re-renders to a few seconds each instead of a full-file scan apiece.
test("station charts re-render for every window and metric option", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoOk(page, "/scorecard/station/YKM/");
  await expectPlot(page, "temperature_2m-score");

  const optionValues = (selector) =>
    page
      .locator(`${selector} option`)
      .evaluateAll((opts) => opts.map((o) => o.value));

  const windows = await optionValues("#temp-window");
  expect(windows.length, "no window options found").toBeGreaterThan(1);
  for (const days of windows) {
    await page.selectOption("#temp-window", days);
    await expectPlot(page, "temperature_2m-score");
  }

  const metrics = await optionValues("#temp-metric");
  expect(metrics.length, "no metric options found").toBeGreaterThan(1);
  for (const metric of metrics) {
    await page.selectOption("#temp-metric", metric);
    await expectPlot(page, "temperature_2m-score");
  }

  // Precipitation carries a different metric set than temperature, so its
  // options need walking too.
  const precipMetrics = await optionValues("#precip-metric");
  expect(precipMetrics.length, "no precip metric options found").toBeGreaterThan(1);
  for (const metric of precipMetrics) {
    await page.selectOption("#precip-metric", metric);
    await expectPlot(page, "precipitation_surface-score");
  }

  expect(errors, "station page logged console errors").toEqual([]);
});

// The station walk above filters to one station; the index charts average every
// station, so their data shape (which models reach which leads, how many bars a
// facet holds) is the one most readers see. This draws every chart the index
// offers, both variables × every metric × every window, at a desktop width and a
// phone width set before the page loads, so each width's first render counts too.
// One test per width and window keeps each within the per-test timeout and lets a
// retry repeat only the combination that failed.
//
// A plot alone doesn't prove the selected metric rendered: the container can
// still hold the previous metric's chart, and an axis with no bars is a plot too.
// So a chart only counts once its y-axis names the metric that was picked and it
// draws at least one bar, every one with a finite value in its title.
//
// renderMetric doesn't cancel a render it has superseded, so a slow earlier query
// can land on top of a later one. Each render is settled before the next starts,
// which keeps the chart on screen the one that was asked for.
//
// This runs against the dev server's origin, which the parquet's CORS allows; an
// origin the CORS rules leave out fails every chart and is not something this
// can see.
async function expectMetricPlot(page, id, label) {
  const box = page.locator(`#${id}`);
  let state = "an empty container";

  await expect
    .poll(
      async () => {
        const seen = await box.evaluate((el) => ({
          yLabel:
            el.querySelector('svg [aria-label="y-axis label"]')?.textContent?.trim() ??
            null,
          values: [...el.querySelectorAll('svg g[aria-label="bar"] rect title')].map(
            (t) => parseFloat(t.textContent.slice(t.textContent.lastIndexOf(": ") + 2)),
          ),
          status: el.querySelector("p")?.textContent?.trim() || null,
        }));
        if (seen.yLabel === label || seen.yLabel?.startsWith(`${label} [`)) {
          // Plot replaces the whole chart at once, so a labelled plot is final.
          state =
            seen.values.length === 0
              ? "a plot with no bars"
              : seen.values.every(Number.isFinite)
                ? "rendered a plot"
                : `a plot with a non-finite bar: ${seen.values.join(", ")}`;
          return true;
        }
        state = seen.status || `a plot labelled ${seen.yLabel}`;
        return Boolean(seen.status) && seen.status !== LOADING_TEXT;
      },
      { message: `#${id} never drew its ${label} plot`, timeout: 90_000, intervals: [500] },
    )
    .toBe(true);

  expect(state, `#${id} should have rendered its ${label} plot`).toBe("rendered a plot");
}

const SWEEP_WIDTHS = { desktop: 1280, phone: 390 };
const SWEEP_WINDOWS = ["180", "90", "30", "14", "7"];
const SWEEP_CHARTS = [
  ["#temp-metric", "temperature-chart"],
  ["#precip-metric", "precipitation-chart"],
];

for (const [device, width] of Object.entries(SWEEP_WIDTHS)) {
  for (const days of SWEEP_WINDOWS) {
    test(`scorecard index draws every metric at ${days} days on ${device}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors = collectPageErrors(page);
      await gotoOk(page, "/scorecard/");

      const windows = await page
        .locator("#window option")
        .evaluateAll((opts) => opts.map((o) => o.value));
      expect(windows, "the window options changed; update SWEEP_WINDOWS").toEqual(
        SWEEP_WINDOWS,
      );

      const charts = [];
      for (const [select, id] of SWEEP_CHARTS) {
        const options = await page
          .locator(`${select} option`)
          .evaluateAll((opts) =>
            opts.map((o) => ({ value: o.value, label: o.textContent, selected: o.selected })),
          );
        expect(options.length, `${select} offers no metrics`).toBeGreaterThan(0);
        charts.push({ select, id, options });
      }
      const settleDefaults = async () => {
        for (const { id, options } of charts) {
          await expectMetricPlot(page, id, options.find((o) => o.selected).label);
        }
      };

      // The page's own first render, at the default window.
      await settleDefaults();
      // Picking the default window again still fires a change and redraws both.
      await page.selectOption("#window", days);
      await settleDefaults();

      for (const { select, id, options } of charts) {
        for (const { value, label, selected } of options) {
          if (selected) continue;
          await test.step(value, async () => {
            await page.selectOption(select, value);
            await expectMetricPlot(page, id, label);
          });
        }
      }

      expect(errors, `${days} days on ${device} logged console errors`).toEqual([]);
    });
  }
}

// What "best" means for each direction, as a distance where smaller is better.
// Written out here rather than imported from scorecard.js, so a direction filed
// wrong there fails this spec instead of agreeing with it.
const DISTANCE = {
  RMSE: (v) => v,
  Bias: (v) => Math.abs(v),
  ETS: (v) => -v,
  FrequencyBias: (v) => Math.abs(v - 1),
};

// Each finite model's rank at one lead: 1 + how many score strictly better, so
// tied models share a rank and the next one skips past them.
function expectedRanks(rows, distance) {
  const finite = rows.filter((r) => Number.isFinite(r.value));
  return Object.fromEntries(
    finite.map((r) => [
      r.model,
      1 + finite.filter((o) => distance(o.value) < distance(r.value)).length,
    ]),
  );
}

// The legend badges a lead should show: every model ranked third or better.
const legendBadges = (ranks) =>
  Object.fromEntries(Object.entries(ranks).filter(([, rank]) => rank <= 3));

// A metric chart as drawn: the legend in order with each entry's color and rank
// badge, the visible caption, the announcement, the selection band, each lead's
// label and bars, read from the <title> each bar carries. `x` is a bar's place
// within its facet; screen positions are what the pointer is aimed at.
function readChart(page, id) {
  return page.locator(`#${id}`).evaluate((el) => {
    const svg = el.querySelector("figure > svg");
    const center = (node) => {
      const r = node.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, left: r.left, right: r.right };
    };
    const swatches = [...el.querySelectorAll("figure > div > span")];
    const band = svg.querySelector(":scope > rect");
    return {
      legend: swatches.map((s) => s.textContent.replace(/^\d+/, "").trim()),
      legendFill: Object.fromEntries(
        swatches.map((s) => [s.lastChild.textContent.trim(), s.querySelector("svg").getAttribute("fill")]),
      ),
      badges: Object.fromEntries(
        swatches
          .filter((s) => s.querySelector("svg g"))
          .map((s) => {
            const svgEl = s.querySelector("svg");
            return [
              s.lastChild.textContent.trim(),
              {
                rank: Number(svgEl.querySelector("g text").textContent),
                fill: svgEl.querySelector("g circle").getAttribute("fill"),
                squareHidden: getComputedStyle(svgEl.querySelector("rect")).visibility === "hidden",
              },
            ];
          }),
      ),
      caption: [...el.querySelectorAll("figcaption > span")]
        .filter((s) => getComputedStyle(s).visibility !== "hidden")
        .map((s) => s.textContent)
        .join(""),
      announced: el.querySelector("[aria-live]")?.textContent ?? "",
      band: band && getComputedStyle(band).display !== "none" ? center(band) : null,
      leads: [...svg.querySelectorAll('[aria-label="fx-axis tick label"] text')].map((t) => ({
        lead: Number(t.textContent),
        bold: getComputedStyle(t).fontWeight === "700",
        ...center(t),
      })),
      plotMiddle: center(svg).cy,
      facets: [...svg.querySelectorAll('g[aria-label="bar"] > g')].map((g) =>
        [...g.querySelectorAll("rect")]
          .map((r) => {
            const text = r.querySelector("title").textContent;
            const at = text.lastIndexOf(": ");
            return {
              model: text.slice(0, at),
              value: parseFloat(text.slice(at + 2)),
              rank: Number(text.match(/ \(rank (\d+)\)$/)?.[1]) || null,
              x: Number(r.getAttribute("x")),
              fill: r.getAttribute("fill"),
            };
          })
          // Plot draws a missing value as an empty bar on the baseline.
          .filter((b) => Number.isFinite(b.value))
          .sort((a, b) => a.x - b.x),
      ),
    };
  });
}

// Holds a drawn chart to the fixed-order rule and its ranks:
// - every model sits at one x in every facet, and facets run in legend order, so
//   a missing model leaves a gap instead of shifting the bars after it;
// - every bar's title carries its rank at that lead, `ranks[i]`.
function expectChartRules({ legend, legendFill, facets }, ranks, label) {
  expect(facets.length, `${label}: facets`).toBe(ranks.length);
  const slot = new Map();
  for (const [i, bars] of facets.entries()) {
    const models = bars.map((b) => b.model);
    expect(models, `${label} facet ${i}: bars run in legend order`).toEqual(
      legend.filter((m) => models.includes(m)),
    );
    for (const bar of bars) {
      if (!slot.has(bar.model)) slot.set(bar.model, bar.x);
      expect(bar.x, `${label} facet ${i}: ${bar.model} moved`).toBe(slot.get(bar.model));
      expect(bar.fill, `${label}: ${bar.model} matches its legend swatch`).toBe(
        legendFill[bar.model],
      );
    }
    expect(
      Object.fromEntries(bars.map((b) => [b.model, b.rank])),
      `${label} facet ${i}: ranks in the bar titles`,
    ).toEqual(ranks[i]);
  }
}

// Nothing is ranked: no badges, no band, no bold lead, the how-to caption.
function expectNothingSelected(chart, label) {
  expect(chart.badges, `${label}: badges`).toEqual({});
  expect(chart.band, `${label}: band`).toBeNull();
  expect(chart.leads.filter((l) => l.bold), `${label}: bold leads`).toEqual([]);
  expect(chart.caption, `${label}: caption`).toMatch(/^Hover or tap a lead time to rank it/);
  expect(chart.announced, `${label}: announcement`).toBe("");
}

// The legend, band, label, caption, and announcement all describe lead index `i`.
function expectSelected(chart, i, ranks, label) {
  const { lead, cx } = chart.leads[i];
  const where = `${label}, day ${lead}`;
  expect(
    Object.fromEntries(Object.entries(chart.badges).map(([m, b]) => [m, b.rank])),
    `${where}: legend badges`,
  ).toEqual(legendBadges(ranks));
  for (const [model, badge] of Object.entries(chart.badges)) {
    expect(badge.fill, `${where}: ${model}'s badge keeps its color`).toBe(chart.legendFill[model]);
    expect(badge.squareHidden, `${where}: ${model}'s square gives way`).toBe(true);
  }
  expect(chart.band, `${where}: band`).not.toBeNull();
  expect(Math.abs(chart.band.cx - cx), `${where}: band is over the lead`).toBeLessThan(1);
  expect(chart.leads.filter((l) => l.bold).map((l) => l.lead), `${where}: bold`).toEqual([lead]);
  expect(chart.caption, `${where}: caption`).toMatch(
    new RegExp(`^The legend ranks day ${lead}'s top three;`),
  );
  expect(chart.announced, `${where}: announcement`).toMatch(new RegExp(`, day ${lead}: `));
  if (Object.keys(chart.badges).length === 0) {
    expect(chart.announced, `${where}: announcement`).toMatch(/no scores$/);
  }
}

// Live data cannot be counted on to hold ties, gaps, a missing lead, or zero and
// negative values on any given day, so these draw rows that do through the same
// metricChart the page uses: seven models and ten leads, as dense as the index
// gets. Each lead lists one value per model in FIXTURE_MODELS order; `undefined`
// drops the row and `null` sends it with no value, as an all-null AVG does.
const FIXTURE_MODELS = [
  "ECMWF IFS ENS",
  "NOAA GEFS",
  "NOAA GFS",
  "NOAA HRRR",
  "ECMWF AIFS ENS",
  "ECMWF AIFS Single",
  "Google WeatherNext 2, virtual",
];
const legendName = (m) => m.replace(", virtual", "");
const FIXTURES = {
  RMSE: {
    yLabel: "RMSE [°C]",
    leads: [
      [2.0, 2.1, 2.2, 1.5, 1.9, 1.8, 2.4],
      [2.0, 1.4, undefined, 1.6, 1.9, 1.8, 2.4], // a missing middle model
      [2.0, 2.1, 2.2, 1.6, null, 1.8, 1.2], // a null value
      [2.0, 1.3, 1.3, 1.6, 1.6, 1.8, 2.4], // ranks 1, 1, 3, 3: four badges
      [1.7, 1.7, 1.7, 1.7, 1.7, 1.7, 1.7], // everyone ties for first
      [null, null, null, null, null, null, null], // nothing to rank
      [0, 2.1, 2.2, 1.6, 1.9, 1.8, 2.4], // a perfect zero
      [3.0, 3.1, 4.6, undefined, 2.9, 3.2, 3.0],
      [3.1, 3.3, 4.8, undefined, 3.4, 3.0, 3.0],
      [3.2, 3.6, 5.0, undefined, 3.5, 3.3, 3.4],
    ],
  },
  Bias: {
    yLabel: "Bias [°C]",
    leads: [
      [-0.2, -0.36, -0.21, 0.3, -0.08, -0.01, -0.22],
      [0.05, -0.12, -0.19, 0.26, 0.18, 0.05, -0.23], // a tie, apart
      [0.06, -0.09, -0.16, undefined, 0.2, 0, -0.25],
      [0.08, -0.06, -0.13, undefined, 0.23, 0.04, -0.04], // a ±0.04 tie
      [undefined, undefined, undefined, undefined, undefined, undefined, -0.48], // one model
    ],
  },
  ETS: {
    yLabel: "ETS",
    leads: [
      [0.22, 0.19, 0.23, 0.29, 0.13, 0.12, 0.13],
      [-0.02, -0.05, -0.01, undefined, -0.03, -0.04, -0.06], // no skill anywhere
    ],
  },
  FrequencyBias: {
    yLabel: "Frequency Bias",
    leads: [
      [1.3, 0.8, 1.25, 1.6, 1.4, 1.5, 1.1], // below 1 does not win for being low
      [0.5, 1.5, 1.6, undefined, 2, 1.7, 1.8], // a tie across 1
    ],
  },
};

const fixtureRows = (leads) =>
  leads.flatMap((values, lead) =>
    values.flatMap((value, i) =>
      value === undefined ? [] : [{ lead_time_days: lead, model: FIXTURE_MODELS[i], value }],
    ),
  );

const fixtureRanks = (metric, leads) =>
  leads.map((values) =>
    expectedRanks(
      values
        .map((value, i) => ({ model: legendName(FIXTURE_MODELS[i]), value }))
        .filter(({ value }) => value !== undefined),
      DISTANCE[metric],
    ),
  );

// The scorecard module's URL exactly as the page loaded it, cache-busting query
// string and all, so an import shares the page's warm module instance.
const PAGE_MODULE = () =>
  performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => n.includes("/scorecard.js")) ?? "/scorecard.js";

// Opens the index, lets its own temperature render land so it cannot replace the
// fixture, and returns a function that draws a fixture in its place.
async function fixturePage(page) {
  await gotoOk(page, "/scorecard/");
  await expectPlot(page, "temperature-chart");
  await page.locator("#temperature-chart").scrollIntoViewIfNeeded();
  const spec = await page.evaluate(PAGE_MODULE);
  return (metric) =>
    page.evaluate(
      async ({ spec, metric, yLabel, rows }) => {
        const sc = await import(spec);
        const Plot = await import("https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm");
        const box = document.getElementById("temperature-chart");
        box.replaceChildren(
          sc.metricChart(Plot, rows, {
            cfg: sc.METRIC_CONFIG[metric],
            yLabel,
            width: box.clientWidth,
          }),
        );
      },
      { spec, metric, yLabel: FIXTURES[metric].yLabel, rows: fixtureRows(FIXTURES[metric].leads) },
    );
}

for (const [device, width] of Object.entries(SWEEP_WIDTHS)) {
  test(`hovering a lead ranks its top three on the legend on ${device}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = collectPageErrors(page);
    const draw = await fixturePage(page);

    for (const [metric, { leads }] of Object.entries(FIXTURES)) {
      await page.mouse.move(0, 0);
      await draw(metric);
      const ranks = fixtureRanks(metric, leads);
      const label = `${metric} fixture on ${device}`;
      let chart = await readChart(page, "temperature-chart");
      expect(chart.legend).toEqual(FIXTURE_MODELS.map(legendName));
      expectChartRules(chart, ranks, label);
      expectNothingSelected(chart, `${label}, before any hover`);

      // Low in the plot, between bars as often as on them: a group's whole slot
      // selects it, gaps included.
      for (const [i, { cx }] of chart.leads.entries()) {
        await page.mouse.move(cx, chart.plotMiddle + 60);
        expectSelected(await readChart(page, "temperature-chart"), i, ranks[i], label);
      }
    }

    // The cases worth spelling out rather than recomputing.
    const badgesAt = async (i) => {
      const { leads } = await readChart(page, "temperature-chart");
      await page.mouse.move(leads[i].cx, (await readChart(page, "temperature-chart")).plotMiddle);
      const { badges } = await readChart(page, "temperature-chart");
      return Object.fromEntries(Object.entries(badges).map(([m, b]) => [m, b.rank]));
    };
    await draw("RMSE");
    expect(await badgesAt(3)).toEqual({
      "NOAA GEFS": 1,
      "NOAA GFS": 1,
      "NOAA HRRR": 3,
      "ECMWF AIFS ENS": 3,
    });
    expect(Object.values(await badgesAt(4))).toEqual(Array(7).fill(1));
    expect(await badgesAt(5)).toEqual({});

    // Moving on to read the legend keeps the lead; leaving the figure clears it.
    const before = await readChart(page, "temperature-chart");
    const swatch = await page.locator("#temperature-chart figure > div > span").first().boundingBox();
    await page.mouse.move(before.leads[0].cx, before.plotMiddle);
    await page.mouse.move(swatch.x + swatch.width / 2, swatch.y + swatch.height / 2, { steps: 5 });
    expectSelected(
      await readChart(page, "temperature-chart"),
      0,
      fixtureRanks("RMSE", FIXTURES.RMSE.leads)[0],
      `RMSE fixture on ${device}, pointer on the legend`,
    );
    await page.mouse.move(1, 1, { steps: 5 });
    expectNothingSelected(await readChart(page, "temperature-chart"), "after leaving the figure");
    // A click focuses the plot, but the selection still follows the mouse out.
    await page.mouse.click(before.leads[1].cx, before.plotMiddle);
    await page.mouse.move(1, 1, { steps: 5 });
    expectNothingSelected(await readChart(page, "temperature-chart"), "after clicking, then leaving");

    expect(errors, `fixture on ${device} logged console errors`).toEqual([]);
  });
}

test("the keyboard ranks lead by lead from one tab stop", async ({ page }) => {
  const errors = collectPageErrors(page);
  const draw = await fixturePage(page);
  await draw("RMSE");
  const ranks = fixtureRanks("RMSE", FIXTURES.RMSE.leads);
  const plot = page.locator("#temperature-chart figure > svg");
  const read = () => readChart(page, "temperature-chart");

  await plot.focus();
  expectSelected(await read(), 0, ranks[0], "on focus");
  await page.keyboard.press("ArrowRight");
  expectSelected(await read(), 1, ranks[1], "ArrowRight");
  await page.keyboard.press("End");
  expectSelected(await read(), 9, ranks[9], "End");
  await page.keyboard.press("ArrowRight");
  expectSelected(await read(), 9, ranks[9], "ArrowRight at the end");
  await page.keyboard.press("Home");
  expectSelected(await read(), 0, ranks[0], "Home");
  expect((await read()).announced).toBe(
    "RMSE, day 0: rank 1 NOAA HRRR, rank 2 ECMWF AIFS Single, rank 3 ECMWF AIFS ENS",
  );
  await page.keyboard.press("Escape");
  expectNothingSelected(await read(), "Escape");
  await page.keyboard.press("ArrowLeft");
  expectSelected(await read(), 0, ranks[0], "an arrow after Escape");
  // Leaving the plot hands the legend back.
  await page.keyboard.press("Tab");
  expect(await plot.evaluate((el) => el === document.activeElement)).toBe(false);
  expectNothingSelected(await read(), "after Tab");

  expect(errors, "keyboard fixture logged console errors").toEqual([]);
});

test("a tap ranks a lead until another tap, and a scroll does not", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: SWEEP_WIDTHS.phone, height: 800 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  const draw = await fixturePage(page);
  await draw("RMSE");
  const ranks = fixtureRanks("RMSE", FIXTURES.RMSE.leads);
  const read = () => readChart(page, "temperature-chart");
  const { leads, plotMiddle } = await read();

  await page.touchscreen.tap(leads[2].cx, plotMiddle);
  // A touch's pointer leaves as soon as the finger lifts; the lead stays.
  expectSelected(await read(), 2, ranks[2], "after a tap");
  await page.touchscreen.tap(leads[6].cx, plotMiddle);
  expectSelected(await read(), 6, ranks[6], "after tapping another lead");
  await page.touchscreen.tap(leads[6].cx, plotMiddle);
  expectNothingSelected(await read(), "after tapping the same lead again");

  // A swipe across the plot scrolls the page; it is not a tap.
  await page.evaluate(
    ([x, y]) => {
      const svg = document.querySelector("#temperature-chart figure > svg");
      const fire = (type, dy) =>
        svg.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerType: "touch", clientX: x, clientY: y + dy }),
        );
      fire("pointerdown", 0);
      fire("pointermove", -40);
      fire("pointercancel", -80);
    },
    [leads[3].cx, plotMiddle],
  );
  expectNothingSelected(await read(), "after a swipe");

  expect(errors, "touch fixture logged console errors").toEqual([]);
  await context.close();
});

// Every bar at a lead taken from the chart's own query, for the models the
// country view covers. Asked of the page's own DuckDB and module, so it follows
// whatever the file holds instead of assuming every model publishes every lead.
async function queriedLeads(page, variable, metric) {
  return page.evaluate(
    async ({ spec, variable, metric }) => {
      const sc = await import(spec);
      const db = await sc.initDB();
      const conn = await db.connect();
      try {
        const rows = (
          await conn.query(`
            SELECT CAST(lead_time / 86400000000000 AS INTEGER) AS lead, model,
              AVG(value) AS value
            FROM 'https://assets.dynamical.org/scorecard/statistics.parquet'
            WHERE variable = '${variable}' AND metric = '${metric}'
              AND "window" IN (${sc.encodedWindowValues(180).join(",")})
            GROUP BY ALL
          `)
        )
          .toArray()
          .map((r) => r.toJSON())
          .filter((r) => sc.modelCoversRegion(r.model));
        const leads = new Map();
        for (const { lead, model, value } of rows) {
          if (!leads.has(lead)) leads.set(lead, []);
          leads.get(lead).push({ model: sc.legendLabel(model), value });
        }
        return [...leads].sort(([a], [b]) => a - b).map(([, bars]) => bars);
      } finally {
        await conn.close();
      }
    },
    { spec: await page.evaluate(PAGE_MODULE), variable, metric },
  );
}

// The same rules against live data, for one metric of each direction, with the
// ranks worked out from the query's full-precision values rather than the
// three-figure titles. Live Frequency Bias currently sits above 1 for every
// model, so this cannot tell closest-to-1 from lowest; the fixtures and the unit
// tests put values on both sides.
test("scorecard index ranks each lead in a fixed model order", async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoOk(page, "/scorecard/");

  for (const [id, select, variable, metric, phrase] of [
    ["temperature-chart", "#temp-metric", "temperature_2m", "RMSE", "lowest is best"],
    ["temperature-chart", "#temp-metric", "temperature_2m", "Bias", "closest to 0 is best"],
    ["precipitation-chart", "#precip-metric", "precipitation_surface", "ETS", "highest is best"],
    [
      "precipitation-chart",
      "#precip-metric",
      "precipitation_surface",
      "FrequencyBias",
      "closest to 1 is best",
    ],
  ]) {
    await page.mouse.move(0, 0);
    await page.selectOption(select, metric);
    const label = await page.locator(`${select} option:checked`).textContent();
    await expectMetricPlot(page, id, label);
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    const chart = await readChart(page, id);
    const ranks = (await queriedLeads(page, variable, metric)).map((bars) =>
      expectedRanks(bars, DISTANCE[metric]),
    );

    expect(chart.caption, `${metric} caption`).toContain(phrase);
    expect(
      chart.facets.some((bars) => bars.length > 1),
      `${metric} has no lead with more than one bar to rank`,
    ).toBe(true);
    // Facets are drawn in lead order, as the query's leads are listed, and a
    // re-render starts with nothing selected whatever the last chart showed.
    expectChartRules(chart, ranks, metric);
    expectNothingSelected(chart, metric);
    for (const [i, { cx }] of chart.leads.entries()) {
      await page.mouse.move(cx, chart.plotMiddle);
      expectSelected(await readChart(page, id), i, ranks[i], metric);
    }
  }

  expect(errors, "scorecard index logged console errors").toEqual([]);
});

// The dropdowns, the metric directions, and the pinned model colors are all
// hand-kept lists in scorecard.js. The unit tests hold them consistent with each
// other; only the published file can say whether they still cover what it holds.
// A metric with no direction would be ordered as RMSE, and an unpinned model
// takes its color by position, so it can change color between charts.
test("every published metric and model is configured", async ({ page }) => {
  await gotoOk(page, "/scorecard/");
  await expectPlot(page, "temperature-chart");

  const found = await page.evaluate(async () => {
    const spec = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((n) => n.includes("/scorecard.js"));
    const sc = await import(spec ?? "/scorecard.js");
    const db = await sc.initDB();
    const conn = await db.connect();
    const url = "https://assets.dynamical.org/scorecard/statistics.parquet";
    try {
      const column = async (sql) =>
        (await conn.query(sql)).toArray().map((r) => r.toJSON());
      return {
        pairs: await column(
          `SELECT DISTINCT variable, metric FROM '${url}' ORDER BY ALL`,
        ),
        models: (await column(`SELECT DISTINCT model FROM '${url}'`)).map(
          (r) => r.model,
        ),
        variableMetrics: sc.VARIABLE_METRICS,
        metricConfig: sc.METRIC_CONFIG,
        pinnedModels: [...sc.MODEL_STYLE.keys()],
      };
    } finally {
      await conn.close();
    }
  });

  expect(found.pairs.length, "the file lists no metrics").toBeGreaterThan(0);
  for (const { variable, metric } of found.pairs) {
    expect(
      found.variableMetrics[variable] ?? [],
      `${variable} ${metric} is published but not offered`,
    ).toContain(metric);
    expect(
      found.metricConfig[metric]?.better,
      `${metric} has no direction in METRIC_CONFIG`,
    ).toBeTruthy();
  }
  for (const model of found.models) {
    expect(
      found.pinnedModels,
      `${model} is published without a color in MODEL_STYLE`,
    ).toContain(model);
  }
});
