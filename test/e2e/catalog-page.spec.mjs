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

// Records track() calls; the page defines track() itself on DOMContentLoaded.
const trackEvents = async (page) => {
  const events = [];
  await page.exposeFunction("__track", (event, properties) => events.push([event, properties]));
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      window.track = (event, properties) => window.__track(event, properties);
    });
  });
  return events;
};

test("the keyboard reaches the prompt tab and its copy button", async ({ page }) => {
  const events = await trackEvents(page);
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
  // Arrowing through tabs is not a choice of access path: only the copy counts.
  expect(events).toEqual([["agent_prompt_copied", { prompt: "dataset-example", page: PAGE }]]);
});

test("choosing a code variant is tracked, visiting the prompt tab is not", async ({ page }) => {
  const events = await trackEvents(page);
  await page.goto(PAGE);
  const frame = page.locator(".frame").first();
  await frame.getByRole("tab", { name: "Example prompt" }).click();
  await frame.getByRole("tab", { name: "pystac + icechunk" }).click();
  await expect(frame.getByRole("tabpanel")).toContainText("pystac");
  expect(events).toEqual([["snippet_variant_selected", { dataset: "noaa-gfs-forecast", variant: "pystac + icechunk" }]]);
});

// Every tab and the visible brand mark stay inside the header, clear of each
// other, from a small phone through the widths where the header drops the
// wordmark (640px frame) and wraps the tabs (500px frame).
const WIDTHS = [375, 1024, ...Array.from({ length: 25 }, (_, i) => 320 + 20 * i)];
for (const width of WIDTHS) {
  test(`the frame header fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(PAGE);
    const frame = page.locator(".frame").first();
    const header = await frame.locator(".frameHeader").boundingBox();
    const inside = (b) => {
      expect(b.x).toBeGreaterThanOrEqual(header.x);
      expect(b.x + b.width).toBeLessThanOrEqual(header.x + header.width + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(header.y + header.height + 0.5);
    };
    const tabs = await Promise.all((await frame.getByRole("tab").all()).map((t) => t.boundingBox()));
    tabs.forEach(inside);
    const marks = frame.locator(".frameBrand-wordmark img, .frameBrand-icon");
    for (const mark of await marks.all()) {
      if (!(await mark.isVisible())) continue;
      const m = await mark.boundingBox();
      inside(m);
      for (const t of tabs) expect(t.x + t.width <= m.x || t.y + t.height <= m.y || m.y + m.height <= t.y).toBe(true);
    }
    // At 320px something else on the page already overflows by 8px (on main
    // too, 2026-09-29), so the page-width check holds from 375px.
    if (width >= 375) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await frame.getByRole("tab", { name: "Example prompt" }).click();
    const copy = await frame.getByRole("button", { name: "copy to clipboard" }).boundingBox();
    const box = await frame.boundingBox();
    expect(copy.x + copy.width).toBeLessThanOrEqual(box.x + box.width);
    expect(copy.y + copy.height).toBeLessThanOrEqual(box.y + box.height);
  });
}
