const fetch = require("@11ty/eleventy-fetch");
const markdownToc = require("../lib/markdown-toc.js");

// Keep in sync with RECENT_INIT_COUNT in public/wxopticon.js
const RECENT_INIT_COUNT = 10;

const DISPLAY_NAMES = {
  "noaa-gfs-aws": "NOAA GFS",
  "noaa-gfs-ftp": "NOAA GFS",
  "noaa-gefs-short-aws": "NOAA GEFS 16-day",
  "noaa-gefs-short-ftp": "NOAA GEFS 16-day",
  "noaa-gefs-long-aws": "NOAA GEFS 35-day",
  "noaa-gefs-long-ftp": "NOAA GEFS 35-day",
  "noaa-hrrr-aws": "NOAA HRRR 48h",
  "noaa-hrrr-ftp": "NOAA HRRR 48h",
  "ecmwf-aifs-aws": "ECMWF AIFS Single",
  "ecmwf-aifs-ens-aws": "ECMWF AIFS ENS",
  "ecmwf-ifs-ens-long-aws": "ECMWF IFS ENS 15-day",
  "ecmwf-ifs-ens-short-aws": "ECMWF IFS ENS 6-day",
  "dwd-icon-eu": "DWD ICON-EU 5-day",
  // dynamical.org derived products (Icechunk stores).
  "dynamical-noaa-gfs-forecast": "NOAA GFS",
  "dynamical-noaa-gefs-forecast-35-day": "NOAA GEFS 35-day",
  "dynamical-noaa-hrrr-forecast-48-hour": "NOAA HRRR 48h",
  "dynamical-ecmwf-aifs-single-forecast": "ECMWF AIFS Single",
  "dynamical-ecmwf-aifs-ens-forecast": "ECMWF AIFS ENS",
  "dynamical-ecmwf-ifs-ens-forecast-15-day-0-25-degree": "ECMWF IFS ENS 15-day",
  "dynamical-dwd-icon-eu-forecast-5-day": "DWD ICON-EU 5-day",
};

// "dynamical.org" = our published Icechunk catalog products (id prefixed
// `dynamical-`); everything else is the upstream "Source" track.
function trackOf(id) {
  return id.startsWith("dynamical-") ? "dynamical" : "source";
}

// Derive the issuing agency from the id, ignoring the `dynamical-` prefix so
// a derived product classifies the same as its upstream source.
function agencyOf(id) {
  const base = id.replace(/^dynamical-/, "");
  if (/noaa|gfs|gefs|hrrr/.test(base)) return "NOAA";
  if (/ecmwf|aifs|ifs/.test(base)) return "ECMWF";
  if (/dwd|icon/.test(base)) return "DWD";
  return null;
}

// Where the row's data comes from: our Icechunk catalog ("dynamical.org") for
// derived products, or the upstream host for sources.
function originOf(id) {
  if (id.startsWith("dynamical-")) return "dynamical.org";
  if (id.endsWith("-aws")) return "AWS";
  if (id.endsWith("-ftp")) return "NOMADS";
  if (id.startsWith("dwd-")) return "DWD";
  return null;
}

// Order origins shown in the filter (and used as the row's left-column label).
const ORIGIN_ORDER = ["dynamical.org", "AWS", "NOMADS", "DWD"];

module.exports = async function () {
  const summary = await fetch(
    "https://assets.dynamical.org/wxopticon/summary.json",
    { duration: "1d", type: "json" }
  );

  const products = summary.products.map((p) => ({
    id: p.id,
    label: DISPLAY_NAMES[p.id] ?? p.label ?? p.id,
    track: trackOf(p.id),
    agency: agencyOf(p.id),
    origin: originOf(p.id),
    source: p.source,
    cadence_hours: p.cadence_hours,
    init_hours: [...new Set(p.recent_inits.map((i) => i.init_time.slice(11, 13)))].sort(),
    recent_init_count: Math.min(p.recent_inits.length, RECENT_INIT_COUNT),
    // Pass lead-group shape through so the build-time skeleton can allocate
    // one sub-bar per group before hydration (and a sibling label column).
    // Absent for pre-lead-groups summaries — wxopticon.js falls back to a
    // single fill in that case.
    lead_groups: (() => {
      const groups = p.lead_group_stats ?? [];
      if (groups.length === 0) return [];
      const total = groups[groups.length - 1].leads_in_group;
      let prev = 0;
      return groups.map((g) => {
        const slice = g.leads_in_group - prev;
        const center_pct = total > 0 ? ((prev + slice / 2) / total) * 100 : 0;
        prev = g.leads_in_group;
        return {
          name: g.name,
          label: g.label,
          leads_in_group: g.leads_in_group,
          center_pct,
        };
      });
    })(),
  }));

  // Group rows by model (their shared display label). Within a group the
  // dynamical.org row leads, then its upstream Source row(s). Groups with a
  // dynamical.org product sort ahead of source-only models; both otherwise
  // preserve first-appearance order from the summary (which clusters by
  // agency). Map iteration + stable sort keep that order intact.
  const byModel = new Map();
  for (const p of products) {
    if (!byModel.has(p.label)) byModel.set(p.label, []);
    byModel.get(p.label).push(p);
  }
  const groups = [...byModel.entries()].map(([model, items]) => {
    items.sort((a, b) => (a.track === b.track ? 0 : a.track === "dynamical" ? -1 : 1));
    return {
      model,
      // Anchor target for the table-of-contents link / group heading id.
      slug: markdownToc.slugify(model),
      hasDynamical: items.some((p) => p.track === "dynamical"),
      products: items,
    };
  });
  groups.sort((a, b) => (a.hasDynamical === b.hasDynamical ? 0 : a.hasDynamical ? -1 : 1));

  // Distinct origins present, in display order — drives the Source filter.
  const origins = ORIGIN_ORDER.filter((o) => products.some((p) => p.origin === o));

  // Scroll-spy TOC of the model groups, reusing the same builder/CSS/JS as
  // the validation report pages so the rail looks and behaves identically.
  const tocHtml = markdownToc.buildTocHtml(
    groups.map((g) => ({ level: 2, slug: g.slug, title: g.model })),
  );

  return {
    groups,
    origins,
    window_days: summary.window_days,
    tocHtml,
    tocCss: markdownToc.CSS,
    tocJs: markdownToc.JS,
  };
};
