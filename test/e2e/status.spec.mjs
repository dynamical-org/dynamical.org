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

async function stubStatus(page, mutate = (payload) => payload) {
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
  await page.route("**/events.jsonl", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      headers: JSON_HEADERS,
      body: EVENTS,
    }),
  );
  await page.route("**/meta.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(META),
    }),
  );
  await page.route("**/dashboard.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(DASHBOARD),
    }),
  );
}

async function openStatus(page, mutate) {
  await stubStatus(page, mutate);
  const response = await page.goto(PATH);
  expect(response?.status(), `${PATH} did not return 200`).toBe(200);
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
