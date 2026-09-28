import { expect, test } from "@playwright/test";

// The copy control (the migration prompt, and the pill on the home page and
// every dataset page) is one delegated click
// handler plus a per-block status timer, and both of its bugs in review were
// timing: a second click inside the first click's 2.5 s window lost its
// feedback, and analytics counted a copy that had failed. `npm test` has no
// clipboard or timers to catch either, so this spec drives the real page.
// Nothing here touches the network beyond the dev server.

const PATH = "/migration-2026/";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("a click copies the prompt and announces it", async ({ page }) => {
  await page.goto(PATH);
  const block = page.locator(".agent-prompt").first();
  await block.locator("button").click();
  await expect(block.locator("[role=status]")).toHaveText("copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await block.locator("textarea").inputValue());
});

test("a second click inside the window keeps its own feedback", async ({ page }) => {
  await page.goto(PATH);
  const block = page.locator(".agent-prompt").first();
  const status = block.locator("[role=status]");
  await block.locator("button").click();
  await expect(status).toHaveText("copied");
  await page.waitForTimeout(2300);
  await block.locator("button").click();
  await page.waitForTimeout(600); // past where the first click's timer would have cleared it
  await expect(status).toHaveText("copied");
  await expect(status).toHaveText("", { timeout: 4000 });
});

test("a failed copy says so and is not counted as a copy", async ({ page }) => {
  const events = [];
  await page.exposeFunction("__track", (event, properties) => events.push([event, properties]));
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      window.track = (event, properties) => window.__track(event, properties);
    });
  });
  await page.goto(PATH);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
    document.execCommand = () => false;
  });
  const block = page.locator(".agent-prompt").first();
  await block.locator("button").click();
  await expect(block.locator("[role=status]")).toHaveText("select the text and copy it yourself");
  expect(events).toEqual([]);
});

test("a successful copy is tracked by id, never by text", async ({ page }) => {
  const events = [];
  await page.exposeFunction("__track", (event, properties) => events.push([event, properties]));
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      window.track = (event, properties) => window.__track(event, properties);
    });
  });
  await page.goto(PATH);
  const block = page.locator(".agent-prompt[data-prompt=migration]");
  await block.locator("button").click();
  await expect(block.locator("[role=status]")).toHaveText("copied");
  expect(events).toEqual([["agent_prompt_copied", { prompt: "migration", page: PATH }]]);
});

test("the home-page pill copies the one-line setup prompt", async ({ page }) => {
  await page.goto("/");
  const pill = page.locator(".agent-setup-pill").first();
  await pill.locator("button").click();
  await expect(pill.locator("[role=status]")).toHaveText("copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await pill.locator("textarea").inputValue());
  expect(copied).toMatch(/^Fetch and follow .* https:\/\/dynamical\.org\/prompt\.md$/);
});

for (const path of ["/", "/catalog/noaa-gfs-forecast/"]) {
  test(`the pill fits a phone on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(path);
    const pill = page.locator(".agent-setup-pill button").first();
    const [button, icons, doc] = await Promise.all([
      pill.boundingBox(),
      pill.locator("span").boundingBox(),
      page.evaluate(() => document.documentElement.scrollWidth),
    ]);
    expect(doc).toBeLessThanOrEqual(375);
    expect(icons.x + icons.width).toBeLessThanOrEqual(button.x + button.width);
    const buttonCenter = button.x + button.width / 2;
    expect(Math.abs(buttonCenter - 375 / 2)).toBeLessThan(10);
  });
}

// The dataset ID row is the same control drawn as an id and an icon. It has to
// stay one table row tall, even for the longest id on a phone, where the id
// ellipsizes rather than widening the table.
test("the dataset ID row copies the id on one line", async ({ page }) => {
  const id = "ecmwf-ifs-ens-forecast-46-day-6-hourly-1-5-degree";
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/catalog/${id}/`);
  const rows = page.locator(".catalog-item > table").first().locator("tr");
  const block = rows.first().locator(".agent-prompt[data-prompt=dataset-id]");
  const lineHeight = await block.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  const height = (await rows.first().boundingBox()).height;
  expect(height).toBeLessThan(2 * lineHeight);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await block.getByRole("button", { name: "Copy dataset ID" }).click();
  await expect(block.locator("[role=status]")).toHaveText("copied");
  await expect(block).toHaveAttribute("data-copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
  expect((await rows.first().boundingBox()).height).toBe(height);
});
