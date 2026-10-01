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

// The models with the best finite value at one lead: every one of them on a tie.
function expectedBest(rows, distance) {
  const finite = rows.filter((r) => Number.isFinite(r.value));
  const best = Math.min(...finite.map((r) => distance(r.value)));
  return finite
    .filter((r) => distance(r.value) === best)
    .map((r) => r.model)
    .sort();
}

// A metric chart as drawn: the legend in order, the caption, each lead-time
// facet's bars, and the best-bar triangles. Bars are read from the <title> each
// carries; `x` is the bar's position within its facet, and the screen boxes are
// what the triangles are matched against.
function readChart(page, id) {
  return page.locator(`#${id}`).evaluate((el) => {
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom };
    };
    const parseTitle = (node) => {
      const text = node.querySelector("title").textContent;
      const at = text.lastIndexOf(": ");
      return {
        model: text.slice(0, at),
        value: parseFloat(text.slice(at + 2)),
        best: text.endsWith(" (best)"),
      };
    };
    const swatches = [...el.querySelectorAll('[class*="-swatch"]:not([class*="-swatches"])')];
    const plot = el.querySelector('svg g[aria-label="bar"]')?.ownerSVGElement;
    const labels = [...el.querySelectorAll('[aria-label="fx-axis tick label"] text')];
    return {
      textColor: plot ? getComputedStyle(plot).color : null,
      background: getComputedStyle(document.body).backgroundColor,
      labelsTop: Math.min(...labels.map((t) => t.getBoundingClientRect().top)),
      legend: swatches.map((s) => s.textContent.trim()),
      legendFill: Object.fromEntries(
        swatches.map((s) => [s.textContent.trim(), s.querySelector("svg").getAttribute("fill")]),
      ),
      caption: el.querySelector("figcaption")?.textContent ?? "",
      frame: plot ? box(plot) : null,
      facets: [...el.querySelectorAll('svg g[aria-label="bar"] > g')].map((g) =>
        [...g.querySelectorAll("rect")]
          .map((r) => ({
            ...parseTitle(r),
            x: Number(r.getAttribute("x")),
            fill: r.getAttribute("fill"),
            ...box(r),
          }))
          .sort((a, b) => a.x - b.x),
      ),
      markers: [...el.querySelectorAll('svg g[aria-label="dot"] path')].map((p) => ({
        ...parseTitle(p),
        pointsDown: /rotate\(180\)/.test(p.getAttribute("transform") ?? ""),
        fill: getComputedStyle(p).fill,
        opacity: Number(getComputedStyle(p).opacity) * Number(getComputedStyle(p).fillOpacity),
        ...box(p),
      })),
    };
  });
}

// Holds a drawn chart to the fixed-order and best-marking rules:
// - every model sits at one x in every facet, and facets run in legend order, so
//   a missing model leaves a gap instead of shifting the bars after it;
// - each facet marks exactly `expected[i]` as best, by title and by triangle;
// - each triangle is centred on its bar, sits clear of the bar's end, and points
//   at it: down onto a bar that rises from zero, up onto one that hangs below,
//   staying above the lead-time labels;
// - each triangle is opaque and painted in the chart's text color, which differs
//   from the page background in either theme.
function expectChartRules(
  { legend, legendFill, facets, markers, frame, textColor, background, labelsTop },
  expected,
  label,
) {
  expect(facets.length, `${label}: facets`).toBe(expected.length);
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
      bars.filter((b) => b.best).map((b) => b.model).sort(),
      `${label} facet ${i}: bars titled best`,
    ).toEqual(expected[i]);
  }

  const best = facets.flat().filter((b) => b.best);
  expect(markers.length, `${label}: one triangle per best bar`).toBe(best.length);
  for (const marker of markers) {
    const bar = best.reduce((a, b) =>
      Math.abs(b.cx - marker.cx) < Math.abs(a.cx - marker.cx) ? b : a,
    );
    const where = `${label}: triangle for ${bar.model} at ${bar.value}`;
    expect(Math.abs(bar.cx - marker.cx), `${where} is centred on it`).toBeLessThanOrEqual(1);
    expect(marker.model, where).toBe(bar.model);
    expect(marker.pointsDown, `${where} points at the bar`).toBe(bar.value >= 0);
    if (bar.value >= 0) {
      expect(marker.bottom, `${where} sits above the bar`).toBeLessThanOrEqual(bar.top);
    } else {
      expect(marker.top, `${where} sits below the bar`).toBeGreaterThanOrEqual(bar.bottom);
    }
    expect(marker.top, `${where} is inside the chart`).toBeGreaterThanOrEqual(frame.top);
    expect(marker.bottom, `${where} clears the lead labels`).toBeLessThan(labelsTop - 1);
    expect(marker.fill, `${where} is the text color`).toBe(textColor);
    expect(marker.fill, `${where} stands out from the page`).not.toBe(background);
    expect(marker.opacity, `${where} is opaque`).toBe(1);
  }
}

// Live data cannot be counted on to hold a tie, a missing model, a zero or a
// negative winner on any given day, so this draws rows that do through the same
// metricChart the page uses, at a phone and a desktop width: seven models and ten
// leads, as dense as the index gets.
const FIXTURE_MODELS = [
  "ECMWF IFS ENS",
  "NOAA GEFS",
  "NOAA GFS",
  "NOAA HRRR",
  "ECMWF AIFS ENS",
  "ECMWF AIFS Single",
  "Google WeatherNext 2, virtual",
];
const [IFS, GEFS, GFS, HRRR, AIFS_ENS, AIFS, WN2] = FIXTURE_MODELS;
const legendName = (m) => m.replace(", virtual", "");
// Each lead lists one value per model in FIXTURE_MODELS order; `undefined` drops
// the row and `null` sends it with no value, as an all-null AVG does.
const FIXTURES = {
  RMSE: {
    yLabel: "RMSE [°C]",
    leads: [
      [[2.0, 2.1, 2.2, 1.5, 1.9, 1.8, 2.4], [HRRR]],
      [[2.0, 1.4, undefined, 1.6, 1.9, 1.8, 2.4], [GEFS]], // a missing middle model
      [[2.0, 2.1, 2.2, 1.6, null, 1.8, 1.2], [WN2]], // a null value; the last slot wins
      [[2.0, 1.3, 1.3, 1.6, 1.9, 1.8, 2.4], [GEFS, GFS]], // adjacent tie
      [[1.7, 1.7, 1.7, 1.7, 1.7, 1.7, 1.7], FIXTURE_MODELS], // everyone ties
      [[null, null, null, null, null, null, null], []], // nothing to mark
      [[0, 2.1, 2.2, 1.6, 1.9, 1.8, 2.4], [IFS]], // a perfect zero, first slot
      [[3.0, 3.1, 4.6, undefined, 2.9, 3.2, 3.0], [AIFS_ENS]],
      [[3.1, 3.3, 4.8, undefined, 3.4, 3.0, 3.0], [AIFS, WN2]],
      [[3.2, 3.6, 5.0, undefined, 3.5, 3.3, 3.4], [IFS]],
    ],
  },
  Bias: {
    yLabel: "Bias [°C]",
    leads: [
      [[-0.2, -0.36, -0.21, 0.3, -0.08, -0.01, -0.22], [AIFS]], // negative winner
      [[0.05, -0.12, -0.19, 0.26, 0.18, 0.05, -0.23], [IFS, AIFS]], // tie, apart
      [[0.06, -0.09, -0.16, undefined, 0.2, 0, -0.25], [AIFS]], // zero winner
      [[0.08, -0.06, -0.13, undefined, 0.23, 0.04, -0.04], [AIFS, WN2]], // a ±0.04 tie
      [[0.1, -0.03, -0.13, undefined, 0.24, 0.05, -0.27], [GEFS]],
      [[0.11, -0.01, -0.13, undefined, 0.24, 0.05, -0.29], [GEFS]],
      [[0.08, -0.02, -0.13, undefined, 0.22, 0.05, -0.32], [GEFS]],
      [[0.05, -0.04, -0.12, undefined, 0.18, 0.03, -0.37], [AIFS]],
      [[0.01, -0.06, -0.1, undefined, 0.13, 0.02, -0.43], [IFS]],
      [[undefined, undefined, undefined, undefined, undefined, undefined, -0.48], [WN2]], // a lone winner at the chart's minimum
    ],
  },
  ETS: {
    yLabel: "ETS",
    leads: [
      [[0.22, 0.19, 0.23, 0.29, 0.13, 0.12, 0.13], [HRRR]],
      [[-0.02, -0.05, -0.01, undefined, -0.03, -0.04, -0.06], [GFS]], // no skill anywhere
    ],
  },
  FrequencyBias: {
    yLabel: "Frequency Bias",
    leads: [
      [[1.3, 0.8, 1.25, 1.6, 1.4, 1.5, 1.1], [WN2]], // below 1 is not best for being low
      [[0.5, 1.5, 1.6, undefined, 2, 1.7, 1.8], [IFS, GEFS]], // a tie across 1
    ],
  },
};

// The scorecard module's URL exactly as the page loaded it, cache-busting query
// string and all, so an import shares the page's warm module instance.
const PAGE_MODULE = () =>
  performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => n.includes("/scorecard.js")) ?? "/scorecard.js";

for (const [device, width] of Object.entries(SWEEP_WIDTHS)) {
  test(`metric chart keeps each model's slot and marks every best bar on ${device}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = collectPageErrors(page);
    await gotoOk(page, "/scorecard/");
    // Let the page's own render land first, so it cannot replace the fixture.
    await expectPlot(page, "temperature-chart");

    for (const [metric, { yLabel, leads }] of Object.entries(FIXTURES)) {
      const rows = leads.flatMap(([values], lead) =>
        values.flatMap((value, i) =>
          value === undefined
            ? []
            : [{ lead_time_days: lead, model: FIXTURE_MODELS[i], value }],
        ),
      );
      await page.evaluate(
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
        { spec: await page.evaluate(PAGE_MODULE), metric, yLabel, rows },
      );
      // currentColor resolves at paint time, so each theme reads the same chart.
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        const chart = await readChart(page, "temperature-chart");
        expect(chart.legend).toEqual(FIXTURE_MODELS.map(legendName));
        expectChartRules(
          chart,
          leads.map(([, best]) => best.map(legendName).sort()),
          `${metric} fixture on ${device}, ${colorScheme}`,
        );
      }
      await page.emulateMedia({ colorScheme: null });
    }

    expect(errors, `fixture on ${device} logged console errors`).toEqual([]);
  });
}

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
// winners worked out from the query's full-precision values rather than the
// three-figure titles. Live Frequency Bias currently sits above 1 for every
// model, so this cannot tell closest-to-1 from lowest; the fixture above and the
// unit tests put values on both sides.
test("scorecard index marks the best bar at each lead, in a fixed model order", async ({
  page,
}) => {
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
    await page.selectOption(select, metric);
    const label = await page.locator(`${select} option:checked`).textContent();
    await expectMetricPlot(page, id, label);
    const chart = await readChart(page, id);
    const leads = await queriedLeads(page, variable, metric);

    expect(chart.caption, `${metric} caption`).toContain(phrase);
    // Facets are drawn in lead order, as the query's leads are listed.
    expect(
      chart.facets.map((bars) => bars.length),
      `${metric} bars per lead, drawn vs. queried`,
    ).toEqual(leads.map((bars) => bars.filter((b) => Number.isFinite(b.value)).length));
    expect(
      chart.facets.some((bars) => bars.length > 1),
      `${metric} has no lead with more than one bar to choose from`,
    ).toBe(true);
    expectChartRules(
      chart,
      leads.map((bars) => expectedBest(bars, DISTANCE[metric])),
      metric,
    );
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
