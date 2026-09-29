import { expect, test } from "@playwright/test";

// The order of a catalog page's sections, and the example frame's third tab:
// the prompt a reader hands to a coding agent. Tab switching, keyboard reach,
// the clipboard, and whether three tabs fit a phone's frame are all things
// `npm test` has no browser to see. Nothing here loads the explorer's data.

const PAGE = "/catalog/noaa-gfs-forecast/";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// Document order of the page's landmarks, by the text that names each one.
const order = (page) =>
  page.evaluate(() => {
    const marks = {
      examples: [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Examples"),
      frame: document.querySelector(".frame"),
      explore: document.querySelector("section.explore"),
      dimensions: [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Dimensions"),
      details: [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Details"),
      additional: [...document.querySelectorAll("h3")].find((h) => h.textContent.trim() === "Additional details"),
    };
    return Object.entries(marks)
      .filter(([, el]) => el)
      .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(([name]) => name);
  });

test("the explorer follows the example, and the listings sit under Additional details", async ({ page }) => {
  await page.goto(PAGE);
  expect(await order(page)).toEqual(["examples", "frame", "explore", "dimensions", "details", "additional"]);
  const additional = page.locator("h3", { hasText: "Additional details" }).locator("+ p");
  await expect(additional.getByRole("link")).toHaveText(["Earthmover Marketplace", "Source Cooperative", "AWS Open Data Registry"]);
  // Nothing about them is left at the top of the page.
  await expect(page.locator(".catalog-item > table + p").getByRole("link")).toHaveText(["STAC", "browse", "validation report"]);
  await expect(page.getByRole("link", { name: "Earthmover Marketplace" })).toHaveCount(1);
  // The prompt tab replaces the setup pill on a product page.
  await expect(page.locator(".agent-setup-pill")).toHaveCount(0);
});

test("a product with no listing has no Additional details", async ({ page }) => {
  // No platform lists the GFS virtual products yet (_data/listings.js).
  await page.goto("/catalog/noaa-gfs-forecast-virtual/");
  await expect(page.locator("h3", { hasText: "Additional details" })).toHaveCount(0);
  expect(await order(page)).toEqual(["examples", "frame", "explore", "dimensions", "details"]);
});

test("the prompt tab shows and copies this product's prompt", async ({ page }) => {
  await page.goto(PAGE);
  const frame = page.locator(".frame").first();
  await expect(frame.getByRole("tab")).toHaveText(["dynamical-catalog", "pystac + icechunk", "Example prompt"]);
  await frame.getByRole("tab", { name: "Example prompt" }).click();
  const panel = frame.getByRole("tabpanel");
  await expect(panel).toHaveCount(1);
  const block = panel.locator(".agent-prompt[data-prompt=dataset-example]");
  const text = await block.locator("textarea").inputValue();
  expect(text).toMatch(/^Fetch and follow the setup instructions at https:\/\/dynamical\.org\/prompt\.md\n\nAfter setup, my task: open noaa-gfs-forecast \(https:\/\/stac\.dynamical\.org\/noaa-gfs-forecast\/collection\.json\) and /);
  await block.getByRole("button", { name: "copy to clipboard" }).click();
  await expect(block.locator("[role=status]")).toHaveText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  // Back to the code: one panel at a time.
  await frame.getByRole("tab", { name: "dynamical-catalog" }).click();
  await expect(block).toBeHidden();
  await expect(frame.getByRole("tabpanel")).toContainText("dynamical_catalog.open");
});

test("the keyboard reaches the prompt tab and its copy button", async ({ page }) => {
  await page.goto(PAGE);
  const frame = page.locator(".frame").first();
  await frame.getByRole("tab", { name: "dynamical-catalog" }).focus();
  await page.keyboard.press("End");
  const tab = frame.getByRole("tab", { name: "Example prompt" });
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(frame.getByRole("tab", { name: "dynamical-catalog" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab).toBeFocused();
  // Tab leaves the tablist for the panel: the textarea, then the copy button.
  await page.keyboard.press("Tab");
  await expect(frame.locator("textarea")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(frame.getByRole("button", { name: "copy to clipboard" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame.locator("[role=status]")).toHaveText("copied");
});

for (const width of [320, 375]) {
  test(`every tab is visible in the frame at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(PAGE);
    const frame = page.locator(".frame").first();
    const box = await frame.boundingBox();
    for (const tab of await frame.getByRole("tab").all()) {
      const t = await tab.boundingBox();
      expect(t.x).toBeGreaterThanOrEqual(box.x);
      expect(t.x + t.width).toBeLessThanOrEqual(box.x + box.width);
      expect(t.y + t.height).toBeLessThanOrEqual(box.y + box.height);
    }
    // At 320px something else on the page already overflows by 8px (on main
    // too, 2026-09-29), so the page-width check holds at 375px only.
    if (width >= 375) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await frame.getByRole("tab", { name: "Example prompt" }).click();
    const copy = await frame.getByRole("button", { name: "copy to clipboard" }).boundingBox();
    const open = await frame.boundingBox();
    expect(copy.x + copy.width).toBeLessThanOrEqual(open.x + open.width);
    expect(copy.y + copy.height).toBeLessThanOrEqual(open.y + open.height);
  });
}
