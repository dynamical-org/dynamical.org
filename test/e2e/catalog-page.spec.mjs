import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// The order of a catalog page's sections, and the example frame's third tab:
// the prompt a reader hands to a coding agent. Tab switching, keyboard reach,
// the clipboard, and whether three tabs fit a phone's frame are all things
// `npm test` has no browser to see. Nothing here loads the explorer's data.

const PAGE = "/catalog/noaa-gfs-forecast/";
// STAC publishes separately; accept either spelling during the label rollout.
const PYSTAC_LABEL = /^(?:pystac|pystac \+ icechunk)$/;
const PROMPT_LABEL = /^(?:Prompt|prompt)$/;
const catalog = await require("../../_data/catalog.js")();
const promptFor = entry => entry.examples[0].variants.find(v => v.language === "text");
const gfsVariants = catalog.entries.find(e => e.id === "noaa-gfs-forecast").examples[0].variants;
const gfsPrompt = gfsVariants.find(v => v.language === "text");

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
  await expect(frame.getByRole("tab")).toHaveText(["dynamical-catalog", PYSTAC_LABEL, ...(gfsPrompt ? [PROMPT_LABEL] : [])]);
  if (!gfsPrompt) return;
  await frame.getByRole("tab", { name: PROMPT_LABEL }).click();
  const panel = frame.locator(".codeTabPanel:not([hidden])");
  await expect(panel).toHaveCount(1);
  const block = frame.locator('[data-prompt="example-1-variant-3"]');
  const text = await block.locator("textarea").inputValue();
  expect(text).toBe(gfsPrompt.code);
  await block.getByRole("button", { name: "Copy" }).click();
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
    await expect(frame.getByRole("tab", { name: PROMPT_LABEL, exact: true })).toHaveCount(0);
    return;
  }
  await frame.getByRole("tab", { name: "dynamical-catalog" }).focus();
  await page.keyboard.press("End");
  const tab = frame.getByRole("tab", { name: PROMPT_LABEL });
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
  await expect(frame.getByRole("button", { name: "Copy" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame.locator(".codeTabPanel:not([hidden]) [role=status]")).toHaveText("copied");
  // Arrowing through tabs is not a choice of access path: only the copy counts.
  expect(events).toEqual([["agent_prompt_copied", { prompt: "example-1-variant-3", page: PAGE }]]);
});

test("choosing a code variant is tracked, visiting the prompt tab is not", async ({ page }) => {
  const events = await trackEvents(page);
  await page.goto(PAGE);
  const frame = page.locator(".frame").first();
  if (gfsPrompt) await frame.getByRole("tab", { name: PROMPT_LABEL }).click();
  await frame.getByRole("tab", { name: PYSTAC_LABEL }).click();
  await expect(frame.locator(".codeTabPanel:not([hidden])")).toContainText("pystac");
  expect(events).toEqual([["snippet_variant_selected", { dataset: "noaa-gfs-forecast", variant: expect.stringMatching(PYSTAC_LABEL) }]]);
});

// Every tab and the visible brand mark stay inside the header, clear of each
// other, from a small phone through desktop. Offscreen tabs stay clipped to
// their scroll viewport; they never wrap or displace the wordmark.
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
    const list = await frame.getByRole("tablist").boundingBox();
    inside(list);
    for (const tab of tabs) expect(tab.y).toBe(tabs[0].y);
    const visibleTabs = tabs.map(t => ({ ...t, x: Math.max(t.x, list.x), width: Math.max(0, Math.min(t.x + t.width, list.x + list.width) - Math.max(t.x, list.x)) })).filter(t => t.width > 0);
    visibleTabs.forEach(inside);
    const marks = frame.locator(".frameBrand-wordmark img, .frameBrand-icon");
    for (const mark of await marks.all()) {
      if (!(await mark.isVisible())) continue;
      const m = await mark.boundingBox();
      inside(m);
      for (const t of visibleTabs) expect(t.x + t.width <= m.x || t.y + t.height <= m.y || m.y + m.height <= t.y).toBe(true);
    }
    // At 320px something else on the page already overflows by 8px (on main
    // too, 2026-09-29), so the page-width check holds from 375px.
    if (width >= 375) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const tab of await frame.getByRole("tab").all()) {
      await tab.click();
      const footer = frame.locator(".codeTabPanel:not([hidden]) .frameStatus");
      await expect(frame.getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
      await expectFooterFits(footer);
    }
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
      expect(variant.label).toMatch(PROMPT_LABEL);
      expect(await textarea.inputValue()).toBe(variant.code);
    } else await expect(textarea).toHaveCount(0);
    await expect(page.locator(".prompt-views")).toHaveCount(0);
  }
});

// Footer titles can use the full width now that copying lives over the panel.
async function expectFooterFits(footer) {
  const box = await footer.boundingBox();
  const title = await footer.locator(".frameStatusTitle").boundingBox();
  await expect(footer.getByRole("button")).toHaveCount(0);
  expect(title.x + title.width).toBeLessThanOrEqual(box.x + box.width);
  expect(await footer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}

test("every variant copies its exact source by keyboard without adding code-copy analytics", async ({ page }) => {
  const events = await trackEvents(page);
  await page.goto(PAGE);
  const frame = page.locator(".frame").first();
  for (const [i, variant] of gfsVariants.entries()) {
    await frame.getByRole("tab").first().focus();
    await page.keyboard.press("Home");
    for (let j = 0; j < i; j++) await page.keyboard.press("ArrowRight");
    await expect(frame.getByRole("tab", {name: variant.label, exact: true})).toBeFocused();
    await page.keyboard.press("Tab");
    // Textareas and scrollable code blocks are keyboard reachable before copy.
    const button = frame.locator(".codeTabPanel:not([hidden]) .example-copy");
    for (let j = 0; j < 2 && !(await button.evaluate(el => el === document.activeElement)); j++) await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-label", "Copy");
    await expect(button).toHaveCSS("outline-style", "solid");
    await expect(button).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(variant.code);
    const panel = frame.locator(".codeTabPanel:not([hidden])");
    await expect(panel.locator("[role=status]")).toHaveText("copied");
    await expect(panel.locator("[role=status]")).toHaveAttribute("aria-live", "polite");
    await expect(button.locator("svg").first()).toBeHidden();
    await expect(button.locator("svg").last()).toBeVisible();
    await expect(panel).not.toHaveAttribute("data-copy", "copied", { timeout: 2200 });
    await expect(button.locator("svg").first()).toBeVisible();
    await expect(button.locator("svg").last()).toBeHidden();
  }
  expect(events).toEqual(gfsPrompt ? [["agent_prompt_copied", {prompt: "example-1-variant-3", page: PAGE}]] : []);
});

test("example fallback copies source whitespace exactly", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.clipboard.writeText = async () => { throw new Error("clipboard unavailable"); };
    document.execCommand = () => { window.__fallbackText = document.activeElement.value; return true; };
  });
  await page.goto(PAGE);
  const panel = page.locator(".codeTabPanel").first();
  const source = '\n  quoted "<&>"\n\n    indented\n';
  await panel.locator(".example-source").evaluate((el, text) => { el.content.textContent = text; }, source);
  await panel.getByRole("button", {name: "Copy"}).click();
  expect(await page.evaluate(() => window.__fallbackText)).toBe(source);
  await expect(panel.locator("[role=status]")).toHaveText("copied");
});

test("a failed example copy announces a manual fallback without tracking a copy", async ({ page }) => {
  const events = await trackEvents(page);
  await page.addInitScript(() => {
    navigator.clipboard.writeText = async () => { throw new Error("clipboard unavailable"); };
    document.execCommand = () => false;
  });
  await page.setViewportSize({width: 320, height: 800});
  await page.goto(PAGE);
  const panel = page.locator(".codeTabPanel").first();
  await panel.getByRole("button", {name: "Copy"}).click();
  await expect(panel.locator("[role=status]")).toHaveText("select the text and copy it yourself");
  await expect(panel.locator("[role=status]")).toBeVisible();
  expect(await panel.locator(".frameStatus").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(events).toEqual([]);
});

for (const width of [320, 375, 1280]) {
  test(`long product footer fits at ${width}px for every variant`, async ({ page }) => {
    await page.setViewportSize({width, height: 900});
    await page.goto("/catalog/noaa-gefs-forecast-35-day/");
    const frame = page.locator(".frame").first();
    for (const tab of await frame.getByRole("tab").all()) {
      await tab.click();
      await expectFooterFits(frame.locator(".codeTabPanel:not([hidden]) .frameStatus"));
    }
  });
}

for (const id of ["noaa-gfs-forecast", "noaa-gefs-forecast-35-day", "noaa-hrrr-analysis"]) {
  for (const width of [320, 375, 1280]) {
    test(`styled complete examples: ${id} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({width, height: 900});
      const [stylesheet] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/main.css"),
        page.goto(`/catalog/${id}/`),
      ]);
      expect(stylesheet.ok()).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      const frame = page.locator(".frame").first();
      await expect(frame.locator(".frameHeader")).toHaveCSS("background-color", "rgb(0, 0, 0)");
      await expect(frame.getByRole("tab").first()).toHaveCSS("font-family", /monospace/);
      expect((await frame.boundingBox()).width).toBeLessThanOrEqual(780);
      const entry = catalog.entries.find(entry => entry.id === id);
      for (const variant of entry.examples[0].variants) {
        await frame.getByRole("tab", {name: variant.label, exact: true}).click();
        const panel = frame.locator(".codeTabPanel:not([hidden])");
        const title = variant.language === "text" ? "Onboarding prompt" : entry.examples[0].title;
        await expect(panel.locator(".frameStatusTitle")).toHaveText(`${entry.title} · ${title}`);
        await expectFooterFits(panel.locator(".frameStatus"));
        if (variant.language === "text") {
          const textarea = panel.locator("textarea");
          await expect(textarea).toHaveValue(variant.code);
          const size = await textarea.evaluate(el => ({width: el.clientWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, scrollWidth: el.scrollWidth}));
          expect(size.width).toBeGreaterThanOrEqual((await frame.boundingBox()).width - 32);
          expect(size.scrollHeight).toBeLessThanOrEqual(size.height + 1);
          expect(size.scrollWidth).toBeLessThanOrEqual(size.width + 1);
        }
      }
    });
  }
}

// Inspect the same rendered dither pixels used by table overflow, without
// storing screenshots. Sample inside the fade, clear of text and focus outlines.
for (const colorScheme of ["light", "dark"]) {
  test(`tabs scroll without wrapping and show only hidden-content hints (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(PAGE);
    const frame = page.locator(".frame").first();
    const list = frame.getByRole("tablist");
    const tabs = list.getByRole("tab");
    const edges = async () => {
      const { data, info } = await require("sharp")(await list.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const lit = (start) => {
        for (let y = 4; y < 8; y++) for (let x = start + 3; x < start + 11; x++) {
          if (data[(y * info.width + x) * info.channels] > 20) return true;
        }
        return false;
      };
      return { left: lit(0), right: lit(info.width - 14) };
    };
    expect(await list.evaluate(el => getComputedStyle(el).overflowX)).toBe("auto");
    expect(await list.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    const boxes = await Promise.all((await tabs.all()).map(t => t.boundingBox()));
    expect(boxes.every(b => b.y === boxes[0].y)).toBe(true);
    await expect(frame.locator(".frameBrand-wordmark")).toBeVisible();
    expect(await edges()).toEqual({ left: false, right: true });
    await tabs.first().focus();
    await page.keyboard.press("End");
    await expect(tabs.last()).toBeFocused();
    const bounds = await list.boundingBox();
    const last = await tabs.last().boundingBox();
    expect(last.x).toBeGreaterThanOrEqual(bounds.x);
    expect(last.x + last.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(await edges()).toEqual({ left: true, right: false });
    await page.keyboard.press("Home");
    await expect(tabs.first()).toBeFocused();
    expect(await edges()).toEqual({ left: false, right: true });
    await page.setViewportSize({ width: 1440, height: 800 });
    expect(await list.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
    expect(await edges()).toEqual({ left: false, right: false });
  });
}

for (const width of [320, 1280]) {
  test(`floating copy stays clear of text and fixed while content scrolls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(PAGE);
    const frame = page.locator(".frame").first();
    for (const tab of await frame.getByRole("tab").all()) {
      await tab.click();
      const header = await frame.locator(".frameHeader").boundingBox();
      const panel = frame.locator(".codeTabPanel:not([hidden])");
      const button = panel.getByRole("button", { name: "Copy", exact: true });
      await expect(button).toHaveText("");
      const copy = await button.boundingBox();
      const box = await panel.boundingBox();
      expect(copy.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(Math.abs(copy.y - box.y - 8)).toBeLessThan(1);
      expect(Math.abs(copy.x + copy.width - (box.x + box.width - 8))).toBeLessThan(1);
      const content = panel.locator("pre, textarea");
      const textTop = await content.evaluate(el => el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop));
      expect(copy.y + copy.height).toBeLessThanOrEqual(textTop);
      const scroll = await content.evaluate(el => {
        el.scrollLeft = el.scrollWidth;
        return { left: el.scrollLeft, code: el.tagName === "PRE" };
      });
      if (width === 320 && scroll.code) expect(scroll.left).toBeGreaterThan(0);
      expect(await button.boundingBox()).toEqual(copy);
      await expectFooterFits(panel.locator(".frameStatus"));
    }
  });
}
