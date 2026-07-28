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
        if ((await box.locator("svg").count()) > 0) {
          state = "rendered a plot";
          return true;
        }
        const status = (
          await box
            .locator("p")
            .first()
            .textContent()
            .catch(() => null)
        )?.trim();
        state = status || "an empty container";
        return Boolean(status) && status !== LOADING_TEXT;
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
    await page.goto(path);

    for (const id of charts) await expectPlot(page, id);

    expect(errors, `${name} logged console errors`).toEqual([]);
  });
}

// A query that returns no rows is the failure mode that hid the 2026-07-19 units
// change for nine days: nothing throws, so Sentry's global handlers see nothing
// and the page just shows an empty-state box. `reportUnknownWindow` is what turns
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
  await page.goto("/scorecard/station/YKM/");
  // Let the page finish its own charts first: the module and DuckDB are then warm
  // and the probe below is the only thing left to explain a captured event.
  await expectPlot(page, "temperature_2m-score");

  const result = await page.evaluate(async () => {
    const { renderMetric } = await import("/scorecard.js");
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
  await page.goto("/scorecard/station/YKM/");
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
