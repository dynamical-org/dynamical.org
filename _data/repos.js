const fetch = require("@11ty/eleventy-fetch");

// Public, non-fork repositories under github.com/dynamical-org, each with the
// license GitHub detects from its LICENSE file. Rendered on /license/ so the
// list stays in sync as repos are added or relicensed, rather than being
// hand-maintained here.
module.exports = async function () {
  const githubHeaders = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};

  const repos = await fetch(
    "https://api.github.com/orgs/dynamical-org/repos?per_page=100",
    {
      duration: "1d",
      type: "json",
      fetchOptions: { headers: githubHeaders },
    }
  );

  return repos
    .filter((repo) => !repo.fork && !repo.private)
    .map((repo) => ({
      name: repo.name,
      url: repo.html_url,
      description: repo.description,
      // GitHub reports unrecognized license files as spdx_id "NOASSERTION";
      // treat those like a missing license rather than labeling them "Other".
      license:
        repo.license && repo.license.spdx_id !== "NOASSERTION"
          ? repo.license.name
          : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};
