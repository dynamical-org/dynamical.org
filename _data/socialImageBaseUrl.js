// Cloudflare Pages exposes the current deployment URL during preview builds.
// Point generated social images there so link debuggers can inspect the card
// under review; local and production builds keep the canonical origin.
const baseUrl = process.env.CF_PAGES_URL || "https://dynamical.org";

module.exports = baseUrl.replace(/\/+$/, "");
