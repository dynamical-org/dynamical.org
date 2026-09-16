import {
  html,
  render,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "./vendor/preact-htm.mjs";
import {
  agencyHealth,
  renderHealth,
  systemHealth,
} from "./status-health.mjs";
import { setupTimeToggle } from "./status-time.mjs";

const POLL_INTERVAL_MS = 15_000;
const HEALTH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const DASHBOARD_VERSIONS = new Set([2, 3]); // granular schemas; the lead-only shape is gone
// Field geometry. JS owns these because the run count is computed from them;
// the CSS reads them back off the field as custom properties.
const CELL_PX = 12; // one measurement, the same size in every view
const CLUMP_GAP_PX = 2; // between the lead columns within one run
const RUN_GAP_PX = 6; // between init columns, as main spaced its bars
const FACET_CELL_PX = 8; // compact rows when a facet owns the vertical axis
const FACET_CLUMP_GAP_PX = 1; // lead columns remain visibly separate
const FACET_RUN_GAP_PX = 6; // separate runs after the lead columns compact
const FACET_BAND_GAP_PX = 4; // use the reserved height between compact rows
const FACET_LANES = 2; // two chronological rows show more runs without crowding
const FACET_LANE_GAP_PX = 10;
// no lead group is thinner than its own label: "0h" is two characters, which is
// exactly one cell, so every group can name itself
const MIN_LEAD_PX = 12;
const FACET_MIN_LEAD_PX = 12; // every lead group keeps room for its text label
const FACET_LEAD_ALLOWANCE_PX = 5;
const BAND_GAP_PX = 2; // between bands, inside a field
const LABEL_PX = 12; // one axis-label row
const CH_PX = 6; // one monospace character at the band-label size
const GUTTER_MAX_CH = 24; // long facet labels get room, but not unbounded
const RUNS_MAX = 10; // what the payload carries
const QUANTILE_ORDER_TOLERANCE_S = 1e-9;

function hasTimestamp(value) {
  return (
    typeof value === "string" &&
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function hasUtcTimestamp(value) {
  return (
    typeof value === "string" &&
    /(?:Z|\+00:?00)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validFacets(facets) {
  return (
    Array.isArray(facets) &&
    facets.every(
      (facet) =>
        typeof facet.dimension === "string" &&
        typeof facet.name === "string" &&
        typeof facet.label === "string" &&
        Number.isInteger(facet.dependencies_available) &&
        facet.dependencies_available >= 0 &&
        Number.isInteger(facet.dependencies_expected) &&
        facet.dependencies_expected > 0 &&
        facet.dependencies_available <= facet.dependencies_expected &&
        Number.isFinite(facet.completion_pct) &&
        facet.completion_pct >= 0 &&
        facet.completion_pct <= 1 &&
        typeof facet.status === "string" &&
        (facet.completed_at == null || hasUtcTimestamp(facet.completed_at)),
    )
  );
}

function validPipelineLagStats(stats) {
  if (!stats) return false;
  const values = [stats.p50_s, stats.p95_s, stats.p99_s, stats.avg_s];
  if (
    !values.every((value) => value === null || Number.isFinite(value)) ||
    !Number.isInteger(stats.sample_init_count) ||
    stats.sample_init_count < 0 ||
    !Number.isInteger(stats.sample_day_count) ||
    stats.sample_day_count < 0 ||
    stats.sample_day_count > stats.sample_init_count
  ) {
    return false;
  }
  if (stats.sample_init_count === 0) {
    return stats.sample_day_count === 0 && values.every((value) => value === null);
  }
  return (
    stats.sample_day_count > 0 &&
    values.every(Number.isFinite) &&
    stats.p50_s <= stats.p95_s + QUANTILE_ORDER_TOLERANCE_S &&
    stats.p95_s <= stats.p99_s + QUANTILE_ORDER_TOLERANCE_S
  );
}

function validPipelineLag(lag) {
  if (
    !lag ||
    !["ready", "pending"].includes(lag.status) ||
    !["shared_nat_prs_sfc", "whole_run"].includes(lag.basis) ||
    !Array.isArray(lag.source_ids) ||
    lag.source_ids.length === 0 ||
    !lag.source_ids.every((sourceId) => typeof sourceId === "string" && sourceId !== "") ||
    !Number.isInteger(lag.window_days) ||
    lag.window_days <= 0
  ) {
    return false;
  }
  if (lag.status === "pending") {
    return (
      lag.window_start === null &&
      lag.window_end === null &&
      lag.generated_at === null &&
      lag.stats === null
    );
  }
  return (
    hasUtcTimestamp(lag.window_start) &&
    hasUtcTimestamp(lag.window_end) &&
    hasUtcTimestamp(lag.generated_at) &&
    Date.parse(lag.window_start) <= Date.parse(lag.window_end) &&
    validPipelineLagStats(lag.stats)
  );
}

export function validateDashboard(data) {
  if (
    !data ||
    !DASHBOARD_VERSIONS.has(data.v) ||
    !hasTimestamp(data.generated_at) ||
    !Array.isArray(data.groups) ||
    data.groups.length === 0 ||
    !Array.isArray(data.advisories)
  ) {
    throw new TypeError("Invalid pipeline dashboard");
  }
  for (const group of data.groups) {
    if (
      typeof group.id !== "string" ||
      typeof group.label !== "string" ||
      !Array.isArray(group.products) ||
      group.products.length === 0
    ) {
      throw new TypeError("Invalid pipeline group");
    }
    for (const product of group.products) {
      if (
        typeof product.id !== "string" ||
        typeof product.row_label !== "string" ||
        !Array.isArray(product.recent_inits) ||
        product.recent_inits.length > 10
      ) {
        throw new TypeError("Invalid pipeline product");
      }
      // the details table keys its rows on these names, so a product's
      // stats must each carry one, and no two the same
      if (product.lead_group_stats != null) {
        const names = new Set();
        if (
          !Array.isArray(product.lead_group_stats) ||
          !product.lead_group_stats.every(
            (stats) =>
              typeof stats.name === "string" &&
              stats.name !== "" &&
              !names.has(stats.name) &&
              names.add(stats.name),
          )
        ) {
          throw new TypeError("Invalid pipeline lead group stats");
        }
      }
      if (product.facet_groups != null) {
        if (
          !Array.isArray(product.facet_groups) ||
          product.facet_groups.length === 0 ||
          !product.facet_groups.every(
            (facet) =>
              typeof facet.dimension === "string" &&
              typeof facet.name === "string" &&
              typeof facet.label === "string",
          )
        ) {
          throw new TypeError("Invalid pipeline facet group");
        }
      }
      if (
        Object.hasOwn(product, "pipeline_lag") &&
        !validPipelineLag(product.pipeline_lag)
      ) {
        throw new TypeError("Invalid pipeline lag");
      }
      for (const init of product.recent_inits) {
        if (
          Object.hasOwn(init, "pipeline_lag_s") &&
          !Number.isFinite(init.pipeline_lag_s)
        ) {
          throw new TypeError("Invalid pipeline lag");
        }
        if (init.facets != null && !validFacets(init.facets)) {
          throw new TypeError("Invalid pipeline facet");
        }
        // the lead × facet joint: the same facet shape, reported per lead group
        for (const group of init.lead_groups ?? []) {
          if (group.facets == null) continue;
          if (!validFacets(group.facets)) {
            throw new TypeError("Invalid pipeline facet");
          }
        }
      }
    }
  }
  return data;
}

export function agencySummary(advisories) {
  const health = agencyHealth(advisories ?? []);
  return { state: health.state, label: health.value };
}

export function displaySource(source) {
  return source?.replace(/^https?:\/\//, "") ?? "—";
}

export function displayRowLabel(label) {
  return label === "dynamical.org · virtual" ? "dynamical.org" : label;
}

function productsOf(dashboard) {
  return dashboard.groups.flatMap((group) => group.products);
}

function formatLatency(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

// a lag can run either way: the source's completion is wxopticon's stricter
// one — every component and lead of the run — so dynamical can finish first,
// and the column has to carry a sign
function formatSignedLatency(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return seconds < 0
    ? `−${formatLatency(-seconds)}`
    : formatLatency(seconds);
}

function formatDuration(seconds) {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/* Every square carries a hover label, so a faceted row asks for hundreds of
   formatted init times per render. Constructing an Intl formatter each time
   dominated the render; these two caches are keyed by the only things that
   vary. */

const initFormatters = new Map();
const initPartCache = new Map();
const INIT_PART_CACHE_MAX = 4096;

function initFormatter(timeZone) {
  let formatter = initFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      timeZone,
      timeZoneName: "short",
    });
    initFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function initParts(timestamp, timeZone = "UTC") {
  const key = `${timestamp}|${timeZone}`;
  const cached = initPartCache.get(key);
  if (cached) return cached;

  const parts = initFormatter(timeZone).formatToParts(new Date(timestamp));
  const part = (type) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const hour = part("hour");
  const value = {
    date: `${part("month")}-${part("day")}`,
    time: timeZone === "UTC" ? `${hour}z` : `${hour} ${part("timeZoneName")}`,
  };
  // the rolling init window would otherwise grow this without bound
  if (initPartCache.size >= INIT_PART_CACHE_MAX) initPartCache.clear();
  initPartCache.set(key, value);
  return value;
}

const validTimeZoneCache = new Map();

// Some browsers report a non-standard IANA zone (e.g. "Etc/Unknown") from
// resolvedOptions().timeZone, which Intl.DateTimeFormat itself rejects.
function isValidTimeZone(timeZone) {
  let valid = validTimeZoneCache.get(timeZone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      valid = true;
    } catch {
      valid = false;
    }
    validTimeZoneCache.set(timeZone, valid);
  }
  return valid;
}

// Resolved once, after validation: every hover label asks for the zone, and both
// resolving and validating it mean constructing a formatter.
let localZone = null;

export function selectedTimeZone(local) {
  if (!local) return "UTC";
  if (localZone === null) {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    localZone = isValidTimeZone(resolved) ? resolved : "UTC";
  }
  return localZone;
}

function initShort(timestamp, local) {
  const { date, time } = initParts(timestamp, selectedTimeZone(local));
  return `${date} ${time}`;
}

function formatTime(timestamp, local, includeZone = true) {
  const options = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: local ? undefined : "UTC",
  };
  if (includeZone) options.timeZoneName = "short";
  return new Intl.DateTimeFormat(undefined, options).format(
    new Date(timestamp),
  );
}

export function clockTime(timestamp, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(timestamp));
}

function TimeNode({ timestamp }) {
  return html`<span>
    <span class="pipeline-time-utc">${formatTime(timestamp, false, false)}</span>
    <span class="pipeline-time-local-only">
      ${formatTime(timestamp, true, false)}
    </span>
  </span>`;
}

/* One square per measurement. Lead-group counts arrive cumulative, so a band's
   own share is the difference from the band below it. */

function leadSlices(groups) {
  let previousAvailable = 0;
  let previousExpected = 0;
  return groups.map((group) => {
    const expected = group.leads_expected - previousExpected;
    const available = group.leads_available - previousAvailable;
    previousExpected = group.leads_expected;
    previousAvailable = group.leads_available;
    return {
      name: group.name,
      status: group.status,
      timing: group.timing,
      available,
      expected,
      completion: expected
        ? Math.max(0, Math.min(1, available / expected))
        : (group.completion_pct ?? 0),
    };
  });
}

/* The lead groups a product measures, shortest horizon first — the order the
   dashboard payload declares them in. */

export function leadAxis(product) {
  const labelOf = new Map(
    (product.lead_group_stats ?? []).map((stats) => [stats.name, stats.label]),
  );
  return (product.lead_groups ?? []).map((group) => ({
    kind: "lead",
    key: group.name,
    label: group.label ?? labelOf.get(group.name) ?? group.name,
  }));
}

/* How much of the lead axis each group takes. Main's bars sized a segment by
   the group's share of the run's expected files, and this keeps that reading:
   the cell size is constant across views, and the lead dimension stretches.
   The total stays what uniform cells would have occupied, so a view's footprint
   does not change, and a floor keeps the smallest group from vanishing — GEFS
   f000 is 0.7% of its run, which would round to nothing. */

export function leadExtents(product) {
  const leads = leadAxis(product);
  const newest = product.recent_inits?.at(-1);
  const slices = leadSlices(newest?.lead_groups ?? []);
  const expected = leads.map(
    (lead) => slices.find((slice) => slice.name === lead.key)?.expected ?? 0,
  );
  const total = expected.reduce((sum, count) => sum + count, 0);
  // every group starts at its label's width, then shares out an allowance the
  // size of the axis again — so the biggest group reads as biggest without the
  // smallest becoming a sliver that cannot name itself
  const allowance = leads.length * CELL_PX;
  return new Map(
    leads.map((lead, index) => [
      lead.key,
      MIN_LEAD_PX +
        (total ? expected[index] / total : 1 / leads.length) * allowance,
    ]),
  );
}

/* Facet views keep the text scale while spending less proportional allowance
   than the lead view, so each run stays compact without ambiguous labels. */

export function compactLeadExtents(product) {
  const leads = leadAxis(product);
  const newest = product.recent_inits?.at(-1);
  const slices = leadSlices(newest?.lead_groups ?? []);
  const expected = leads.map(
    (lead) => slices.find((slice) => slice.name === lead.key)?.expected ?? 0,
  );
  const total = expected.reduce((sum, count) => sum + count, 0);
  const allowance = leads.length * FACET_LEAD_ALLOWANCE_PX;
  return new Map(
    leads.map((lead, index) => [
      lead.key,
      FACET_MIN_LEAD_PX +
        (total ? expected[index] / total : 1 / leads.length) * allowance,
    ]),
  );
}

function LeadLabel({ lead, width }) {
  return html`<span
    class="pipeline-column-label"
    style=${`--cell-w:${width.toFixed(2)}px`}
    title=${`lead ${lead.label}`}
  >${lead.label}</span>`;
}

/* The bands of the marginal field, top row first: longest horizon down to the
   floor, then a band per facet grouped by dimension. Bands come from the product
   rather than one run, so the field keeps its shape as runs scroll through it. */

export function bandsOf(product) {
  // the lead grid stacks bottom-up, so the longest horizon is the top row
  const leads = [...leadAxis(product)].reverse();

  return leads;
}

/* The facets of one lead group in one run, in the product's declared order.
   Empty when the payload reports no joint for that group. */

export function facetsAt(product, init, leadName, order) {
  const group = (init?.lead_groups ?? []).find(
    (entry) => entry.name === leadName,
  );
  if (!Array.isArray(group?.facets)) return [];
  const measured = new Map(group.facets.map((facet) => [facet.name, facet]));
  // the rows come from facetRowsOf, so the cells must use that same order —
  // ordering by facet_groups alone would leave a measured-but-undeclared facet
  // with a row and no squares, reading as "no monitoring data" for data that
  // did arrive
  const names = order ?? facetRowsOf(product).map((facet) => facet.name);
  // a facet absent at this lead simply has no square
  return names.map((name) => measured.get(name)).filter(Boolean);
}

/* The label gutter is only as wide as the labels beside it. Lead-only rows read
   "3d"; a facet row reads "precipitation and snow". Sizing it per product is
   what keeps the strip from starting a third of the way in. Stated in px, not
   ch: CSS resolves ch against the band's inherited font, which is not the
   font these labels are set in. */

/* An init column is as wide as the label beneath it. Measured from the labels
   this product actually formats, not guessed from a mode: `en-US` renders a zone
   without a letter abbreviation as a GMT offset, so local time is "08 CDT" in
   Chicago but "18 GMT+5:30" in Kolkata — nearly twice as wide. */

export function initColumnPx(product, zone) {
  const widest = (product.recent_inits ?? []).reduce((max, init) => {
    const { date, time } = initParts(init.init_time, zone);
    return Math.max(max, date.length, time.length);
  }, 2);
  return Math.max(CELL_PX, widest * CH_PX);
}

export function gutterPx(labelled) {
  const widest = labelled.reduce(
    (max, entry) => Math.max(max, (entry.label ?? "").length),
    2,
  );
  return Math.min(GUTTER_MAX_CH, widest) * CH_PX;
}

/* What the field shows: the newest runs that fit, oldest first. The chart
   under the field draws exactly this slice, so both take it from here. */

export function displayedRuns(product, runCount) {
  return product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
}

/* How many runs fit, given what one run costs. Both layouts share the whole
   calculation and differ only in that width. */

function runsFitting(availablePx, gutter, runWidth, gap) {
  // an unmeasured row shows everything rather than nothing
  if (!Number.isFinite(availablePx) || availablePx <= 0) return RUNS_MAX;
  // 6px band gap, and 4px of slack so a font fallback cannot overflow the row
  const usable = availablePx - gutter - 6 - 4;
  if (usable <= 0) return 1;
  return Math.max(
    1,
    Math.min(RUNS_MAX, Math.floor((usable + gap) / (runWidth + gap))),
  );
}

export function runsThatFit(product, availablePx, local) {
  return runsFitting(
    availablePx,
    gutterPx(bandsOf(product)),
    initColumnPx(product, selectedTimeZone(local)),
    RUN_GAP_PX,
  );
}

/* A facet grid spends its width on lead columns inside every run, and those
   columns are proportional, so the block width comes from the extents. */

export function runsThatFitFacetRows(product, availablePx, dimension) {
  const leads = leadAxis(product);
  const extents = compactLeadExtents(product);
  const runWidth =
    leads.reduce(
      (sum, lead) => sum + (extents.get(lead.key) ?? FACET_CELL_PX),
      0,
    ) +
    Math.max(0, leads.length - 1) * FACET_CLUMP_GAP_PX;
  const perLane = runsFitting(
    availablePx,
    facetGutterPx(facetRowsOf(product, dimension)),
    runWidth,
    FACET_RUN_GAP_PX,
  );
  return Math.min(RUNS_MAX, perLane * FACET_LANES);
}

/* Every band is the same skeleton: a gutter label, then its row of cells. */

function Band({
  className = "pipeline-band",
  kind,
  label = "",
  labelTitle,
  clumped = false,
  style,
  children,
}) {
  return html`<div class=${className} data-kind=${kind} style=${style}>
    <span class="pipeline-band-label" title=${labelTitle}>${label}</span>
    <div class="pipeline-cells" data-clumped=${clumped ? "" : null}>
      ${children}
    </div>
  </div>`;
}

/* What one run measured for one band. A band the run never reported reads as
   unobserved rather than as a failure. */

export function cellOf(band, init) {
  if (!init) return { state: "unobserved" };
  if (init.status === "unobserved") return { state: "unobserved" };

  if (band.kind === "lead") {
    const slice = leadSlices(init.lead_groups ?? []).find(
      (group) => group.name === band.key,
    );
    if (!slice) return { state: "unobserved" };
    return {
      state: slice.status,
      timing: slice.timing,
      completion: slice.completion,
    };
  }

  const facet = (init.facets ?? []).find((entry) => entry.name === band.key);
  if (!facet) return { state: "unobserved" };
  return facetCell(facet, init);
}

function facetCell(facet, init, timing = init.timing) {
  return {
    state: facet.status,
    timing,
    completion: facet.completion_pct ?? 0,
    available: facet.dependencies_available,
    expected: facet.dependencies_expected,
  };
}

/* The hover label. What the square stands for comes first, then when, then how
   much of it arrived — a facet names itself and its dimension. */

export function cellTitle(band, init, cell, local) {
  if (!init) return `${band.label} · not reported`;
  const when = initShort(init.init_time, local);
  if (cell.state === "unobserved") {
    return `${band.label} · ${when} · no probe visibility; not a publication failure`;
  }
  // the unit agrees with the total, so a band of one lead reads "1 / 1 file"
  const files = cell.expected === 1 ? "file" : "files";
  const volume =
    cell.expected != null
      ? `${cell.available.toLocaleString("en-US")} / ${cell.expected.toLocaleString("en-US")} ${files}`
      : `${Math.round((cell.completion ?? 0) * 100)}%`;
  return [
    band.kind === "facet" ? `${band.label} (${band.dimension})` : `lead ${band.label}`,
    // a facet nested in a lead band names the lead it belongs to
    band.lead ? `lead ${band.lead}` : null,
    when,
    volume,
    statusLabel(cell.state),
    cell.timing ? cell.timing.replaceAll("_", " ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Cell({ band, init, local, measured, style }) {
  const cell = measured ?? cellOf(band, init);
  return html`<div
    class=${`pipeline-cell g-${cell.state}`}
    data-init-time=${init?.init_time}
    data-timing=${cell.timing}
    title=${cellTitle(band, init, cell, local)}
    style=${style}
  >
    <div
      class="pipeline-cell-fill"
      style=${`--fill:${Math.max(0, Math.min(100, (cell.completion ?? 0) * 100))}%`}
    ></div>
  </div>`;
}

/* The facet-row field spends width on lead-group columns inside every run, so
   it needs its own fit. */

export function facetRowsOf(product, dimension) {
  // every facet the joint mentions anywhere in the displayed runs: the newest
  // run may report none yet, and a rollout or rollback can leave the window
  // mixed, but those rows still have measurements in the runs beside them
  const reported = new Map();
  for (const init of product.recent_inits ?? []) {
    for (const group of init.lead_groups ?? []) {
      for (const facet of group.facets ?? []) {
        if (!reported.has(facet.name)) reported.set(facet.name, facet);
      }
    }
  }
  // the declared schema owns the order; anything it never declares still gets a
  // row, since the payload measured it
  const declared = (product.facet_groups ?? []).filter((facet) =>
    reported.has(facet.name),
  );
  const undeclared = [...reported.values()].filter(
    (facet) => !declared.some((entry) => entry.name === facet.name),
  );
  const rows = [...declared, ...undeclared];
  return dimension ? rows.filter((facet) => facet.dimension === dimension) : rows;
}

const FACET_AXIS_ABBREVIATIONS = new Map([
  ["cloud and convection", "cloud/conv"],
  ["natural levels", "nat lvls"],
  ["precipitation and snow", "precip/snow"],
  ["pressure levels", "prs lvls"],
  ["solar radiation", "solar"],
  ["surface state", "sfc state"],
  ["control", "ctl"],
  ["perturbed", "pert"],
  ["perturbed members", "pert"],
]);

export function facetAxisLabel(facet) {
  return (
    FACET_AXIS_ABBREVIATIONS.get(facet.label) ??
    facet.label.replace(/^(pgrb2[abs])\.\d+p\d+$/, "$1")
  );
}

function facetGutterPx(facets) {
  return gutterPx(
    facets.map((facet) => ({ ...facet, label: facetAxisLabel(facet) })),
  );
}

/* The views a product offers, in click order: the lead grid it opens on, then
   one grid per facet dimension the joint reports. A product without a joint
   offers the lead grid alone, so clicking it does nothing. */

export function viewsOf(product) {
  const dimensions = [];
  for (const facet of facetRowsOf(product)) {
    if (!dimensions.includes(facet.dimension)) dimensions.push(facet.dimension);
  }
  return [
    { rows: "lead time", dimension: null },
    ...dimensions.map((dimension) => ({ rows: dimension, dimension })),
  ];
}

function wrapIndex(index, length) {
  return ((index % length) + length) % length;
}

export function viewAt(product, index) {
  const views = viewsOf(product);
  return views[wrapIndex(index, views.length)];
}

/* The init axis: the time under every column, then the date only where it turns
   over, so a date lines up with the first timestamp it covers. */

function InitTiers({ runs, local }) {
  const zone = selectedTimeZone(local);
  let previousDate = null;
  return html`<${LabelTier}
      bandClass="pipeline-band pipeline-band--foot"
      spanClass="pipeline-run-label"
      runs=${runs}
      textOf=${(init) => initParts(init.init_time, zone).time}
      titleOf=${(init) => initShort(init.init_time, local)}
    />
    <${LabelTier}
      spanClass="pipeline-run-date"
      runs=${runs}
      textOf=${(init) => {
        const { date } = initParts(init.init_time, zone);
        const turned = date !== previousDate;
        previousDate = date;
        return turned ? date : "";
      }}
    />`;
}

/* The joint, indexed once per render: which facets a run reported under a lead
   group, and that group's timing. Built from `facetsAt` so the declared order
   still decides, then read by name per square. */

function jointIndex(product, runs, leads) {
  const order = facetRowsOf(product).map((facet) => facet.name);
  const index = new Map();
  for (const init of runs) {
    const byLead = new Map();
    for (const lead of leads) {
      const facets = facetsAt(product, init, lead.key, order);
      if (!facets.length) continue;
      byLead.set(lead.key, {
        // the lead group's own timing is more specific than the run's
        timing:
          (init.lead_groups ?? []).find((group) => group.name === lead.key)
            ?.timing ?? init.timing,
        facets: new Map(facets.map((facet) => [facet.name, facet])),
      });
    }
    index.set(init, byLead);
  }
  return index;
}

/* One label tier under the blocks: a span per run, exactly one block wide, so
   every tier centres on the same axis as the squares above it. */

function LabelTier({
  bandClass = "pipeline-band",
  spanClass,
  runs,
  textOf,
  titleOf,
}) {
  return html`<${Band} className=${bandClass} clumped>
    ${runs.map(
      (init, index) =>
        html`<span key=${init.init_time} class=${spanClass} title=${titleOf?.(init)}
        >${textOf(init, index)}</span>`,
    )}
  <//>`;
}

/* The facet-row field: one row per facet, one block per run, one column per
   lead group inside a block. Same squares and same hover labels as the banded
   field — only which dimension owns which axis changes.

   One grid per field, and every node a direct child of it, emitted in the
   order the eye reads: a lane's lead labels, then each facet's gutter label
   followed by that facet's squares run by run, then the times, then the
   dates. So a screen reader or a text selection follows the picture. Each
   node is keyed by what it belongs to — the run's init and the facet — so
   when the window rolls forward and a run moves from the newer lane up into
   the older, its squares keep their nodes and only their grid areas change. */

function FacetRowsField({ product, local, runCount, dimension }) {
  const runs = product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
  const leads = leadAxis(product); // shortest horizon first
  const facets = facetRowsOf(product, dimension);
  const extents = compactLeadExtents(product);
  const leadWidth = (lead) => extents.get(lead.key) ?? FACET_CELL_PX;
  const runWidth =
    leads.reduce((sum, lead) => sum + leadWidth(lead), 0) +
    Math.max(0, leads.length - 1) * FACET_CLUMP_GAP_PX;
  const joint = jointIndex(product, runs, leads);
  const zone = selectedTimeZone(local);
  // older runs occupy the first lane; newer runs continue in the second
  const laneCount = Math.min(FACET_LANES, Math.max(1, runs.length));
  const runsPerLane = Math.ceil(runs.length / laneCount);
  // a lane is a head row, a row per facet, a time row and a date row, with
  // a spacer row before every lane but the first
  const rowsPerLane = facets.length + 3;
  const rowOf = (lane, row) => lane * (rowsPerLane + 1) + row + 1;
  const laneRows = `calc(var(--label-h) + 0.2rem) repeat(${facets.length}, var(--sq)) calc(var(--label-h) + 0.3rem) var(--label-h)`;
  const templateRows = Array.from({ length: laneCount }, () => laneRows).join(
    " calc(var(--lane-gap) - 2 * var(--band-gap)) ",
  );

  const children = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    const laneRuns = runs.slice(lane * runsPerLane, (lane + 1) * runsPerLane);
    const at = (row, column) =>
      `grid-area:${rowOf(lane, row)} / ${column + 2}`;
    const owned = (init) => ({
      "data-lane": String(lane),
      "data-init-time": init.init_time,
    });
    laneRuns.forEach((init, column) => {
      children.push(
        html`<div
          key=${`head/${init.init_time}`}
          class="pipeline-clump pipeline-run-head"
          ...${owned(init)}
          style=${at(0, column)}
        >
          ${leads.map(
            (lead) =>
              html`<${LeadLabel}
                key=${lead.key}
                lead=${lead}
                width=${leadWidth(lead)}
              />`,
          )}
        </div>`,
      );
    });
    facets.forEach((facet, index) => {
      children.push(
        html`<span
          key=${`${lane}/${facet.name}`}
          class="pipeline-band-label"
          data-kind="facet"
          data-lane=${String(lane)}
          title=${`${facet.label} (${facet.dimension})`}
          style=${`grid-area:${rowOf(lane, index + 1)} / 1`}
        >${facetAxisLabel(facet)}</span>`,
      );
      laneRuns.forEach((init, column) => {
        children.push(
          html`<div
            key=${`${facet.name}/${init.init_time}`}
            class="pipeline-clump"
            data-facet=${facet.name}
            ...${owned(init)}
            style=${at(index + 1, column)}
          >
            ${leads.map((lead) => {
              const measured = joint.get(init)?.get(lead.key);
              const facetAt = measured?.facets.get(facet.name);
              const band = {
                kind: "facet",
                key: facet.name,
                label: facet.label,
                dimension: facet.dimension,
                lead: lead.label,
              };
              return html`<${Cell}
                key=${lead.key}
                band=${band}
                init=${init}
                local=${local}
                measured=${facetAt
                  ? facetCell(facetAt, init, measured.timing)
                  : { state: "unobserved" }}
                style=${`--cell-w:${leadWidth(lead).toFixed(2)}px`}
              />`;
            })}
          </div>`,
        );
      });
    });
    laneRuns.forEach((init, column) => {
      children.push(
        html`<span
          key=${`time/${init.init_time}`}
          class="pipeline-run-label"
          ...${owned(init)}
          style=${at(facets.length + 1, column)}
          title=${initShort(init.init_time, local)}
        >${initParts(init.init_time, zone).time}</span>`,
      );
    });
    // the date shows where it turns over, counted afresh in each lane so a
    // lane always opens with one
    let previousDate = null;
    laneRuns.forEach((init, column) => {
      const { date } = initParts(init.init_time, zone);
      const turned = date !== previousDate;
      previousDate = date;
      children.push(
        html`<span
          key=${`date/${init.init_time}`}
          class="pipeline-run-date"
          ...${owned(init)}
          style=${at(facets.length + 2, column)}
        >${turned ? date : ""}</span>`,
      );
    });
  }

  return html`<div
    class="pipeline-field pipeline-field--runs"
    data-fill="side"
    style=${`--sq:${FACET_CELL_PX}px;--clump-gap:${FACET_CLUMP_GAP_PX}px;--clumped-run-gap:${FACET_RUN_GAP_PX}px;--lane-gap:${FACET_LANE_GAP_PX}px;--band-gutter:${facetGutterPx(facets)}px;--run-width:${runWidth}px;--band-gap:${FACET_BAND_GAP_PX}px;--label-h:${LABEL_PX}px;grid-template-columns:var(--band-gutter) repeat(${runsPerLane}, var(--run-width));grid-template-rows:${templateRows}`}
  >
    ${children}
  </div>`;
}

function LeadField({ product, local, runCount }) {
  const runs = displayedRuns(product, runCount);
  const extents = leadExtents(product);
  const column = initColumnPx(product, selectedTimeZone(local));
  return html`<div
    class="pipeline-field"
    style=${`--sq:${column}px;--run-gap:${RUN_GAP_PX}px;--clumped-run-gap:${RUN_GAP_PX}px;--run-width:${column}px;--band-gutter:${gutterPx(bandsOf(product))}px;--band-gap:${BAND_GAP_PX}px;--label-h:${LABEL_PX}px`}
  >
    ${bandsOf(product).map(
      (band) =>
        html`<${Band}
          key=${band.key}
          kind=${band.kind}
          label=${band.label}
          labelTitle=${band.label}
          style=${`--cell-h:${(band.kind === "lead" ? (extents.get(band.key) ?? CELL_PX) : CELL_PX).toFixed(2)}px`}
        >
          ${runs.map(
            (init) =>
              html`<${Cell}
                key=${init.init_time}
                band=${band}
                init=${init}
                local=${local}
              />`,
          )}
        <//>`,
    )}
    <${InitTiers} runs=${runs} local=${local} />
  </div>`;
}

function etaTarget(product) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "pending" || init.status === "in_flight",
  );
  if (running) {
    const p95 = product.latency_stats?.p95_s;
    return {
      init: running,
      initTime: running.init_time,
      target:
        p95 == null
          ? null
          : new Date(Date.parse(running.init_time) + p95 * 1000).toISOString(),
      running: true,
    };
  }
  if (!product.next_expected_init) return null;
  return {
    init: null,
    initTime: product.next_expected_init,
    target: product.next_expected_completion_at ?? null,
    running: false,
  };
}

function statusLabel(status) {
  if (status === "in_flight") return "processing";
  if (status === "unobserved") return "pending";
  return status.replaceAll("_", " ");
}

export function etaLineText(target, now, local) {
  const seconds = Math.floor((Date.parse(target) - now) / 1000);
  const time = clockTime(target, selectedTimeZone(local));
  return seconds <= 0
    ? "ETA any moment"
    : `ETA ${time} (in ${formatDuration(seconds)})`;
}

// The percentile columns summarise every init in the historical baseline, not
// just the runs the grid draws, so the header names the sample they came from.
function statsHeader(sampleInitCount, note = null) {
  if (!sampleInitCount) return "time after init";
  const samples = sampleInitCount === 1 ? "sample" : "samples";
  const header = `time after init · ${sampleInitCount.toLocaleString("en-US")} ${samples}`;
  // the sample is thin, so the columns beside it come with no timing verdict
  return note ? `${header} · ${note}` : header;
}

function countLabel(count, singular) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : `${singular}s`}`;
}

// Lag statistics describe the backend's historical window. Missing metadata is
// deliberately unavailable: an old payload's recent runs are not that sample.
function lagStatsHeader(lag) {
  const header = lag?.basis === "shared_nat_prs_sfc"
    ? "lag after source · matching nat/prs/sfc families"
    : "lag after source";
  if (!lag) return `${header} · unavailable (not paired)`;
  if (lag.status === "pending") {
    return `${header} · historical baseline pending`;
  }
  const { sample_init_count: inits, sample_day_count: days } = lag.stats;
  const window = `${lag.window_start.slice(0, 10)}–${lag.window_end.slice(0, 10)} UTC`;
  return `${header} · historical baseline (effective ${window}) · ${countLabel(inits, "sample")} across ${countLabel(days, "day")}`;
}

const NO_RUN = Object.freeze({
  status: "—",
  state: null,
  timing: null,
  time: "—",
  duration: "—",
});

function observedRunDetail(init, live, stats, now, local, active) {
  if (!init) return NO_RUN;
  const initMs = Date.parse(init.init_time);
  let time = "—";
  let duration = "—";
  if (live?.status === "complete" && live.latency_s != null) {
    time = clockTime(
      initMs + live.latency_s * 1000,
      selectedTimeZone(local),
    );
    duration = formatLatency(live.latency_s);
  } else if (live?.status === "complete") {
    time = "done";
  } else if (active && stats.p95_s != null) {
    const target = initMs + stats.p95_s * 1000;
    if (target > now) {
      time = `ETA ${clockTime(target, selectedTimeZone(local))}`;
    }
    const elapsed = Math.floor((now - initMs) / 1000);
    if (elapsed > 0) duration = formatDuration(elapsed);
  }
  return {
    status: statusLabel(live?.status ?? "pending"),
    state: live?.status ?? "pending",
    timing: live?.timing ?? null,
    time,
    duration,
  };
}

function upcomingRunDetail(initTime, stats, local) {
  if (!initTime) return NO_RUN;
  const target =
    stats.p95_s == null ? null : Date.parse(initTime) + stats.p95_s * 1000;
  return {
    status: "upcoming",
    state: "upcoming",
    timing: null,
    time:
      target == null
        ? "—"
        : `ETA ${clockTime(target, selectedTimeZone(local))}`,
    duration: "—",
  };
}

function labelledRun(label, initTime, local) {
  return initTime ? `${label} · ${initShort(initTime, local)}` : label;
}

export function isDynamicalRow(product) {
  return product.source_label === null;
}

export function detailRows(product, now, local) {
  const recent = product.recent_inits ?? [];
  const activeIndex = recent.findLastIndex(
    (init) => init.status === "pending" || init.status === "in_flight",
  );
  const active = activeIndex >= 0 ? recent[activeIndex] : null;
  const last = activeIndex >= 0 ? recent[activeIndex - 1] : recent.at(-1);
  const upcoming = active ? null : product.next_expected_init;
  return {
    lastHeader: labelledRun("last run", last?.init_time, local),
    runHeader: active
      ? labelledRun("current run", active.init_time, local)
      : labelledRun("upcoming run", upcoming, local),
    statsHeader: statsHeader(
      product.latency_stats?.sample_init_count,
      timingBaselineNote(product),
    ),
    rows: (product.lead_group_stats ?? []).map((stats, index) => ({
      name: stats.name,
      label: stats.label,
      last: observedRunDetail(
        last,
        last?.lead_groups?.[index],
        stats,
        now,
        local,
        false,
      ),
      run: active
        ? observedRunDetail(
            active,
            active.lead_groups?.[index],
            stats,
            now,
            local,
            true,
          )
        : upcomingRunDetail(upcoming, stats, local),
      p50: formatLatency(stats.p50_s),
      p95: formatLatency(stats.p95_s),
      p99: formatLatency(stats.p99_s),
      // the group's own current cutoff, the one an in-flight run's bubbled
      // delay names
      threshold: formatLatency(
        product.timing_baseline?.status === "insufficient_history"
          ? null
          : stats.delayed_threshold_s,
      ),
    })),
    lag: isDynamicalRow(product) ? lagRow(product, last) : null,
  };
}

// The lag is a property of the whole run, not of a horizon, so it gets one
// row of its own beneath the lead table rather than a column repeated down
// it. Only the last run has one: the current run is by definition not
// complete, and a lag needs both sides landed — a last run whose source is
// still out reads "—".
function lagRow(product, last) {
  const lag = product.pipeline_lag;
  const stats = lag?.status === "ready" ? lag.stats : null;
  return {
    header: lagStatsHeader(lag),
    last: formatSignedLatency(lag ? last?.pipeline_lag_s : null),
    p50: formatSignedLatency(stats?.p50_s),
    p95: formatSignedLatency(stats?.p95_s),
    p99: formatSignedLatency(stats?.p99_s),
  };
}

export function facetRows(product) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
  );
  const displayed = running ?? product.recent_inits.at(-1);
  return (displayed?.facets ?? []).map((facet) => ({
    name: facet.name,
    dimension: facet.dimension,
    label: facet.label,
    status: statusLabel(facet.status),
    state: facet.status,
    // a facet reports no timing of its own; its square takes the run's, so the
    // row must too, or one word reads in two colors across the two tables
    timing: displayed.timing ?? null,
    completion: facet.completion_pct,
    count: `${facet.dependencies_available.toLocaleString("en-US")} / ${facet.dependencies_expected.toLocaleString("en-US")} observed`,
  }));
}

// a status reads in the color its square would take on the grid
// a status reads in the color its square would take on the grid
function StatusCell({ detail }) {
  return html`<td data-status=${detail.state} data-timing=${detail.timing}>
    ${detail.status}
  </td>`;
}

/* How far a product is from its delayed threshold: the distinct UTC days
   with a completed run it has, and the days it needs. Null once it has one,
   or when the feed says nothing countable. */

function timingBaselineShortfall(product) {
  const baseline = product.timing_baseline;
  if (
    baseline?.status !== "insufficient_history" ||
    !Number.isInteger(baseline.history_days) ||
    !Number.isInteger(baseline.required_history_days)
  ) {
    return null;
  }
  return { days: baseline.history_days, required: baseline.required_history_days };
}

export function timingBaselineNote(product) {
  const shortfall = timingBaselineShortfall(product);
  return shortfall && `insufficient history (${shortfall.days}/${shortfall.required} days)`;
}

/* The run chart. One point per run: its completion time after init, or the
   time elapsed so far for a run still arriving, against the product's current
   delayed threshold. The timings are the summarizer's verdicts, each made
   against the threshold of its day; the line is today's, so the chart draws
   both and judges neither.

   Two charts draw it. Under the lead-group view, the one a row opens on, the
   chart sits under the field and shares its columns: the same gutter, run
   width and gap, set through the same custom properties, so a point lands
   under the square it belongs to without measuring either, and the field's
   init labels are repeated beneath it. Under an arrival-group view the chart
   draws every run the payload carries across the whole row, on a
   proportional time axis of its own. */

const CHART_HEIGHT_PX = 160;
const CHART_MARK_R = 3.5;
// a delayed run is larger as well as amber, so the one verdict the chart
// colors does not rest on color alone
const CHART_DELAYED_MARK_R = 5;
// room for the widest tick label ("12h 30m") in the chart's own 10px monospace,
// and for the threshold label to clear the right edge
const CHART_MARGIN = { top: 16, right: 8, bottom: 30, left: 50 };
const CHART_TICK_STEPS_S = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
];
// how far past the landed runs and the line a run still arriving may stretch
// the axis: a run merely late is drawn at its own time; one three times the
// slowest landed run is stuck or stale, and is parked at the top edge with its
// time written beside it rather than flattening every landed run
const CHART_ELAPSED_REACH = 3;

/* The line is drawn only when the product has a verdict to make: one still
   short of history publishes no threshold, and a feed that omits the field
   draws the points alone. */

export function runChartThreshold(product) {
  if (product.timing_baseline?.status === "insufficient_history") return null;
  const threshold = product.latency_stats?.delayed_threshold_s;
  return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
}

export function runChartSeries(product, now, inits = product.recent_inits ?? []) {
  const runs = [];
  const seen = new Set();
  for (const init of inits) {
    const ms = Date.parse(init.init_time);
    if (!Number.isFinite(ms) || init.status === "unobserved") continue;
    // one point per init: a repeated timestamp would share a key and a place
    if (seen.has(ms)) continue;
    seen.add(ms);
    const run = {
      init,
      ms,
      status: init.status,
      timing: init.timing ?? null,
      seconds: null,
      elapsed: false,
    };
    // the marker follows the status: a run still arriving is hollow at its
    // elapsed time whatever else it reports
    if (init.status === "pending" || init.status === "in_flight") {
      run.seconds = Math.max(0, (now - ms) / 1000);
      run.elapsed = true;
    } else if (Number.isFinite(init.latency_s)) {
      run.seconds = init.latency_s;
    } else {
      // no completion time, so no place on the axis
      continue;
    }
    runs.push(run);
  }
  return { runs, threshold: runChartThreshold(product) };
}

// a tick of two days or more reads in days ("16d"), not hours ("384h"):
// a run in flight that long stretches the axis to that scale
function tickText(seconds) {
  return seconds >= 172800 && seconds % 86400 === 0
    ? `${seconds / 86400}d`
    : formatLatency(seconds);
}

// what a run parked at the top edge says beside it: its time so far, in
// days once it has been going for two
function pinnedTime(seconds) {
  return seconds >= 172800 ? `${Math.floor(seconds / 86400)}d` : formatLatency(seconds);
}

export function pinnedText(seconds) {
  return `${pinnedTime(seconds)} so far ↑`;
}

function niceTicks(lo, hi) {
  let step =
    CHART_TICK_STEPS_S.find((candidate) => (hi - lo) / candidate <= 5) ??
    CHART_TICK_STEPS_S.at(-1);
  // a run that has waited weeks spans further than the steps go
  while ((hi - lo) / step > 5) step *= 2;
  const ticks = [];
  for (let tick = Math.ceil(lo / step) * step; tick <= hi; tick += step) {
    ticks.push(tick);
  }
  return ticks;
}

/* The latency domain, shared by both charts. Zoomed to the runs and the
   line rather than drawn from zero: a threshold sits a few percent above the
   median, and from zero that gap would be a pixel. A run still arriving is
   drawn at its own time while it is within reach of the landed runs and the
   line — a run merely late stretches the axis to hold it. One past that (a
   stuck init, a stale feed's weeks-old run) would flatten every landed run
   onto the floor, so it is parked at the top edge with its time written
   beside it instead. The floor is padded by the landed runs' spread, not the
   whole span. */

export function latencyDomain(series) {
  const landed = series.runs
    .filter((run) => !run.elapsed)
    .map((run) => run.seconds);
  if (series.threshold != null) landed.push(series.threshold);
  // with nothing landed there is nothing to flatten, so the elapsed times
  // take the axis themselves
  const reach = landed.length ? Math.max(...landed) * CHART_ELAPSED_REACH : Infinity;
  const values = [
    ...landed,
    ...series.runs
      .filter((run) => run.elapsed && run.seconds <= reach)
      .map((run) => run.seconds),
  ];
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  // two runs a second apart are not a spread worth filling the plot with:
  // the floor is the spreadf floor, fifteen minutes
  const spread = Math.max(hi - lo, 900);
  const floorSpread = landed.length ? Math.max(Math.max(...landed) - lo, 900) : spread;
  return {
    yMin: Math.max(0, lo - floorSpread * 0.15),
    yMax: hi + spread * 0.15,
    // nothing landed, nothing arriving, no line: an axis would be invented
    empty: values.length === 0,
  };
}

/* The scales of the chart across the row. Time is proportional, so a missed
   init leaves a gap rather than closing up. */

export function runChartScales(series, width, cadenceHours, labelPx = CH_PX * 3) {
  const plotWidth = width - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = CHART_HEIGHT_PX - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const { yMin, yMax } = latencyDomain(series);

  const times = series.runs.map((run) => run.ms);
  const first = times.length ? Math.min(...times) : 0;
  const last = times.length ? Math.max(...times) : 0;
  const gaps = [...times]
    .sort((a, b) => a - b)
    .map((ms, index, sorted) => (index ? ms - sorted[index - 1] : 0))
    .filter((gap) => gap > 0);
  // a lone run is padded by its cadence, so the axis has an extent
  const cadenceMs =
    (Number.isFinite(cadenceHours) && cadenceHours > 0 ? cadenceHours : 6) *
    3600 *
    1000;
  const pad = (gaps.length ? Math.min(...gaps) : cadenceMs) / 2;
  const xMin = first - pad;
  const xMax = last + pad;

  return {
    width,
    height: CHART_HEIGHT_PX,
    left: CHART_MARGIN.left,
    right: CHART_MARGIN.left + plotWidth,
    top: CHART_MARGIN.top,
    bottom: CHART_MARGIN.top + plotHeight,
    x: (ms) => CHART_MARGIN.left + ((ms - xMin) / (xMax - xMin)) * plotWidth,
    y: (seconds) =>
      CHART_MARGIN.top +
      plotHeight -
      ((Math.min(Math.max(seconds, yMin), yMax) - yMin) / (yMax - yMin)) *
        plotHeight,
    pinned: (seconds) => seconds > yMax,
    yTicks: niceTicks(yMin, yMax),
    // every run names itself when the label fits between neighbours; otherwise
    // every other one, or every third — measured on the closest pair, since
    // time is proportional and a gap elsewhere does not make room here
    labelEvery: Math.max(
      1,
      Math.ceil(
        (labelPx + 6) / ((gaps.length ? Math.min(...gaps) : cadenceMs) * (plotWidth / (xMax - xMin))),
      ),
    ),
  };
}

function runTitle(run, local) {
  const how = run.elapsed
    ? `${pinnedTime(run.seconds)} elapsed`
    : `${formatLatency(run.seconds)} after init`;
  return [
    initShort(run.init.init_time, local),
    how,
    statusLabel(run.status),
    run.timing?.replaceAll("_", " "),
  ]
    .filter(Boolean)
    .join(" · ");
}

function markRadius(run) {
  return run.timing === "delayed" ? CHART_DELAYED_MARK_R : CHART_MARK_R;
}

/* The key names the marks the chart draws, and only those, each drawn as it
   is on the chart: complete and not yet complete when both are shown, and a
   delayed run filled or hollow as the delayed runs shown are. A product short
   of history has no verdicts to draw, and the key says why rather than leaving
   the reader to wonder at a chart with no amber and no line. */

export function runChartKey(product, runs) {
  const key = [];
  const arriving = runs.some((run) => run.elapsed);
  if (arriving && runs.some((run) => !run.elapsed)) {
    key.push({ mark: "complete", text: "complete" });
  }
  if (arriving) key.push({ mark: "elapsed", text: "not yet complete: time so far" });
  // "judged": a verdict is the summarizer's, made against the threshold of its
  // day or a lead group's own, so one can sit below today's run-level line
  if (runs.some((run) => run.timing === "delayed" && !run.elapsed)) {
    key.push({ mark: "delayed", text: "judged delayed" });
  }
  if (runs.some((run) => run.timing === "delayed" && run.elapsed)) {
    key.push({ mark: "delayed-elapsed", text: "judged delayed, not yet complete" });
  }
  const shortfall = timingBaselineShortfall(product);
  if (shortfall) {
    key.push({
      mark: null,
      // the gate counts distinct UTC days with a completed run, not calendar age
      text: `no delayed threshold yet: ${shortfall.days} of ${shortfall.required} days with a completed run`,
    });
  }
  return key;
}

function RunKey({ items }) {
  if (!items.length) return null;
  return html`<ul>
    ${items.map((item) => html`<li key=${item.text} data-mark=${item.mark}>${item.text}</li>`)}
  </ul>`;
}

/* The chart across the row. Its width is measured, as the field's is: the
   details span the whole row, and an SVG scaled through a viewBox would scale
   its text too. */

function RunChart({ product, now, local }) {
  const box = useRef(null);
  const [width, setWidth] = useState(null);
  const count = product.recent_inits.length;
  // the figure exists only while there are runs, so the measurement follows
  // it: a product that gains its first run while the details are open is
  // measured then, not on a later reopen
  const mounted = count > 0;
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted]);

  if (!mounted) return null;
  const series = runChartSeries(product, now);
  const zone = selectedTimeZone(local);

  let chart = null;
  let key = [];
  if (series.runs.length > 0 && width != null && width > CHART_MARGIN.left + CHART_MARGIN.right + 40) {
    const scale = runChartScales(
      series,
      width,
      product.cadence_hours,
      initColumnPx(product, zone),
    );
    const em = chartEm();
    const parked = pinnedLayout(
      series.runs.filter((run) => run.elapsed && scale.pinned(run.seconds)),
      (run) => scale.x(run.ms),
      {
        em,
        titleRight: scale.left + "time after init".length * 0.6 * em,
        right: scale.right,
        top: scale.top,
      },
    );
    key = [...runChartKey(product, series.runs), ...pinnedKeyItems(parked.overflow, local)];
    // the threshold label hangs at its line's right end; a parked ring there
    // would sit on it, so the label moves to the line's left end, under the
    // line where above it would reach the title row
    const thresholdText =
      series.threshold == null ? "" : `delayed past ${formatLatency(series.threshold)}`;
    const thresholdY = series.threshold == null ? 0 : scale.y(series.threshold);
    const thresholdLeft = parked.runs.some(
      (run) =>
        scale.x(run.ms) + CHART_DELAYED_MARK_R + 2 > scale.right - thresholdText.length * 0.6 * em,
    );
    const thresholdAttrs = thresholdLeft
      ? {
          x: scale.left + 2,
          y: thresholdY - 4 - em < scale.top ? thresholdY + 12 : thresholdY - 4,
          "text-anchor": "start",
        }
      : { x: scale.right, y: thresholdY - 4, "text-anchor": "end" };
    // the date shows where it turns over among the labelled runs, so a day
    // that begins at a run thinned out of the labels is still named
    let previousDate = null;
    chart = html`<svg
      width=${width}
      height=${scale.height}
      role="img"
      aria-label=${[
        `Completion time after init for ${series.runs.filter((run) => !run.elapsed).length} of the last ${count} runs`,
        series.runs.some((run) => run.elapsed)
          ? `time so far for ${series.runs.filter((run) => run.elapsed).length} not yet complete`
          : null,
        series.runs.some((run) => run.timing === "delayed")
          ? `${series.runs.filter((run) => run.timing === "delayed").length} judged delayed`
          : null,
        pinnedAria(parked.runs, local),
        series.threshold == null
          ? null
          : `against the current delayed threshold of ${formatLatency(series.threshold)}`,
      ]
        .filter(Boolean)
        .join("; ")}
    >
      <text x=${scale.left} y=${scale.top - 6}>time after init</text>
      ${scale.yTicks.map(
        (tick) => html`<g key=${`y/${tick}`} data-axis="y">
          <line x1=${scale.left} x2=${scale.right} y1=${scale.y(tick)} y2=${scale.y(tick)} />
          <text x=${scale.left - 6} y=${scale.y(tick)} dy="0.35em" text-anchor="end">${tickText(tick)}</text>
        </g>`,
      )}
      <line data-axis="x" x1=${scale.left} x2=${scale.right} y1=${scale.bottom} y2=${scale.bottom} />
      ${series.runs.map((run, index) => {
        const { date, time } = initParts(run.init.init_time, zone);
        const x = scale.x(run.ms);
        const labelled = index % scale.labelEvery === 0;
        const turned = labelled && date !== previousDate;
        if (labelled) previousDate = date;
        return html`<g key=${`x/${run.init.init_time}`} data-axis="x">
          <line x1=${x} x2=${x} y1=${scale.bottom} y2=${scale.bottom + 3} />
          ${labelled
            ? html`<text x=${x} y=${scale.bottom + 13} text-anchor="middle">${time}</text>`
            : null}
          ${turned
            ? html`<text x=${x} y=${scale.bottom + 25} text-anchor="middle">${date}</text>`
            : null}
        </g>`;
      })}
      ${series.threshold == null
        ? null
        : html`<g data-threshold="run">
            <line x1=${scale.left} x2=${scale.right} y1=${scale.y(series.threshold)} y2=${scale.y(series.threshold)} />
            <text ...${thresholdAttrs}>${thresholdText}</text>
          </g>`}
      ${series.runs.map((run) => {
        return html`<circle
          key=${run.init.init_time}
          data-status=${run.status}
          data-timing=${run.timing}
          data-elapsed=${run.elapsed ? "" : null}
          data-pinned=${run.elapsed && scale.pinned(run.seconds) ? "" : null}
          cx=${scale.x(run.ms)}
          cy=${run.elapsed && scale.pinned(run.seconds) ? parkedY(scale) : scale.y(run.seconds)}
          r=${markRadius(run)}
        ><title>${runTitle(run, local)}</title></circle>`;
      })}
      ${parked.labels.map(
        ({ run, text, attrs }) =>
          html`<text key=${`pinned/${run.init.init_time}`} data-pinned="" ...${attrs}>${text}</text>`,
      )}
    </svg>`;
  }

  return html`<figure
    class="pipeline-runs"
    ref=${box}
    style=${`--plot-left:${CHART_MARGIN.left}px`}
  >
    ${chart}
    ${chart ? html`<${RunKey} items=${key} />` : null}
  </figure>`;
}

/* The aligned plot's own height and margins: room above for its title; the
   init labels are HTML tiers beneath it, not SVG text. */

const ALIGNED_HEIGHT_PX = 140;
const ALIGNED_MARGIN = { top: 16, bottom: 4 };
// the tick and threshold labels hang off the plot's right edge, where the
// row usually has room, rather than over a column of points; when the plot
// fills the row they move inside it, above their lines
const CHART_LABEL_GAP_PX = 6;

export function alignedChartScales(series) {
  const plotHeight = ALIGNED_HEIGHT_PX - ALIGNED_MARGIN.top - ALIGNED_MARGIN.bottom;
  const { yMin, yMax, empty } = latencyDomain(series);
  return {
    height: ALIGNED_HEIGHT_PX,
    top: ALIGNED_MARGIN.top,
    bottom: ALIGNED_MARGIN.top + plotHeight,
    empty,
    y: (seconds) =>
      ALIGNED_MARGIN.top +
      plotHeight -
      ((Math.min(Math.max(seconds, yMin), yMax) - yMin) / (yMax - yMin)) *
        plotHeight,
    pinned: (seconds) => seconds > yMax,
    yTicks: niceTicks(yMin, yMax),
  };
}

/* The init axis is the field's: every run shown owns a column as wide as its
   square, and a point sits at the column's centre — whether or not the runs
   around it have a time to plot. */

export function runColumns(count, runWidth, gap) {
  return {
    width: count > 0 ? count * runWidth + (count - 1) * gap : 0,
    x: (index) => index * (runWidth + gap) + runWidth / 2,
  };
}

/* The chart's text is set in the root size, so what fits is measured in it:
   a character of the monospace is 0.6em wide, a line 1em tall. */

function chartEm() {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 10;
}

/* Where a line's label goes: off the right edge, or inside the plot above
   the line when the plot leaves no room beside it — ticks at the left, where
   an axis is read, the threshold at the right. The title hangs over the top
   of the plot, and over the room beside a plot narrower than it: a label
   that would meet it moves below its line. */

function lineLabel(y, inside, columns, scale, { em, end = false, titlePx = 0 }) {
  // a label above its line reaches 1.4em over it; the title hangs 0.3em under
  // its baseline, six px over the plot
  const underTitle =
    (inside || columns.width + CHART_LABEL_GAP_PX < titlePx) && y < scale.top + 1.5 * em;
  if (!inside) {
    return {
      x: columns.width + CHART_LABEL_GAP_PX,
      y: underTitle ? y + em : y,
      dy: "0.35em",
      "text-anchor": "start",
    };
  }
  return end
    ? { x: columns.width - 2, y: underTitle ? y + 1.2 * em : y - 0.4 * em, dy: "0", "text-anchor": "end" }
    : { x: 2, y: underTitle ? y + 1.2 * em : y - 0.4 * em, dy: "0", "text-anchor": "start" };
}

/* The box a label occupies, in the monospace's 0.6em characters and 1em
   lines: a label on its baseline reaches an em above it, one centred on its
   line half an em either side. */

function labelBox(label, text, em) {
  const width = text.length * 0.6 * em;
  const centred = label.dy !== "0";
  return {
    left: label["text-anchor"] === "end" ? label.x - width : label.x,
    right: label["text-anchor"] === "end" ? label.x : label.x + width,
    top: centred ? label.y - 0.5 * em : label.y - em,
    bottom: centred ? label.y + 0.5 * em : label.y + 0.3 * em,
  };
}

function boxesMeet(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/* Where parked runs say their time. A lone parked run whose words fit between
   the title and the plot's right edge says them in the title row, ending at its
   mark. When they don't fit, or more than one run is parked, words in that row
   would collide, so each parked run is named under the chart instead, by its
   init. The chart's accessible name names every one either way. */

export function pinnedLayout(runs, xOf, { em, titleRight, right, top }) {
  if (runs.length === 1) {
    const [run] = runs;
    const text = pinnedText(run.seconds);
    const least = titleRight + CHART_LABEL_GAP_PX + text.length * 0.6 * em;
    const end = xOf(run) + CHART_DELAYED_MARK_R;
    // the words end at their mark, so a mark under or just past the title
    // leaves them no room in that row
    if (least <= right && end >= least) {
      const x = Math.min(end, right);
      return { runs, labels: [{ run, text, attrs: { x, y: top - 6, "text-anchor": "end" } }], overflow: [] };
    }
  }
  return { runs, labels: [], overflow: runs };
}

function parkedNames(runs, local) {
  return runs
    .map((run) => `${initShort(run.init.init_time, local)}, ${pinnedTime(run.seconds)} so far`)
    .join("; ");
}

export function pinnedKeyItems(runs, local) {
  return runs.length ? [{ mark: null, text: `above the chart: ${parkedNames(runs, local)}` }] : [];
}

// a parked ring sits just inside the plot's top edge, below the title row,
// whatever its radius
function parkedY(scale) {
  return scale.top + CHART_DELAYED_MARK_R + 1;
}

function pinnedAria(runs, local) {
  return runs.length ? `not yet complete and above the chart's range: ${parkedNames(runs, local)}` : null;
}

function AlignedPlot({ runs, plotted, scale, series, columns, inside, em, local, parked }) {
  const lineY = series.threshold == null ? null : scale.y(series.threshold);
  const shown = runs
    .map((init, index) => ({ init, index, run: plotted.get(init.init_time) }))
    .filter((entry) => entry.run);
  const span =
    runs.length > 1
      ? `${initShort(runs[0].init_time, local)} to ${initShort(runs.at(-1).init_time, local)}`
      : initShort(runs[0].init_time, local);
  const title = "time after init";
  const titlePx = title.length * 0.6 * em;
  const thresholdText = lineY == null ? null : `delayed past ${formatLatency(series.threshold)}`;
  // a parked ring at the right end of the line would sit on its label, so
  // the label moves to the line's left end
  const parkedColumn = new Map(shown.map(({ init, index }) => [init.init_time, index]));
  const rings = parked.runs.map((run) => {
    const cx = columns.x(parkedColumn.get(run.init.init_time));
    const r = markRadius(run) + 1;
    return { left: cx - r, right: cx + r, top: parkedY(scale) - r, bottom: parkedY(scale) + r };
  });
  const endLabel =
    lineY == null ? null : lineLabel(lineY, inside, columns, scale, { em, end: true, titlePx });
  const thresholdLabel =
    endLabel && rings.some((ring) => boxesMeet(ring, labelBox(endLabel, thresholdText, em)))
      ? lineLabel(lineY, inside, columns, scale, { em, end: false, titlePx })
      : endLabel;
  // a tick label gives way to the threshold label where the two would meet,
  // to the threshold line itself, to the title, and to a point it would
  // cover inside the plot
  const tickLabel = (y, text) => {
    if (y < scale.top + 1.5 * em && (inside || columns.width + CHART_LABEL_GAP_PX < titlePx)) {
      return null;
    }
    const label = lineLabel(y, inside, columns, scale, { em, titlePx });
    const box = labelBox(label, text, em);
    if (thresholdLabel && boxesMeet(box, labelBox(thresholdLabel, thresholdText, em))) return null;
    // nor may it be written across the line itself
    if (lineY != null && lineY > box.top && lineY < box.bottom) return null;
    const covered =
      inside &&
      shown.some(({ index, run }) => {
        const cx = columns.x(index);
        const cy = scale.y(run.seconds);
        const r = markRadius(run);
        return (
          cx - r < box.right + 0.3 * em &&
          cx + r > box.left &&
          cy + r > box.top &&
          cy - r < box.bottom
        );
      });
    return covered ? null : label;
  };
  return html`<${Band} clumped>
      <svg
        width=${columns.width}
        height=${scale.height}
        role="img"
        aria-label=${[
          `Completion time after init for ${shown.filter(({ run }) => !run.elapsed).length} of the ${runs.length} runs shown`,
          shown.some(({ run }) => run.elapsed)
            ? `time so far for ${shown.filter(({ run }) => run.elapsed).length} not yet complete`
            : null,
          shown.some(({ run }) => run.timing === "delayed")
            ? `${shown.filter(({ run }) => run.timing === "delayed").length} judged delayed`
            : null,
          pinnedAria(parked.runs, local),
          span,
          series.threshold == null
            ? null
            : `against the current delayed threshold of ${formatLatency(series.threshold)}`,
        ]
          .filter(Boolean)
          .join("; ")}
      >
        <text x="0" y=${scale.top - 6}>${title}</text>
        ${scale.empty
          ? html`<text x="0" y=${(scale.top + scale.bottom) / 2} dy="0.35em">no completion time recorded</text>`
          : scale.yTicks.map((tick) => {
              const label = tickLabel(scale.y(tick), tickText(tick));
              return html`<g key=${`y/${tick}`} data-axis="y">
                <line x1="0" x2=${columns.width} y1=${scale.y(tick)} y2=${scale.y(tick)} />
                ${label ? html`<text ...${label}>${tickText(tick)}</text>` : null}
              </g>`;
            })}
        <line data-axis="x" x1="0" x2=${columns.width} y1=${scale.bottom} y2=${scale.bottom} />
        ${lineY == null
          ? null
          : html`<g data-threshold="run">
              <line x1="0" x2=${columns.width} y1=${lineY} y2=${lineY} />
              <text ...${thresholdLabel}>${thresholdText}</text>
            </g>`}
        ${shown.map(({ init, index, run }) => {
          return html`<circle
            key=${init.init_time}
            data-init-time=${init.init_time}
            data-status=${run.status}
            data-timing=${run.timing}
            data-elapsed=${run.elapsed ? "" : null}
            data-pinned=${run.elapsed && scale.pinned(run.seconds) ? "" : null}
            cx=${columns.x(index)}
            cy=${run.elapsed && scale.pinned(run.seconds) ? parkedY(scale) : scale.y(run.seconds)}
            r=${markRadius(run)}
          ><title>${runTitle(run, local)}</title></circle>`;
        })}
        ${parked.labels.map(
          ({ run, text, attrs }) =>
            html`<text key=${`pinned/${run.init.init_time}`} data-pinned="" ...${attrs}>${text}</text>`,
        )}
      </svg>
    <//>
    <${InitTiers} runs=${runs} local=${local} />`;
}

function AlignedRunChart({ product, now, local, runCount, fieldWidth }) {
  // the figure follows the field: nothing until the row is measured, and
  // nothing for a product with no runs
  if (runCount == null || !product.recent_inits.length) return null;
  const zone = selectedTimeZone(local);
  const runs = displayedRuns(product, runCount);
  const series = runChartSeries(product, now, runs);
  const scale = alignedChartScales(series);
  const plotted = new Map(series.runs.map((run) => [run.init.init_time, run]));
  const runWidth = initColumnPx(product, zone);
  const gutter = gutterPx(bandsOf(product));
  const columns = runColumns(runs.length, runWidth, RUN_GAP_PX);
  // the labels hang off the right edge while the field's column has room
  // for the widest of them beside the plot; the gutter and its gap are the
  // field's own
  const em = chartEm();
  const widestLabel = Math.max(
    ...scale.yTicks.map((tick) => tickText(tick).length),
    series.threshold == null ? 0 : `delayed past ${formatLatency(series.threshold)}`.length,
  );
  const inside =
    columns.width + CHART_LABEL_GAP_PX + widestLabel * 0.6 * em >
    fieldWidth - gutter - RUN_GAP_PX;
  const columnOf = new Map(runs.map((init, index) => [init.init_time, index]));
  const parked = pinnedLayout(
    series.runs.filter((run) => run.elapsed && scale.pinned(run.seconds)),
    (run) => columns.x(columnOf.get(run.init.init_time)),
    { em, titleRight: "time after init".length * 0.6 * em, right: columns.width, top: scale.top },
  );
  // the key starts where the plot does: past the gutter and the band's gap
  return html`<figure
    class="pipeline-runs"
    data-aligned=""
    style=${`--run-width:${runWidth}px;--clumped-run-gap:${RUN_GAP_PX}px;--band-gutter:${gutter}px;--label-h:${LABEL_PX}px;--plot-left:calc(${gutter}px + 0.6rem)`}
  >
    <${AlignedPlot}
      runs=${runs}
      plotted=${plotted}
      scale=${scale}
      series=${series}
      columns=${columns}
      inside=${inside}
      em=${em}
      local=${local}
      parked=${parked}
    />
    <${RunKey} items=${[...runChartKey(product, series.runs), ...pinnedKeyItems(parked.overflow, local)]} />
  </figure>`;
}

/* The details tables. Open details re-render once a second so their durations
   tick; the keyed diff keeps every node, so a table's own scroll box — and the
   reader's place in it — survives the tick. Every wide table on the site scrolls
   inside its own .table-container. */

function Details({ product, now, local, runCount, dimension, fieldWidth }) {
  const details = detailRows(product, now, local);
  // the chart lines up with the lead-group field; an arrival-group field
  // keeps the chart across the row
  const chart = dimension
    ? html`<${RunChart} key="chart" product=${product} now=${now} local=${local} />`
    : html`<${AlignedRunChart}
        key="chart"
        product=${product}
        now=${now}
        local=${local}
        runCount=${runCount}
        fieldWidth=${fieldWidth}
      />`;
  // keyed siblings, no wrapper: a lag or facet table that arrives or leaves
  // with a later run must not change what node the lead table scrolls in
  const leadTable = html`<div key="lead" class="table-container">
    <table>
      <thead>
        <tr>
          <th rowspan="2">horizon</th>
          <th colspan="3">${details.lastHeader}</th>
          <th colspan="3">${details.runHeader}</th>
          <th colspan="4">${details.statsHeader}</th>
        </tr>
        <tr>
          <th>status</th>
          <th>time</th>
          <th>after init</th>
          <th>status</th>
          <th>time</th>
          <th>after init</th>
          <th>p50</th>
          <th>p95</th>
          <th>p99</th>
          <th>delayed past</th>
        </tr>
      </thead>
      <tbody>
        ${details.rows.map(
          (row) => html`<tr key=${row.name}>
            <td>${row.label}</td>
            <${StatusCell} detail=${row.last} />
            <td>${row.last.time}</td>
            <td>${row.last.duration}</td>
            <${StatusCell} detail=${row.run} />
            <td>${row.run.time}</td>
            <td>${row.run.duration}</td>
            <td>${row.p50}</td>
            <td>${row.p95}</td>
            <td>${row.p99}</td>
            <td>${row.threshold}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
  // the lag table names the same last run the lead table does, one number
  const lagTable =
    details.lag &&
    html`<div key="lag" class="table-container">
      <table>
        <thead>
          <tr>
            <th colspan="4">${details.lag.header}</th>
          </tr>
          <tr>
            <th>${details.lastHeader}</th>
            <th>p50</th>
            <th>p95</th>
            <th>p99</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${details.lag.last}</td>
            <td>${details.lag.p50}</td>
            <td>${details.lag.p95}</td>
            <td>${details.lag.p99}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
  const facets = facetRows(product);
  if (facets.length === 0) return html`${chart}${leadTable}${lagTable}`;

  return html`${chart}${leadTable}${lagTable}
    <div key="facets" class="table-container">
      <table class="pipeline-facets">
        <thead>
          <tr>
            <th colspan="5">arrival facets</th>
          </tr>
          <tr>
            <th>dimension</th>
            <th>group</th>
            <th>status</th>
            <th>files</th>
            <th>complete</th>
          </tr>
        </thead>
        <tbody>
          ${facets.map(
            (facet) => html`<tr key=${`${facet.dimension}/${facet.name}`}>
              <td>${facet.dimension}</td>
              <td>${facet.label}</td>
              <${StatusCell} detail=${facet} />
              <td>${facet.count}</td>
              <td>
                <progress
                  max="1"
                  value=${String(facet.completion)}
                  aria-label=${`${Math.round(facet.completion * 100)}% complete`}
                ></progress>
                <span class="pipeline-facet-pct"><span class="pipeline-facet-num">${String(Math.round(facet.completion * 100))}</span>%</span>
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
}

/* A row's summary column: the init it is waiting on, its state, and the ETA.
   These are the nodes the countdown owns, so they read `now`. */

function Eta({ product, now, local }) {
  const target = etaTarget(product);
  if (!target) {
    return html`<strong data-slot="eta-init">—</strong>
      <span data-slot="eta-state" hidden></span>
      <span data-slot="eta-line" hidden></span>`;
  }
  let state;
  let timing = null;
  if (target.running) {
    const observed = (target.init?.completion_pct ?? 0) > 0;
    state = observed ? "processing" : "pending";
    if (target.init?.timing) {
      state += ` · ${target.init.timing.replace("_", " ")}`;
      timing = target.init.timing;
    } else {
      const note = timingBaselineNote(product);
      if (note) state += ` · ${note}`;
    }
  } else {
    const seconds = Math.floor((Date.parse(target.initTime) - now) / 1000);
    state = seconds <= 0 ? "processing" : `init in ${formatDuration(seconds)}`;
  }
  return html`<strong data-slot="eta-init">${initShort(target.initTime, local)}</strong>
    <span data-slot="eta-state" data-timing=${timing}>${state}</span>
    <span data-slot="eta-line" hidden=${!target.target}>${target.target ? etaLineText(target.target, now, local) : ""}</span>`;
}

/* One product. The field is memoised on what it draws from — the product, the
   time mode, the measured width, and the view — so the countdown's `now` never
   touches it; only the ETA and any open details re-render each second. */

function Row({
  product,
  advisory,
  local,
  now,
  viewIndex,
  expanded,
  onCycle,
  onToggle,
}) {
  // the run count comes from the measured row body: a 1fr grid column, so its
  // width does not depend on the field it holds. Measured once the row is in
  // the DOM and again whenever the body changes size — a window resize, a
  // font landing, the toc rail appearing — and the field waits for it.
  const body = useRef(null);
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return undefined;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // the lead grid is the view a row opens on; the facet grids are a click away
  const views = viewsOf(product);
  const index = wrapIndex(viewIndex, views.length);
  const view = views[index];
  // how many runs the field shows; the chart in the details shows the same
  const runCount =
    width == null
      ? null
      : view.dimension
        ? runsThatFitFacetRows(product, width, view.dimension)
        : runsThatFit(product, width, local);
  const field = useMemo(() => {
    if (runCount == null) return null;
    return view.dimension
      ? html`<${FacetRowsField}
          product=${product}
          local=${local}
          runCount=${runCount}
          dimension=${view.dimension}
        />`
      : html`<${LeadField}
          product=${product}
          local=${local}
          runCount=${runCount}
        />`;
  }, [product, local, runCount, index]);

  // the cycle is only reachable, and only worth announcing, when a product has
  // more than the one view
  const cycles = views.length > 1;
  const next = views[(index + 1) % views.length];
  const hasDetails = Boolean(
    product.lead_group_stats?.length || facetRows(product).length,
  );
  const open = hasDetails && expanded;

  return html`<section
    class="pipeline-row"
    data-product-id=${product.id}
    data-view=${String(index)}
  >
    <div>
      <strong>${displayRowLabel(product.row_label)}</strong>
      <div class="pipeline-source-meta">
        <div>${displaySource(product.source)}</div>
        <div>${`${product.cadence_hours ?? "—"}h init cadence`}</div>
        <div>${`${product.init_hours?.join("/") || "—"}z`}</div>
        <div
          class="pipeline-row-advisory"
          data-slot="row-advisory"
          hidden=${!advisory}
        >${advisory ? `⚠ ${advisory.agency.toUpperCase()} advisory` : ""}</div>
      </div>
    </div>
    <div class="pipeline-row-body" ref=${body}>
      <div
        class="pipeline-viz"
        data-slot="field"
        role=${cycles ? "group" : null}
        tabindex=${cycles ? "0" : null}
        aria-label=${cycles
          ? `${view.rows} by ${view.dimension ? "lead group" : "init"}; activate for ${next.rows}`
          : null}
        onClick=${(event) => {
          // the details button and any link keep their own behaviour
          if (event.target.closest("button, a, summary")) return;
          onCycle();
        }}
        onKeyDown=${(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onCycle();
        }}
      >${field}</div>
    </div>
    <div class="pipeline-stats">
      <${Eta} product=${product} now=${now} local=${local} />
      <button
        type="button"
        class="pipeline-details-button"
        data-slot="details-button"
        aria-expanded=${String(open)}
        hidden=${!hasDetails}
        onClick=${onToggle}
      >${open ? "less" : "more details"}</button>
    </div>
    <div class="pipeline-row-details" data-slot="details" hidden=${!open}>
      ${open
        ? html`<${Details}
            product=${product}
            now=${now}
            local=${local}
            runCount=${runCount}
            dimension=${view.dimension}
            fieldWidth=${width}
          />`
        : null}
    </div>
  </section>`;
}

function Advisories({ advisories }) {
  if (advisories.length === 0) return null;
  return html`<div class="pipeline-advisories">
    <strong>${`${advisories.length} active upstream dissemination advisor${advisories.length === 1 ? "y" : "ies"}`}</strong>
    ${advisories.map((advisory) => {
      const description = `${advisory.agency.toUpperCase()} — ${advisory.title}`;
      return html`<p key=${advisory.incident_id ?? `${advisory.agency}\n${advisory.title}`}>
        ${advisory.url
          ? html`<a href=${advisory.url}>${description}</a>`
          : description}
      </p>`;
    })}
  </div>`;
}

function TocTree({ groups }) {
  return groups.map(
    (group) => html`<li key=${group.id} class="toc-h2">
      <a href=${`#pipeline-group-${group.id}`}>${group.label}</a>
    </li>`,
  );
}

/* The groups and their rows, keyed by id so a poll that reorders or adds a
   product moves nodes rather than rebuilding them. */

function Groups({ state, actions }) {
  const { dashboard } = state;
  // the toc script caches the group headings and their links, so it is told
  // when they first exist and whenever the set of groups changes — nothing
  // below a group is its business
  const signature = dashboard
    ? dashboard.groups.map((group) => group.id).join("\n")
    : null;
  useEffect(() => {
    if (signature === null) return;
    document.dispatchEvent(new Event("md-toc:refresh"));
  }, [signature]);

  if (!dashboard) {
    return html`<p data-slot="loading">Loading pipeline status…</p>`;
  }
  const advisories = dashboard.advisories ?? [];
  return dashboard.groups.map(
    (group) => html`<section key=${group.id} class="pipeline-group">
      <h3 id=${`pipeline-group-${group.id}`}>${group.label}</h3>
      ${group.products.map(
        (product) => html`<${Row}
          key=${product.id}
          product=${product}
          advisory=${advisories.findLast((advisory) =>
            advisory.product_ids?.includes(product.id),
          )}
          local=${state.local}
          now=${state.now}
          viewIndex=${state.views[product.id] ?? 0}
          expanded=${state.expanded[product.id] ?? false}
          onCycle=${() => actions.cycleView(product)}
          onToggle=${() => actions.toggleDetails(product.id)}
        />`,
      )}
    </section>`,
  );
}

/* The page's one state object. The poll writes the dashboard and any error,
   the countdown writes only `now`, and user actions write the view and
   expanded maps. Every change repaints from the whole state; Preact's keyed
   diff decides what the DOM needs. */

function createStore(initial, paint) {
  let state = initial;
  let queued = false;
  return {
    get: () => state,
    update(patch) {
      state = {
        ...state,
        ...(typeof patch === "function" ? patch(state) : patch),
      };
      if (queued) return;
      queued = true;
      // one paint per task, however many updates it made
      queueMicrotask(() => {
        queued = false;
        paint(state);
      });
    },
  };
}

function start(app) {
  const base = app.dataset.assetsBase.replace(/\/$/, "");
  const dashboardUrl = `${base}/dashboard.json`;
  const ribbon = app.querySelector('[data-slot="ribbon"]');
  const timeControl = app.querySelector('[data-slot="time-control"]');
  const tocRail = app.querySelector('[data-slot="pipeline-toc-rail"]');
  const timeToggle = app.querySelector("#status-time-toggle");
  const statusUrl = app.querySelector(".status-health").dataset.statusUrl;
  const slots = {
    generatedAt: app.querySelector('[data-slot="generated-at"]'),
    banners: app.querySelector('[data-slot="banners"]'),
    advisories: app.querySelector('[data-slot="advisories"]'),
    groups: app.querySelector('[data-slot="groups"]'),
    tocTree: app.querySelector('[data-slot="pipeline-toc-tree"]'),
  };

  // what the last paint drew, for the writes that should not repeat
  let painted = {};
  function paint(state) {
    const { dashboard } = state;
    document.body.classList.toggle("pipeline-time-local", state.local);
    timeToggle.value = state.local ? "local" : "utc";
    timeControl.hidden = !dashboard;
    tocRail.hidden = !dashboard;
    ribbon.hidden =
      !dashboard ||
      state.now - Date.parse(dashboard.generated_at) <= STALE_AFTER_MS;
    render(
      dashboard ? html`<${TimeNode} timestamp=${dashboard.generated_at} />` : "—",
      slots.generatedAt,
    );
    render(
      state.error
        ? html`<div class="pipeline-banner pipeline-banner--error">
            ${state.error}
          </div>`
        : null,
      slots.banners,
    );
    render(
      html`<${Advisories} advisories=${dashboard?.advisories ?? []} />`,
      slots.advisories,
    );
    render(html`<${TocTree} groups=${dashboard?.groups ?? []} />`, slots.tocTree);
    render(html`<${Groups} state=${state} actions=${actions} />`, slots.groups);
    // the health strip is a polite live region outside any root; it is written
    // only when what it says can have changed, not on every countdown tick
    if (dashboard && dashboard !== painted.dashboard) {
      renderHealth(app, "agency-health", agencyHealth(dashboard.advisories));
    }
    if (state.systemHealth && state.systemHealth !== painted.systemHealth) {
      renderHealth(app, "system-health", state.systemHealth);
    }
    painted = state;
  }

  const store = createStore(
    {
      dashboard: null,
      error: null,
      systemHealth: null,
      local: false,
      now: Date.now(),
      views: {},
      expanded: {},
    },
    paint,
  );

  /* Clicking a product's field cycles its rows: lead time, then one grid per
     facet dimension. The view index lives in the state, keyed by product. */

  const actions = {
    cycleView(product) {
      const count = viewsOf(product).length;
      if (count < 2) return;
      // stored wrapped, as the old row attribute was, so the index never
      // outruns the views and a later change in their number reads the same
      store.update((state) => ({
        views: {
          ...state.views,
          [product.id]: wrapIndex((state.views[product.id] ?? 0) + 1, count),
        },
        now: Date.now(),
      }));
    },
    toggleDetails(productId) {
      store.update((state) => ({
        expanded: { ...state.expanded, [productId]: !state.expanded[productId] },
      }));
    },
  };

  async function fetchJson(url, cache = "default") {
    const response = await fetch(url, {
      cache,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // the DOM shows the index wrapped to the views a product offers; store the
  // wrapped value, or a view that went away and came back would jump the row
  // from the lead grid it had settled on straight to the returned view
  function wrappedViews(views, dashboard) {
    const wrapped = {};
    for (const product of productsOf(dashboard)) {
      if (!(product.id in views)) continue;
      wrapped[product.id] = wrapIndex(
        views[product.id],
        viewsOf(product).length,
      );
    }
    return wrapped;
  }

  async function tick() {
    try {
      const dashboard = validateDashboard(
        await fetchJson(dashboardUrl, "no-cache"),
      );
      store.update((state) => ({
        dashboard,
        views: wrappedViews(state.views, dashboard),
        error: null,
        now: Date.now(),
      }));
    } catch (error) {
      store.update((state) => ({
        error: state.dashboard
          ? `Couldn't refresh pipeline status (${error.message}). Showing last-known state.`
          : `Couldn't load pipeline status (${error.message}).`,
        now: Date.now(),
      }));
    }
  }

  async function loadSystemHealth() {
    let health;
    try {
      health = systemHealth(await fetchJson(statusUrl, "no-cache"));
    } catch {
      health = systemHealth(null);
    }
    store.update({ systemHealth: health });
  }

  function updateLiveCountdowns() {
    if (!store.get().dashboard) return;
    store.update({ now: Date.now() });
  }

  let pollTimer = null;
  let countdownTimer = null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(pollTimer);
      pollTimer = null;
      clearInterval(countdownTimer);
      countdownTimer = null;
    } else {
      tick();
      pollTimer ??= setInterval(tick, POLL_INTERVAL_MS);
      countdownTimer ??= setInterval(updateLiveCountdowns, 1000);
    }
  });

  store.update({
    local: setupTimeToggle(timeToggle, (local) =>
      store.update({ local, now: Date.now() }),
    ),
  });
  loadSystemHealth();
  tick();
  setInterval(loadSystemHealth, HEALTH_REFRESH_INTERVAL_MS);
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  countdownTimer = setInterval(updateLiveCountdowns, 1000);
}

if (typeof document !== "undefined") {
  const app = document.querySelector("#pipeline-app");
  if (app) start(app);
}
