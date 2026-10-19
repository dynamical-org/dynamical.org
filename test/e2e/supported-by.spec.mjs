import { expect, test } from "@playwright/test";

// The Supported by section that closes the home and about pages: where it sits,
// where each logo leads, and that the logo matching the color scheme loads —
// a <picture> swap that `npm test` has no browser to see. Offline: the logos
// are local files and nothing follows the outbound links.

const PAGES = ["/", "/about/"];
const LINKS = [
  ["Registry of Open Data on AWS", "https://registry.opendata.aws/?search=managedBy:dynamical.org"],
  ["Source Cooperative", "https://source.coop/dynamical"],
  ["Radiant Earth", "https://radiant.earth/"],
];
const LOGOS = {
  light: ["/assets/supported-by/powered-by-aws.png", "/assets/supported-by/source-cooperative-light.svg"],
  dark: ["/assets/supported-by/powered-by-aws-white.png", "/assets/supported-by/source-cooperative-dark.svg"],
};

for (const path of PAGES) {
  test(`${path} closes with Supported by, just above the footer`, async ({ page }) => {
    await page.goto(path);
    const section = page.locator("section", { has: page.locator(".supported-by") });
    await expect(section.getByRole("heading", { level: 2 })).toHaveText("Supported by");
    // Nothing but scripts between it and the footer.
    expect(
      await section.evaluate((el) => {
        let next = el.nextElementSibling;
        while (next && next.tagName === "SCRIPT") next = next.nextElementSibling;
        return next?.tagName;
      }),
    ).toBe("FOOTER");
    if (path === "/") {
      expect(await page.locator("#research").evaluate((r, s) => !!(r.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING), await section.elementHandle())).toBe(true);
    }
    const links = section.getByRole("link");
    await expect(links).toHaveText(LINKS.map(([name]) => name));
    for (const [i, [, href]] of LINKS.entries()) await expect(links.nth(i)).toHaveAttribute("href", href);
  });

  for (const scheme of ["light", "dark"]) {
    test(`${path} shows the ${scheme} logos`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      const logos = page.locator(".supported-by img");
      await expect(logos).toHaveCount(2);
      for (const [i, src] of LOGOS[scheme].entries()) {
        const logo = logos.nth(i);
        await expect.poll(() => logo.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
        expect(new URL(await logo.evaluate((img) => img.currentSrc)).pathname).toBe(src);
        expect((await logo.boundingBox()).height).toBe(32);
      }
    });
  }
}
