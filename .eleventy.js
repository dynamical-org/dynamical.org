const { DateTime } = require("luxon");
const pluginRss = require("@11ty/eleventy-plugin-rss");
const pluginSyntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const { pairedShortcode } = require("@11ty/eleventy-plugin-syntaxhighlight");
const { EleventyHtmlBasePlugin } = require("@11ty/eleventy");
const fetch = require("@11ty/eleventy-fetch");
const fs = require("fs");
const path = require("path");

const crypto = require("crypto");

const pluginImages = require("./eleventy.config.images.js");

const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "github-contributors.json");
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

function mergeClasses(existingClasses, extraClasses) {
  const existing = String(existingClasses || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const extra = String(extraClasses || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...extra, ...existing])).join(" ");
}

function postprocessHighlightedHtml(html, extraPreClasses) {
  if (typeof html !== "string") return html;

  let out = html;

  if (extraPreClasses) {
    // Inject classes into the *first* <pre ...> tag produced by the syntaxhighlight plugin.
    out = out.replace(/<pre\b([^>]*)>/, (fullMatch, attrs) => {
      if (/\bclass\s*=/.test(attrs)) {
        const updatedAttrs = attrs.replace(/\bclass="([^"]*)"/, (m, cls) => {
          return `class="${mergeClasses(cls, extraPreClasses)}"`;
        });
        return `<pre${updatedAttrs}>`;
      }

      // attrs includes any leading whitespace (e.g. ` tabindex="0"`), so this stays valid.
      return `<pre class="${extraPreClasses}"${attrs}>`;
    });
  }

  // Eleventy syntaxhighlight outputs <br> tags for line breaks. That's fragile if any
  // client-side code ever reads/writes `.textContent` (which drops <br>), collapsing
  // the entire block into one line. Convert <br> to literal newlines to be robust.
  out = out.replace(/<br\s*\/?>/gi, "\n");

  return out;
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "./public/": "/" });

  eleventyConfig.addPlugin(pluginRss);
  eleventyConfig.addPlugin(EleventyHtmlBasePlugin);

  eleventyConfig.addPlugin(pluginSyntaxHighlight, {
    preAttributes: { tabindex: 0 },
  });
  // Filter form: {{ code | highlight("py", "extra classes...") }}
  eleventyConfig.addFilter("highlight", function (content, language, preClasses) {
    return postprocessHighlightedHtml(pairedShortcode(content, language), preClasses);
  });

  // Paired-shortcode form:
  // {% frameHighlight "py", "frameContent frameContentDesktop" %}...{% endframeHighlight %}
  eleventyConfig.addPairedShortcode(
    "frameHighlight",
    function (content, language, preClasses) {
      return postprocessHighlightedHtml(pairedShortcode(content, language), preClasses);
    }
  );

  eleventyConfig.addPlugin(pluginImages);

  eleventyConfig.addFilter("fileHash", function (filePath) {
    const content = fs.readFileSync(path.join(__dirname, filePath));
    return crypto.createHash("md5").update(content).digest("hex").slice(0, 8);
  });

  eleventyConfig.addShortcode("currentBuildDate", () => {
    return new Date().toISOString();
  });

  eleventyConfig.addFilter("readableDate", (dateObj, format, zone) => {
    // Formatting tokens for Luxon: https://moment.github.io/luxon/#/formatting?id=table-of-tokens
    return DateTime.fromJSDate(dateObj, { zone: zone || "utc" }).toFormat(
      format || "yyyy-MM-dd"
    );
  });

  // Override the RSS plugin's dateToRfc822 filter to properly handle UTC conversion
  eleventyConfig.addFilter("dateToRfc822", (dateObj) => {
    // Convert to UTC using Luxon to ensure proper timezone handling
    const utcDate = DateTime.fromJSDate(dateObj, { zone: "utc" });
    return utcDate.toFormat("ccc, dd LLL yyyy HH:mm:ss '+0000'");
  });

  // Add ISO date filter for consistent UTC output
  eleventyConfig.addFilter("isoDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj, { zone: "utc" }).toISO();
  });

  eleventyConfig.addGlobalData("contributors", async () => {
    const githubHeaders = process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {};

    // Fetch all repos for the org
    const repos = await fetch(
      "https://api.github.com/orgs/dynamical-org/repos",
      {
        duration: "1d",
        type: "json",
        fetchOptions: { headers: githubHeaders },
      }
    );

    const contributorsSet = new Set();

    // Only include non-forked repos
    const primaryRepos = repos.filter((repo) => !repo.fork);

    for (const repo of primaryRepos) {
      const repoContributors = await fetch(repo.contributors_url, {
        duration: "1d",
        type: "json",
        fetchOptions: { headers: githubHeaders },
      });

      repoContributors.forEach((contributor) => {
        if (contributor.type !== "Bot") {
          contributorsSet.add(contributor.login);
        }
      });
    }

    const botLogins = new Set(["dependabot[bot]", "claude", "Copilot"]);
    const contributorsList = Array.from(contributorsSet)
      .filter((login) => !botLogins.has(login))
      .sort();
    return contributorsList;
  });

  eleventyConfig.addAsyncFilter("embedNotebookContent", async function (url) {
    try {
      // Use eleventy-fetch with caching
      const json = await fetch(url, {
        duration: "1d",
        type: "json",
      });

      // Remove outputs from notebook cells, they spew a lot of data that's not LLM friendly.
      const cleanedNotebook = JSON.parse(JSON.stringify(json));
      if (cleanedNotebook.cells) {
        cleanedNotebook.cells.forEach((cell) => {
          cell.outputs = [];
        });
      }

      return `<pre>${JSON.stringify(cleanedNotebook, null, 2)}</pre>`;
    } catch (error) {
      console.error(`Error fetching notebook from ${url}:`, error);
      return `<p>Error loading notebook content: ${error.message}</p>`;
    }
  });

  eleventyConfig.addFilter("roundIfNumber", function (value, decimals) {
    if (typeof value === "number") {
      const factor = Math.pow(10, decimals ?? 0);
      return Math.round(value * factor) / factor;
    }
    return value;
  });

  eleventyConfig.addFilter("find", function (array, property, value) {
    if (!Array.isArray(array)) {
      return undefined;
    }
    return array.find((item) => item[property] === value);
  });

  eleventyConfig.addFilter("rejectWhere", function (array, property, value) {
    if (!Array.isArray(array)) {
      return [];
    }
    return array.filter((item) => item[property] !== value);
  });

  // STAC catalog generation filters
  const STAC_BASE_URL = "https://dynamical.org/stac";

  eleventyConfig.addFilter("stacCatalog", function (entries) {
    const liveEntries = entries.filter(
      (e) => e.status !== "deprecated" && e.dataset_id
    );
    return {
      type: "Catalog",
      id: "dynamical-org",
      stac_version: "1.0.0",
      description:
        "Cloud-optimized weather and climate datasets from dynamical.org",
      links: [
        {
          rel: "self",
          href: `${STAC_BASE_URL}/catalog.json`,
          type: "application/json",
        },
        {
          rel: "root",
          href: `${STAC_BASE_URL}/catalog.json`,
          type: "application/json",
        },
        ...liveEntries.map((e) => ({
          rel: "child",
          href: `./${e.dataset_id}/collection.json`,
          type: "application/json",
          title: e.name,
        })),
      ],
    };
  });

  eleventyConfig.addFilter("stacCollection", function (entry) {
    if (!entry || !entry.dataset_id || !entry.url) {
      return {};
    }

    const assets = {
      zarr: {
        href: entry.url,
        type: "application/x-zarr",
        title: "Zarr v3 store",
        roles: ["data"],
        "xarray:open_kwargs": {
          engine: "zarr",
        },
      },
    };

    if (entry.icechunk) {
      assets.icechunk = {
        href: `s3://${entry.icechunk.bucket}/${entry.icechunk.prefix}`,
        type: "application/x-icechunk",
        title: "Icechunk repository",
        roles: ["data"],
        "icechunk:storage": {
          bucket: entry.icechunk.bucket,
          prefix: entry.icechunk.prefix,
          region: entry.icechunk.region,
        },
        "xarray:open_kwargs": {
          engine: "zarr",
          chunks: null,
        },
      };
    }

    // Compute bbox from latitude/longitude coordinate statistics
    const allArrays = [...(entry.dimensions || []), ...(entry.variables || [])];
    const latArray = allArrays.find((a) => a.standard_name === "latitude");
    const lonArray = allArrays.find((a) => a.standard_name === "longitude");
    const bbox =
      latArray?.statistics_approximate && lonArray?.statistics_approximate
        ? [
            lonArray.statistics_approximate.min,
            latArray.statistics_approximate.min,
            lonArray.statistics_approximate.max,
            latArray.statistics_approximate.max,
          ]
        : [-180, -90, 180, 90];

    // Compute temporal start from time dimension statistics
    const timeDim = (entry.dimensions || []).find(
      (d) =>
        d.name === "time" || d.name === "init_time" || d.name === "valid_time"
    );
    const tMin = timeDim?.statistics_approximate?.min;
    const temporalStart =
      tMin && tMin !== "Present"
        ? tMin.endsWith("Z")
          ? tMin
          : `${tMin}Z`
        : null;

    // Datacube extension: dimensions and variables from zarr metadata
    const cubeDimensions = {};
    for (const dim of entry.dimensions || []) {
      if (dim.name === "latitude" || dim.name === "y") {
        cubeDimensions[dim.name] = {
          type: "spatial",
          axis: "y",
          extent: dim.statistics_approximate
            ? [dim.statistics_approximate.min, dim.statistics_approximate.max]
            : [bbox[1], bbox[3]],
        };
      } else if (dim.name === "longitude" || dim.name === "x") {
        cubeDimensions[dim.name] = {
          type: "spatial",
          axis: "x",
          extent: dim.statistics_approximate
            ? [dim.statistics_approximate.min, dim.statistics_approximate.max]
            : [bbox[0], bbox[2]],
        };
      } else if (
        dim.name === "time" ||
        dim.name === "init_time" ||
        dim.name === "valid_time"
      ) {
        const dimMin = dim.statistics_approximate?.min;
        const dimStart =
          dimMin && dimMin !== "Present"
            ? dimMin.endsWith("Z")
              ? dimMin
              : `${dimMin}Z`
            : null;
        cubeDimensions[dim.name] = {
          type: "temporal",
          extent: [dimStart, null],
        };
      } else {
        cubeDimensions[dim.name] = { type: "other", extent: [null, null] };
      }
      if (dim.units) cubeDimensions[dim.name].unit = dim.units;
      cubeDimensions[dim.name].size = dim.shape[0];
    }

    const cubeVariables = {};
    for (const v of entry.variables || []) {
      const varObj = {
        dimensions: v.dimension_names,
        type: "data",
      };
      if (v.units) varObj.unit = v.units;
      cubeVariables[v.name] = varObj;
    }

    return {
      type: "Collection",
      id: entry.dataset_id,
      stac_version: "1.0.0",
      stac_extensions: [
        "https://stac-extensions.github.io/xarray-assets/v1.0.0/schema.json",
        "https://stac-extensions.github.io/datacube/v2.2.0/schema.json",
      ],
      title: entry.name,
      description: entry.description || "",
      license: "CC-BY-4.0",
      "cube:dimensions": cubeDimensions,
      "cube:variables": cubeVariables,
      extent: {
        spatial: { bbox: [bbox] },
        temporal: { interval: [[temporalStart, null]] },
      },
      assets,
      links: [
        {
          rel: "self",
          href: `${STAC_BASE_URL}/${entry.dataset_id}/collection.json`,
          type: "application/json",
        },
        {
          rel: "root",
          href: `${STAC_BASE_URL}/catalog.json`,
          type: "application/json",
        },
        {
          rel: "parent",
          href: `${STAC_BASE_URL}/catalog.json`,
          type: "application/json",
        },
        {
          rel: "about",
          href: `https://dynamical.org/catalog/${entry.dataset_id}/`,
          type: "text/html",
          title: "Dataset documentation",
        },
        ...(entry.githubUrl
          ? [
              {
                rel: "example",
                href: entry.githubUrl,
                type: "application/x-ipynb+json",
                title: "Example notebook (GitHub)",
              },
            ]
          : []),
        ...(entry.colabUrl
          ? [
              {
                rel: "example",
                href: entry.colabUrl,
                type: "text/html",
                title: "Example notebook (Colab)",
              },
            ]
          : []),
        ...(entry.githubIcechunkUrl
          ? [
              {
                rel: "example",
                href: entry.githubIcechunkUrl,
                type: "application/x-ipynb+json",
                title: "Icechunk example notebook (GitHub)",
              },
            ]
          : []),
      ],
    };
  });

  return {
    dir: {
      input: "content",
      includes: "../_includes",
      data: "../_data",
      output: "docs",
    },
  };
};
