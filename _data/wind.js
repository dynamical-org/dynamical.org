const fetch = require("@11ty/eleventy-fetch");
const fs = require("fs");
const path = require("path");

const LOCAL_PATH = path.join(__dirname, "..", ".cache", "wind-data.json");
const R2_URL = "https://data.dynamical.org/site/wind-data.json";

module.exports = async function () {
  // Dev: use local file if it exists
  if (fs.existsSync(LOCAL_PATH)) {
    return JSON.parse(fs.readFileSync(LOCAL_PATH, "utf-8"));
  }

  // Prod: fetch from R2 (cached for 1 day by eleventy-fetch)
  try {
    return fetch(R2_URL, { duration: "1d", type: "json" });
  } catch (e) {
    console.log(`Wind data fetch failed: ${e.message}`);
    return null;
  }
};
