import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost:8081\/)/, route => route.abort());
});

test("meeting listings do not repeat each meeting's heading or date", async ({ page }) => {
  await page.goto("/meetings/");
  const meetings = page.locator("article");
  expect(await meetings.count()).toBeGreaterThan(0);
  for (const meeting of await meetings.all()) {
    await expect.soft(meeting.getByRole("heading", { name: /^Steering Committee Meeting,/ })).toHaveCount(1);
    const dates = (await meeting.innerText()).match(/\b(?:[A-Z][a-z]+ \d{1,2},? 20\d{2}|20\d{2}-\d{2}-\d{2})\b/g);
    expect.soft(dates).toHaveLength(1);
  }
});

test("2026 meeting notes are published newest first and retain individual pages", async ({ page }) => {
  await page.goto("/meetings/");
  const dates = ["2026-09-30", "2026-06-03", "2026-03-11", "2025-12-03", "2025-09-03", "2025-06-04"];
  const meetings = page.locator("article");
  await expect(meetings).toHaveCount(dates.length);
  for (const [index, date] of dates.entries()) {
    const displayedDate = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    });
    await expect(meetings.nth(index)).toContainText(displayedDate);
  }
  for (const date of dates) {
    const response = await page.goto(`/meetings/steering_committee_${date}/`);
    expect(response.status()).toBe(200);
    await expect(page.getByRole("heading", { name: /^Steering Committee Meeting,/ })).toHaveCount(1);
    await expect(page.locator(".content")).toContainText(new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    }));
  }
});
