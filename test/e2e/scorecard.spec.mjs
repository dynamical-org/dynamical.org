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

// What "best" means for the metrics the order test below walks, as a distance
// where smaller is better. Written out here rather than imported from
// scorecard.js, so a direction filed wrong there fails this spec instead of
// agreeing with it.
const DISTANCE = {
  RMSE: (v) => v,
  Bias: (v) => Math.abs(v),
  ETS: (v) => -v,
  FrequencyBias: (v) => Math.abs(v - 1),
};

// Each lead-time facet's bars in on-screen order (by x, not DOM order), read
// from the <title> every bar carries, plus the legend's color for each model.
function readBars(page, id) {
  return page.locator(`#${id}`).evaluate((el) => {
    const legend = Object.fromEntries(
      [...el.querySelectorAll('[class*="-swatch"]:not([class*="-swatches"])')].map(
        (s) => [s.textContent.trim(), s.querySelector("svg").getAttribute("fill")],
      ),
    );
    const facets = [...el.querySelectorAll('svg g[aria-label="bar"] > g')].map((g) =>
      [...g.querySelectorAll("rect")]
        .map((r) => {
          const title = r.querySelector("title").textContent;
          const at = title.lastIndexOf(": ");
          return {
            x: Number(r.getAttribute("x")),
            model: title.slice(0, at),
            value: Number(title.slice(at + 2)),
            fill: r.getAttribute("fill"),
          };
        })
        .sort((a, b) => a.x - b.x),
    );
    return {
      legend,
      facets,
      caption: el.querySelector("figcaption")?.textContent ?? "",
    };
  });
}

// Titles round to three significant figures, so a parsed value can be off by
// half a unit in its third figure. Every distance in DISTANCE moves no faster
// than the value, so two bars' rounding errors together bound any apparent
// inversion between them.
const roundingError = (v) =>
  v === 0 ? 0 : 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(v))) - 2);

// Which model is best changes with lead time, so every lead is ordered on its
// own; this walks one metric of each direction against live data. Live
// Frequency Bias currently sits above 1 for every model, so this cannot tell
// closest-to-1 from plain ascending order; the unit tests cover both sides.
test("scorecard index orders bars best-first within each lead", async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoOk(page, "/scorecard/");

  for (const [id, select, metric, phrase] of [
    ["temperature-chart", "#temp-metric", "RMSE", "lower is better"],
    ["temperature-chart", "#temp-metric", "Bias", "closest to 0 is best"],
    ["precipitation-chart", "#precip-metric", "ETS", "higher is better"],
    ["precipitation-chart", "#precip-metric", "FrequencyBias", "closest to 1 is best"],
  ]) {
    await page.selectOption(select, metric);
    await expectPlot(page, id);
    const { legend, facets, caption } = await readBars(page, id);

    expect(caption, `${metric} caption`).toContain(phrase);
    expect(facets.length, `${metric} drew too few lead times`).toBeGreaterThan(1);
    // Every model on the index publishes day 0, so a short first group means
    // bars went missing between the query and the plot.
    expect(facets[0].length, `${metric} lead 0 bar count`).toBe(
      Object.keys(legend).length,
    );
    for (const [lead, bars] of facets.entries()) {
      expect(bars.length, `${metric} lead ${lead} has no bars`).toBeGreaterThan(1);
      expect(new Set(bars.map((b) => b.model)).size).toBe(bars.length);
      for (const bar of bars) {
        expect(Number.isFinite(bar.value), `${bar.model} value`).toBe(true);
        expect(bar.fill, `${bar.model}'s bar matches its legend swatch`).toBe(
          legend[bar.model],
        );
      }
      for (let i = 1; i < bars.length; i++) {
        const [a, b] = [bars[i - 1], bars[i]];
        const slack = roundingError(a.value) + roundingError(b.value);
        expect(
          DISTANCE[metric](a.value),
          `${metric} lead ${lead}: ${a.model} (${a.value}) is drawn before ` +
            `${b.model} (${b.value})`,
        ).toBeLessThanOrEqual(DISTANCE[metric](b.value) + slack);
      }
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
