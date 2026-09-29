import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// The order of a catalog page's sections, and the example frame's third tab:
// the prompt a reader hands to a coding agent. Tab switching, keyboard reach,
// the clipboard, and whether three tabs fit a phone's frame are all things
// `npm test` has no browser to see. Nothing here loads the explorer's data.

const PAGE = "/catalog/noaa-gfs-forecast/";
const catalog = await require("../../_data/catalog.js")();
const promptFor = entry => entry.examples[0].variants.find(v => v.language === "text");
const gfsPrompt = promptFor(catalog.entries.find(e => e.id === "noaa-gfs-forecast"));

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
      listings: [...document.querySelectorAll("h3")].find((h) => h.textContent.trim() === "External listings"),
    };
    return Object.entries(marks)
      .filter(([, el]) => el)
      .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(([name]) => name);
  });

test("the explorer follows the example, and the listings sit under External listings", async ({ page }) => {
  await page.goto(PAGE);
  expect(await order(page)).toEqual(["examples", "frame", "explore", "dimensions", "details", "listings"]);
  const listings = page.locator("h3", { hasText: "External listings" }).locator("+ ul");
  await expect(listings.getByRole("listitem").getByRole("link")).toHaveText(["Earthmover Marketplace", "Source Cooperative", "AWS Open Data Registry"]);
  // Each row leads with its platform's logo, loaded, in place of a bullet.
  const logos = listings.locator("li > img:first-child");
  await expect(logos).toHaveCount(3);
  for (const logo of await logos.all()) {
    expect(await logo.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    expect((await logo.boundingBox()).width).toBe(16);
  }
  expect(await listings.evaluate((ul) => getComputedStyle(ul.firstElementChild).listStyleType)).toBe("none");
  // Nothing about them is left at the top of the page.
  await expect(page.locator(".catalog-item > table + p").getByRole("link")).toHaveText(["STAC", "browse", "validation report"]);
  await expect(page.getByRole("link", { name: "Earthmover Marketplace" })).toHaveCount(1);
  // The prompt tab replaces the setup pill on a product page.
  await expect(page.locator(".agent-setup-pill")).toHaveCount(0);
});

test("a product with no listing has no External listings", async ({ page }) => {
  // No platform lists the GFS virtual products yet (_data/listings.js).
  await page.goto("/catalog/noaa-gfs-forecast-virtual/");
  await expect(page.locator("h3", { hasText: "External listings" })).toHaveCount(0);
  expect(await order(page)).toEqual(["examples", "frame", "explore", "dimensions", "details"]);
});

test("the prompt tab shows and copies this product's prompt", async ({ page }) => {
  await page.goto(PAGE);
  const frame = page.locator(".frame").first();
  await expect(frame.getByRole("tab")).toHaveText(["dynamical-catalog", "pystac + icechunk", ...(gfsPrompt ? ["Prompt"] : [])]);
  if (!gfsPrompt) return;
  await frame.getByRole("tab", { name: "Prompt" }).click();
  const panel = frame.locator(".codeTabPanel:not([hidden])");
  await expect(panel).toHaveCount(1);
  const block = panel.locator(".agent-prompt[data-prompt=example-1-variant-3]");
  const text = await block.locator("textarea").inputValue();
  expect(text).toBe(gfsPrompt.code);
  await block.getByRole("button", { name: "copy to clipboard" }).click();
  await expect(block.locator("[role=status]")).toHaveText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  // Back to the code: one panel at a time.
  await frame.getByRole("tab", { name: "dynamical-catalog" }).click();
  await expect(block).toBeHidden();
  await expect(frame.locator(".codeTabPanel:not([hidden])")).toContainText("dynamical_catalog.open");
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
  if (!gfsPrompt) {
    await expect(frame.getByRole("tab", { name: "Prompt", exact: true })).toHaveCount(0);
    return;
  }
  await frame.getByRole("tab", { name: "dynamical-catalog" }).focus();
  await page.keyboard.press("End");
  const tab = frame.getByRole("tab", { name: "Prompt" });
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(frame.getByRole("tab", { name: "dynamical-catalog" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab).toBeFocused();
  // Tab enters the supplied prompt textarea, then its copy button.
  await page.keyboard.press("Tab");
  await expect(frame.locator(".codeTabPanel:not([hidden]) textarea")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(frame.getByRole("button", { name: "copy to clipboard" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame.locator(".codeTabPanel:not([hidden]) [role=status]")).toHaveText("copied");
  // Arrowing through tabs is not a choice of access path: only the copy counts.
  expect(events).toEqual([["agent_prompt_copied", { prompt: "example-1-variant-3", page: PAGE }]]);
});

test("choosing a code variant is tracked, visiting the prompt tab is not", async ({ page }) => {
  const events = await trackEvents(page);
  await page.goto(PAGE);
  const frame = page.locator(".frame").first();
  if (gfsPrompt) await frame.getByRole("tab", { name: "Prompt" }).click();
  await frame.getByRole("tab", { name: "pystac + icechunk" }).click();
  await expect(frame.locator(".codeTabPanel:not([hidden])")).toContainText("pystac");
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
    const promptTab = frame.getByRole("tab", { name: "Prompt" });
    if (await promptTab.count() === 0) return;
    await promptTab.click();
    const copy = await frame.getByRole("button", { name: "copy to clipboard" }).boundingBox();
    const box = await frame.boundingBox();
    expect(copy.x + copy.width).toBeLessThanOrEqual(box.x + box.width);
    expect(copy.y + copy.height).toBeLessThanOrEqual(box.y + box.height);
  });
}

test("every collection renders the exact STAC onboarding variant", async ({ page }) => {
  const { entries } = catalog;
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    await page.goto(`/catalog/${entry.id}/`);
    const variant = promptFor(entry);
    const textarea = page.locator('[data-prompt="example-1-variant-3"] textarea');
    if (variant) {
      expect(variant.label).toBe("Prompt");
      expect(await textarea.inputValue()).toBe(variant.code);
    } else await expect(textarea).toHaveCount(0);
    await expect(page.locator(".prompt-views")).toHaveCount(0);
  }
});
