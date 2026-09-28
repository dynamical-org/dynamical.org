import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const listings = require("../_data/listings.js");

// Each platform's public listing page, in the one shape that names a single
// listing. An Earthmover repo route (app.earthmover.io/dynamical/<repo>) is not
// a listing and redirects anonymous visitors to a login page.
const PAGE = {
  earthmover: /^https:\/\/app\.earthmover\.io\/marketplace\/[0-9a-f]{24}$/,
  source_coop: /^https:\/\/source\.coop\/dynamical\/[a-z0-9-]+$/,
  aws: /^https:\/\/registry\.opendata\.aws\/dynamical-[a-z0-9-]+\/$/,
};

test("every listing is a known platform's listing page", () => {
  for (const [id, entry] of Object.entries(listings)) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${id} is not a catalog id`);
    assert.ok(Object.keys(entry).length, `${id} has no listings; drop it`);
    for (const [platform, url] of Object.entries(entry)) {
      assert.ok(PAGE[platform], `${id}: unknown platform ${platform}`);
      assert.match(url, PAGE[platform], `${id}: ${platform}`);
    }
  }
});

test("no two datasets share an Earthmover or Source Cooperative listing", () => {
  // AWS registry pages are per model, so siblings share them by design.
  for (const platform of ["earthmover", "source_coop"]) {
    const urls = Object.values(listings).map((e) => e[platform]).filter(Boolean);
    assert.equal(new Set(urls).size, urls.length, platform);
  }
});
