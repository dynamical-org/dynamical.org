// Capture a completed static build, never an Eleventy watch server. For example:
// node scripts/capture-catalog-examples.mjs http://localhost:8000 /tmp/catalog-shots
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const [baseURL, output] = process.argv.slice(2);
assert(baseURL && output, "Pass the static site's URL and an output directory");
await mkdir(output, {recursive: true});
const browser = await chromium.launch();
const captures = [];
try {
  for (const id of ["noaa-gfs-forecast", "noaa-gefs-forecast-35-day", "noaa-hrrr-analysis"]) {
    for (const [size, width] of [["desktop", 1280], ["phone", 375]]) {
      const page = await browser.newPage({viewport: {width, height: 900}, colorScheme: "light"});
      const [css] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/main.css"),
        page.goto(`${baseURL}/catalog/${id}/`),
      ]);
      assert(css.ok(), `main.css returned ${css.status()}`);
      await page.evaluate(() => document.fonts.ready);
      assert(await page.evaluate(() => [...document.fonts].some(font => font.family.includes("IBM Plex Mono") && font.status === "loaded")), "IBM Plex Mono did not load");
      if (await page.locator("#latest-close").isVisible()) await page.locator("#latest-close").click();
      const frame = page.locator(".frame").first();
      await expect(frame.locator(".frameHeader")).toHaveCSS("background-color", "rgb(0, 0, 0)");
      await expect(frame.getByRole("tab").first()).toHaveCSS("font-family", /monospace/);
      assert((await frame.boundingBox()).width <= 780, "Frame's max-width styling is missing");
      for (const [label, slug] of [["dynamical-catalog", "dynamical-catalog"], ["pystac + icechunk", "pystac-icechunk"], ["Prompt", "prompt"]]) {
        await frame.getByRole("tab", {name: label, exact: true}).click();
        const panel = frame.locator(".codeTabPanel:not([hidden])");
        const footer = panel.locator(".frameStatus");
        const title = await footer.locator(".frameStatusTitle").boundingBox();
        const copy = await footer.getByRole("button").boundingBox();
        assert(title.x + title.width <= copy.x, "Footer overlaps its copy control");
        assert(Math.abs(title.y + title.height - copy.y - copy.height) < 1, "Footer baselines differ");
        let promptSize;
        if (label === "Prompt") {
          await expect(footer).toContainText("Onboarding prompt");
          const textarea = panel.locator("textarea");
          const source = await panel.locator(".example-source").evaluate(el => el.content.textContent);
          await expect(textarea).toHaveValue(source);
          promptSize = await textarea.evaluate(el => ({width: el.clientWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, scrollWidth: el.scrollWidth}));
          assert(promptSize.width >= (await frame.boundingBox()).width - 32, "Prompt does not fill the frame");
          assert(promptSize.scrollHeight <= promptSize.height + 1, "Prompt is clipped vertically");
          assert(promptSize.scrollWidth <= promptSize.width + 1, "Prompt is clipped horizontally");
        }
        await frame.screenshot({path: path.join(output, `${id}-${size}-${slug}.png`)});
        if (label === "Prompt") await page.screenshot({path: path.join(output, `${id}-${size}-page.png`)});
        captures.push({id, size, variant: label, url: page.url(), cssStatus: css.status(), cssSha256: createHash("sha256").update(await css.body()).digest("hex"), frame: await frame.boundingBox(), promptSize});
      }
      await page.close();
    }
  }
  await writeFile(path.join(output, "capture.json"), JSON.stringify(captures, null, 2) + "\n");
} finally {
  await browser.close();
}
