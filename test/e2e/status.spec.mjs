import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const PATH = "/status/";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STATUS = JSON.parse(
  readFileSync(new URL("../fixtures/status.json", import.meta.url)),
);
const EVENTS = readFileSync(
  new URL("../fixtures/events.jsonl", import.meta.url),
  "utf8",
);
const DASHBOARD = JSON.parse(
  readFileSync(new URL("../fixtures/pipeline-dashboard.json", import.meta.url)),
);
const EVENT_COUNT = EVENTS.split("\n").filter((line) => line.trim()).length;
const META = {
  v: 1,
  reconciled_at: STATUS.generated_at,
  events_count: EVENT_COUNT,
};
const JSON_HEADERS = { "access-control-allow-origin": "*" };
const STAC_INCIDENT_ID =
  `incident-stac-catalog-${Date.parse("2026-07-21T13:55:00Z") / 1000}`;
const OVERLAP_INCIDENT_ID =
  `incident-data-product-reads-${Date.parse("2026-07-21T14:00:00Z") / 1000}`;
const INSERTED_OVERLAP_INCIDENT_ID =
  `incident-scorecard-${Date.parse("2026-07-21T14:10:00Z") / 1000}`;
const DEFERRED_INCIDENT_ID =
  `incident-scorecard-${Date.parse("2026-07-23T10:00:00Z") / 1000}`;

function withEvents(events, additions) {
  return `${events.trim()}\n${additions.map(JSON.stringify).join("\n")}\n`;
}

const OVERLAPPING_EVENTS = withEvents(EVENTS, [
  {
    ts: "2026-07-21T14:00:00Z",
    kind: "transition",
    component: "data-product-reads",
    to: "down",
  },
  {
    ts: "2026-07-21T14:30:00Z",
    kind: "transition",
    component: "data-product-reads",
    to: "operational",
  },
]);

const INSERTED_OVERLAP_EVENTS = withEvents(OVERLAPPING_EVENTS, [
  {
    ts: "2026-07-21T14:10:00Z",
    kind: "transition",
    component: "scorecard",
    to: "down",
  },
  {
    ts: "2026-07-21T14:20:00Z",
    kind: "transition",
    component: "scorecard",
    to: "operational",
  },
]);

const DEFERRED_EVENTS = withEvents(EVENTS, [
  {
    ts: "2026-07-23T10:00:00Z",
    kind: "transition",
    component: "scorecard",
    to: "down",
  },
  {
    ts: "2026-07-23T10:10:00Z",
    kind: "transition",
    component: "scorecard",
    to: "operational",
  },
]);

const WITHOUT_STAC_EVENTS = `${EVENTS.split("\n")
  .filter(
    (line) =>
      line.trim() && JSON.parse(line).component !== "stac-catalog",
  )
  .join("\n")}\n`;

async function stubStatus(
  page,
  mutate = (payload) => payload,
  mutateHistory = (events) => events,
) {
  let served = 0;
  await page.route("**/status.json", (route) => {
    served += 1;
    const payload = mutate(structuredClone(STATUS), served);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
  });
  let eventsServed = 0;
  await page.route("**/events.jsonl", (route) => {
    eventsServed += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      headers: JSON_HEADERS,
      body: mutateHistory(EVENTS, eventsServed),
    });
  });
  let metaServed = 0;
  await page.route("**/meta.json", (route) => {
    metaServed += 1;
    const events = mutateHistory(EVENTS, metaServed);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...META,
        events_count: events.split("\n").filter((line) => line.trim()).length,
      }),
    });
  });
  await page.route("**/dashboard.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(DASHBOARD),
    }),
  );
}

async function openStatus(page, mutate, mutateHistory, path = PATH) {
  await stubStatus(page, mutate, mutateHistory);
  const response = await page.goto(path);
  expect(response?.status(), `${path} did not return 200`).toBe(200);
  await expect(page.locator("#status-endpoints > li").first()).toBeVisible();
  await expect(page.locator("#status-history")).toBeHidden();
}

function componentRow(page, name) {
  return page.locator(".status-list > li").filter({ hasText: name });
}

test.describe("service-list state survives a refresh", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({
      time: new Date(Date.parse(STATUS.generated_at) + 2 * 60 * 1000),
    });
  });

  test("keeps the endpoint, day, focus, selection, and page scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 500 });
    await openStatus(page, (payload, served) => {
      if (served > 1) payload.endpoints[1].status = "operational";
      return payload;
    });

    const row = componentRow(page, "STAC catalog");
    const endpoint = await row.elementHandle();
    const day = await row
      .locator('.status-bars > a[href^="#incident-"]')
      .elementHandle();
    await day.focus();
    const selected = await row.locator("h3").evaluate((node) => {
      getSelection().selectAllChildren(node);
      return getSelection().toString();
    });
    const scrollY = await page.evaluate(() => {
      scrollTo(0, document.documentElement.scrollHeight - innerHeight - 40);
      return window.scrollY;
    });
    expect(scrollY).toBeGreaterThan(0);

    await page.clock.runFor(REFRESH_INTERVAL_MS);

    await expect(
      componentRow(page, "Data product reads").locator(".status-label"),
    ).toHaveText("● Operational");
    expect(await endpoint.evaluate((node) => node.isConnected)).toBe(true);
    expect(await day.evaluate((node) => node.isConnected)).toBe(true);
    expect(await day.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => getSelection().toString())).toBe(selected);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  });

  test("moves a keyed endpoint below a newly inserted one", async ({ page }) => {
    await openStatus(page, (payload, served) => {
      if (served > 1) {
        payload.endpoints.unshift({
          id: "new-core-endpoint",
          name: "New core endpoint",
          group: "endpoint",
          status: "operational",
        });
      }
      return payload;
    });
    const row = componentRow(page, "STAC catalog");
    const endpoint = await row.elementHandle();
    const day = await row.locator(".status-bars > *").last().elementHandle();

    await page.clock.runFor(REFRESH_INTERVAL_MS);

    await expect(page.locator("#status-endpoints > li h3").first()).toHaveText(
      "New core endpoint",
    );
    expect(await endpoint.evaluate((node) => node.isConnected)).toBe(true);
    expect(await endpoint.evaluate((node) => node.querySelector("h3").textContent)).toBe(
      "STAC catalog",
    );
    expect(await day.evaluate((node) => node.isConnected)).toBe(true);
  });
});

test.describe("in a non-UTC time zone", () => {
  test.use({ timezoneId: "America/Chicago", locale: "en-US" });

  test("the time-zone action reformats time without replacing service nodes", async ({
    page,
  }) => {
    await page.clock.install({
      time: new Date(Date.parse(STATUS.generated_at) + 2 * 60 * 1000),
    });
    await page.addInitScript(() =>
      localStorage.setItem("wxopticon:time-mode", "utc"),
    );
    await stubStatus(page);
    await page.goto(PATH);
    const row = componentRow(page, "STAC catalog");
    const endpoint = await row.elementHandle();
    const day = await row.locator(".status-bars > *").last().elementHandle();
    const updated = page.locator('[data-slot="status-updated"]');
    await expect(updated).toHaveText("As of Jul 24, 2026, 7:55 PM");

    await page.selectOption("#status-time-toggle", "local");

    await expect(updated).toHaveText("As of Jul 24, 2026, 2:55 PM");
    expect(await endpoint.evaluate((node) => node.isConnected)).toBe(true);
    expect(await day.evaluate((node) => node.isConnected)).toBe(true);
  });
});

test.describe("incident-history state survives a refresh", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({
      time: new Date(Date.parse(STATUS.generated_at) + 2 * 60 * 1000),
    });
  });

  test("keeps the incident, cross-reference focus, and incident selection", async ({
    page,
  }) => {
    await openStatus(
      page,
      (payload, served) => {
        if (served > 1) payload.endpoints[1].status = "operational";
        return payload;
      },
      (events, served) =>
        served > 1 ? INSERTED_OVERLAP_EVENTS : OVERLAPPING_EVENTS,
    );
    const incident = page.locator(`#${STAC_INCIDENT_ID}`);
    const item = await incident.elementHandle();
    const crossReference = await incident
      .locator(`a[href="#${OVERLAP_INCIDENT_ID}"]`)
      .elementHandle();
    await crossReference.focus();
    const selected = await incident.locator("h3").evaluate((node) => {
      getSelection().selectAllChildren(node);
      return getSelection().toString();
    });

    await page.clock.runFor(REFRESH_INTERVAL_MS);

    await expect(
      incident.locator(`a[href="#${INSERTED_OVERLAP_INCIDENT_ID}"]`),
    ).toBeVisible();
    await expect(
      componentRow(page, "Data product reads").locator(".status-label"),
    ).toHaveText("● Operational");
    expect(await item.evaluate((node) => node.isConnected)).toBe(true);
    expect(await crossReference.evaluate((node) => node.isConnected)).toBe(true);
    expect(
      await crossReference.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    expect(await page.evaluate(() => getSelection().toString())).toBe(selected);
  });
});

test.describe("incident times in a non-UTC time zone", () => {
  test.use({ timezoneId: "America/Chicago", locale: "en-US" });

  test("the time-zone action retains incident nodes while reformatting them", async ({
    page,
  }) => {
    await page.clock.install({
      time: new Date(Date.parse(STATUS.generated_at) + 2 * 60 * 1000),
    });
    await page.addInitScript(() =>
      localStorage.setItem("wxopticon:time-mode", "utc"),
    );
    await openStatus(page, undefined, () => OVERLAPPING_EVENTS);
    const incident = page.locator(`#${STAC_INCIDENT_ID}`);
    const item = await incident.elementHandle();
    const timing = incident.locator("p").last();
    await expect(timing).toHaveText(
      "Jul 21, 2026, 1:55 PM UTC – Jul 21, 2026, 2:55 PM UTC · 1h.",
    );

    await page.selectOption("#status-time-toggle", "local");

    await expect(timing).toHaveText(
      "Jul 21, 2026, 8:55 AM CDT – Jul 21, 2026, 9:55 AM CDT · 1h.",
    );
    expect(await item.evaluate((node) => node.isConnected)).toBe(true);
  });
});

test.describe("incident fragment replay", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({
      time: new Date(Date.parse(STATUS.generated_at) + 2 * 60 * 1000),
    });
  });

  test("replays an initial fragment once without dragging the next poll", async ({
    page,
  }) => {
    await openStatus(
      page,
      undefined,
      (events, served) => (served > 1 ? DEFERRED_EVENTS : events),
      `${PATH}#${STAC_INCIDENT_ID}`,
    );
    await expect(page.locator(`#${STAC_INCIDENT_ID}:target`)).toBeVisible();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await page.evaluate(() => scrollTo(0, 0));

    await page.clock.runFor(REFRESH_INTERVAL_MS);
    await expect(page.locator(`#${DEFERRED_INCIDENT_ID}`)).toBeVisible();
    await page.waitForTimeout(100);

    expect(await page.evaluate(() => scrollY)).toBe(0);
  });

  test("replays a pending fragment when its incident arrives later", async ({
    page,
  }) => {
    await openStatus(
      page,
      undefined,
      (events, served) => (served > 1 ? DEFERRED_EVENTS : events),
      `${PATH}#${DEFERRED_INCIDENT_ID}`,
    );
    await expect(page.locator(`#${DEFERRED_INCIDENT_ID}`)).toHaveCount(0);

    await page.clock.runFor(REFRESH_INTERVAL_MS);

    await expect(page.locator(`#${DEFERRED_INCIDENT_ID}:target`)).toBeVisible();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });

  test("native fragment navigation is not replayed after the reader scrolls away", async ({
    page,
  }) => {
    await openStatus(
      page,
      undefined,
      (events, served) => (served > 1 ? DEFERRED_EVENTS : events),
    );
    await componentRow(page, "STAC catalog")
      .locator(`.status-bars > a[href="#${STAC_INCIDENT_ID}"]`)
      .click();
    await expect(page.locator(`#${STAC_INCIDENT_ID}:target`)).toBeVisible();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await page.evaluate(() => scrollTo(0, 0));

    await page.clock.runFor(REFRESH_INTERVAL_MS);
    await expect(page.locator(`#${DEFERRED_INCIDENT_ID}`)).toBeVisible();
    await page.waitForTimeout(100);

    expect(await page.evaluate(() => scrollY)).toBe(0);
  });

  test("replays a revisited handled fragment after its incident returns", async ({
    page,
  }) => {
    await openStatus(
      page,
      undefined,
      (events, served) => {
        if (served === 2) return WITHOUT_STAC_EVENTS;
        return events;
      },
    );
    await componentRow(page, "STAC catalog")
      .locator(`.status-bars > a[href="#${STAC_INCIDENT_ID}"]`)
      .click();
    await expect(page.locator(`#${STAC_INCIDENT_ID}:target`)).toBeVisible();

    await page.clock.runFor(REFRESH_INTERVAL_MS);
    await expect(page.locator(`#${STAC_INCIDENT_ID}`)).toHaveCount(0);
    await page.evaluate(
      ({ deferred, stac }) => {
        location.hash = deferred;
        location.hash = stac;
      },
      { deferred: DEFERRED_INCIDENT_ID, stac: STAC_INCIDENT_ID },
    );
    await page.evaluate(() => scrollTo(0, 0));

    await page.clock.runFor(REFRESH_INTERVAL_MS);

    await expect(page.locator(`#${STAC_INCIDENT_ID}:target`)).toBeVisible();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });
});

test("an unavailable status feed renders the established fallback", async ({ page }) => {
  await page.route("**/status.json", (route) =>
    route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" }),
  );
  await page.route("**/events.jsonl", (route) =>
    route.fulfill({ status: 200, contentType: "application/x-ndjson", body: EVENTS }),
  );
  await page.route("**/meta.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(META) }),
  );
  await page.route("**/dashboard.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DASHBOARD) }),
  );

  await page.goto(PATH);

  await expect(page.locator("#status-summary")).toHaveText(
    "The status feed could not be loaded. Try again shortly.",
  );
  await expect(page.locator("#status-incidents")).toBeHidden();
  await expect(page.locator("#status-history")).toBeHidden();
  await expect(page.locator("#status-groups")).toBeHidden();
  await expect(page.locator("#status-incident-empty")).toHaveText(
    "Incident history is temporarily unavailable.",
  );
  await expect(page.locator('[data-slot="status-updated"]')).toHaveText("As of —");
  await expect(page.locator('[data-slot="time-control"]')).toBeHidden();
  await expect(page.locator('[data-slot="system-health"]')).toHaveAttribute(
    "data-state",
    "unavailable",
  );
});
