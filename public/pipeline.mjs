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
const DASHBOARD_VERSION = 2; // the granular schema; the lead-only shape is gone
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
const FOOT_GAP_PX = 3; // the breath above the init tiers
const HEAD_GAP_PX = 2; // the head band's margin under the lead labels
const CH_PX = 6; // one monospace character at the band-label size
const GUTTER_MAX_CH = 24; // long facet labels get room, but not unbounded
const RUNS_MAX = 10; // what the payload carries

function hasTimestamp(value) {
  return (
    typeof value === "string" &&
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
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
        typeof facet.status === "string",
    )
  );
}

export function validateDashboard(data) {
  if (
    !data ||
    data.v !== DASHBOARD_VERSION ||
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
      for (const init of product.recent_inits) {
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

function productsOf(snapshot) {
  if (Array.isArray(snapshot.products)) return snapshot.products;
  return (snapshot.groups ?? []).flatMap((group) => group.products ?? []);
}

function element(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null) continue;
    if (name === "class") node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of [].concat(children ?? [])) {
    if (child == null || child === false) continue;
    node.append(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child,
    );
  }
  return node;
}

function formatLatency(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
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
  // scrubbing through history would otherwise grow this without bound
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

function timeNode(timestamp) {
  return element("span", null, [
    element(
      "span",
      { class: "pipeline-time-utc" },
      formatTime(timestamp, false, false),
    ),
    element(
      "span",
      { class: "pipeline-time-local-only" },
      formatTime(timestamp, true, false),
    ),
  ]);
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
   payload declares them in. History snapshots declare neither list up front,
   so both fall back to the newest run's own. */

export function leadAxis(product) {
  const labelOf = new Map(
    (product.lead_group_stats ?? []).map((stats) => [stats.name, stats.label]),
  );
  // a snapshot's newest run can be unobserved and carry no groups at all, while
  // the runs beside it carry full data — so take the newest that reported any
  const reported = [...(product.recent_inits ?? [])]
    .reverse()
    .find((init) => init.lead_groups?.length);
  const declared = product.lead_groups?.length
    ? product.lead_groups
    : (reported?.lead_groups ?? []);
  return declared.map((group) => ({
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

function leadLabel(lead, width) {
  return element(
    "span",
    {
      class: "pipeline-column-label",
      style: `--cell-w:${width.toFixed(2)}px`,
      title: `lead ${lead.label}`,
    },
    lead.label,
  );
}

/* How tall a view draws. The label rows have fixed heights, so this needs no
   measurement — which matters because the render pass writes without reading. */

function chromePx(view, rows) {
  const gap = view.dimension ? FACET_BAND_GAP_PX : BAND_GAP_PX;
  const head = view.dimension ? LABEL_PX + gap + HEAD_GAP_PX : 0;
  const tiers = FOOT_GAP_PX + 2 * (LABEL_PX + gap);
  return head + tiers + gap * Math.max(0, rows - 1);
}

function viewHeightPx(product, view) {
  const bands = view.dimension
    ? facetRowsOf(product, view.dimension).map(() => FACET_CELL_PX)
    : [...leadExtents(product).values()];
  const rows = bands.length || 1;
  const laneHeight =
    bands.reduce((sum, px) => sum + px, 0) + chromePx(view, rows);
  if (!view.dimension) return laneHeight;
  const laneCount = Math.min(
    FACET_LANES,
    Math.max(1, product.recent_inits?.length ?? 0),
  );
  return laneHeight * laneCount + FACET_LANE_GAP_PX * (laneCount - 1);
}

/* The box every view of a product sits in: the tallest one. Clicking through
   the views then never moves the rest of the page. */

export function reservedHeightPx(product) {
  return Math.max(
    ...viewsOf(product).map((view) => viewHeightPx(product, view)),
  );
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

function bandNode({
  className = "pipeline-band",
  kind,
  label = "",
  labelTitle,
  clumped = false,
  style,
  children,
}) {
  return element("div", { class: className, "data-kind": kind, style }, [
    element("span", { class: "pipeline-band-label", title: labelTitle }, label),
    element(
      "div",
      { class: "pipeline-cells", "data-clumped": clumped ? "" : null },
      children,
    ),
  ]);
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

function renderCell(band, init, local, measured, style) {
  const cell = measured ?? cellOf(band, init);
  return element(
    "div",
    {
      class: `pipeline-cell g-${cell.state}`,
      "data-init-time": init?.init_time,
      "data-timing": cell.timing,
      title: cellTitle(band, init, cell, local),
      style,
    },
    element("div", {
      class: "pipeline-cell-fill",
      style: `--fill:${Math.max(0, Math.min(100, (cell.completion ?? 0) * 100))}%`,
    }),
  );
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

function initTiers(runs, local) {
  const zone = selectedTimeZone(local);
  let previousDate = null;
  return [
    labelTier({
      bandClass: "pipeline-band pipeline-band--foot",
      spanClass: "pipeline-run-label",
      runs,
      textOf: (init) => initParts(init.init_time, zone).time,
      titleOf: (init) => initShort(init.init_time, local),
    }),
    labelTier({
      spanClass: "pipeline-run-date",
      runs,
      textOf: (init) => {
        const { date } = initParts(init.init_time, zone);
        const turned = date !== previousDate;
        previousDate = date;
        return turned ? date : "";
      },
    }),
  ];
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

function labelTier({
  bandClass = "pipeline-band",
  spanClass,
  runs,
  textOf,
  titleOf,
}) {
  return bandNode({
    className: bandClass,
    clumped: true,
    children: runs.map((init, index) =>
      element(
        "span",
        { class: spanClass, title: titleOf?.(init) },
        textOf(init, index),
      ),
    ),
  });
}

/* The facet-row field: one row per facet, one block per run, one column per
   lead group inside a block. Same squares and same hover labels as the banded
   field — only which dimension owns which axis changes. */

function renderFacetLane(product, local, runs, leads, facets, leadWidth) {
  const joint = jointIndex(product, runs, leads);
  const lane = element("div", { class: "pipeline-facet-lane" });
  lane.append(
    bandNode({
      className: "pipeline-band pipeline-band--head",
      clumped: true,
      children: runs.map(() =>
        element(
          "div",
          { class: "pipeline-clump" },
          leads.map((lead) => leadLabel(lead, leadWidth(lead))),
        ),
      ),
    }),
  );
  const rowsNode = element("div", { class: "pipeline-rows" });
  for (const facet of facets) {
    rowsNode.append(
      bandNode({
        kind: "facet",
        label: facetAxisLabel(facet),
        labelTitle: `${facet.label} (${facet.dimension})`,
        clumped: true,
        children: runs.map((init) =>
          element(
            "div",
            { class: "pipeline-clump" },
            leads.map((lead) => {
              const measured = joint.get(init)?.get(lead.key);
              const facetAt = measured?.facets.get(facet.name);
              const band = {
                kind: "facet",
                key: facet.name,
                label: facet.label,
                dimension: facet.dimension,
                lead: lead.label,
              };
              return renderCell(
                band,
                init,
                local,
                facetAt
                  ? facetCell(facetAt, init, measured.timing)
                  : { state: "unobserved" },
                `--cell-w:${leadWidth(lead).toFixed(2)}px`,
              );
            }),
          ),
        ),
      }),
    );
  }
  lane.append(rowsNode);
  lane.append(...initTiers(runs, local));
  return lane;
}

function renderFacetRows(product, local, runCount, dimension) {
  const runs = product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
  const leads = leadAxis(product); // shortest horizon first
  const facets = facetRowsOf(product, dimension);
  const extents = compactLeadExtents(product);
  const leadWidth = (lead) => extents.get(lead.key) ?? FACET_CELL_PX;
  const runWidth =
    leads.reduce((sum, lead) => sum + leadWidth(lead), 0) +
    Math.max(0, leads.length - 1) * FACET_CLUMP_GAP_PX;
  const field = element("div", {
    class: "pipeline-field",
    // lead time runs across here, so progress fills across too
    "data-fill": "side",
    "data-compact": "",
    style: `--sq:${FACET_CELL_PX}px;--clump-gap:${FACET_CLUMP_GAP_PX}px;--clumped-run-gap:${FACET_RUN_GAP_PX}px;--lane-gap:${FACET_LANE_GAP_PX}px;--band-gutter:${facetGutterPx(facets)}px;--run-width:${runWidth}px;--band-gap:${FACET_BAND_GAP_PX}px;--label-h:${LABEL_PX}px;--reserve:${reservedHeightPx(product)}px`,
  });
  const laneCount = Math.min(FACET_LANES, Math.max(1, runs.length));
  const runsPerLane = Math.ceil(runs.length / laneCount);
  // older runs occupy the first lane; newer runs continue in the second
  for (let start = 0; start < runs.length; start += runsPerLane) {
    field.append(
      renderFacetLane(
        product,
        local,
        runs.slice(start, start + runsPerLane),
        leads,
        facets,
        leadWidth,
      ),
    );
  }
  return field;
}

function renderField(product, local, runCount) {
  const runs = product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
  const extents = leadExtents(product);
  const column = initColumnPx(product, selectedTimeZone(local));
  const field = element("div", {
    class: "pipeline-field",
    // a cell is as wide as its init label; the lead axis keeps its own scale
    style: `--sq:${column}px;--run-gap:${RUN_GAP_PX}px;--clumped-run-gap:${RUN_GAP_PX}px;--run-width:${column}px;--band-gutter:${gutterPx(bandsOf(product))}px;--band-gap:${BAND_GAP_PX}px;--label-h:${LABEL_PX}px;--reserve:${reservedHeightPx(product)}px`,
  });
  for (const band of bandsOf(product)) {
    field.append(
      bandNode({
        kind: band.kind,
        label: band.label,
        labelTitle: band.label,
        // a lead band is as tall as its share of the run; a facet band is a cell
        style: `--cell-h:${(band.kind === "lead" ? (extents.get(band.key) ?? CELL_PX) : CELL_PX).toFixed(2)}px`,
        children: runs.map((init) => renderCell(band, init, local)),
      }),
    );
  }

  // every column is wide enough to name itself, so the axis is per column
  field.append(...initTiers(runs, local));
  return field;
}

function renderStructure(app, dashboard, rows) {
  const groupsSlot = app.querySelector('[data-slot="groups"]');
  groupsSlot.replaceChildren();
  rows.clear();

  for (const group of dashboard.groups) {
    const section = element("section", { class: "pipeline-group" }, [
      element("h3", null, group.label),
    ]);
    for (const product of group.products) {
      const advisory = element("div", {
        class: "pipeline-row-advisory",
        "data-slot": "row-advisory",
        hidden: "",
      });
      const row = element(
        "section",
        { class: "pipeline-row", "data-product-id": product.id },
        [
          element("div", null, [
            element("strong", null, product.row_label),
            element("div", { class: "pipeline-source-meta" }, [
              element("div", null, displaySource(product.source)),
              element("div", null, `${product.cadence_hours ?? "—"}h init cadence`),
              element("div", null, `${product.init_hours?.join("/") || "—"}z`),
              advisory,
            ]),
          ]),
          element("div", { class: "pipeline-row-body" }, [
            element("div", { class: "pipeline-viz", "data-slot": "field" }),
          ]),
          element("div", { class: "pipeline-stats" }, [
            element("strong", { "data-slot": "eta-init" }, "—"),
            element("span", { "data-slot": "eta-state", hidden: "" }),
            element("span", { "data-slot": "eta-line", hidden: "" }),
            element(
              "button",
              {
                type: "button",
                class: "pipeline-details-button",
                "data-slot": "details-button",
                "aria-expanded": "false",
                hidden: "",
              },
              "more details",
            ),
          ]),
          element("div", {
            class: "pipeline-row-details",
            "data-slot": "details",
            hidden: "",
          }),
        ],
      );
      rows.set(product.id, row);
      section.append(row);
    }
    groupsSlot.append(section);
  }
}

function etaTarget(product) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
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
function statsHeader(sampleInitCount) {
  if (!sampleInitCount) return "time after init";
  const inits = sampleInitCount === 1 ? "init" : "inits";
  return `time after init · ${sampleInitCount.toLocaleString("en-US")} ${inits}`;
}

export function detailRows(product, now, local) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
  );
  const displayed = running ?? product.recent_inits.at(-1);
  const groups = displayed?.lead_groups ?? [];
  const initMs = displayed ? Date.parse(displayed.init_time) : 0;
  return {
    header: running
      ? initShort(running.init_time, local)
      : displayed
        ? `${initShort(displayed.init_time, local)} · previous init`
        : "waiting for next init",
    statsHeader: statsHeader(product.latency_stats?.sample_init_count),
    rows: (product.lead_group_stats ?? []).map((stats, index) => {
      const live = groups[index];
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
      } else if (running && stats.p95_s != null) {
        const target = initMs + stats.p95_s * 1000;
        if (target > now) {
          time = `ETA ${clockTime(target, selectedTimeZone(local))}`;
        }
        const elapsed = Math.floor((now - initMs) / 1000);
        if (elapsed > 0) duration = formatDuration(elapsed);
      }
      return {
        label: stats.label,
        status: statusLabel(live?.status ?? "pending"),
        time,
        duration,
        p50: formatLatency(stats.p50_s),
        p95: formatLatency(stats.p95_s),
        p99: formatLatency(stats.p99_s),
      };
    }),
  };
}

export function facetRows(product) {
  const running = product.recent_inits.findLast(
    (init) => init.status === "in_flight",
  );
  const displayed = running ?? product.recent_inits.at(-1);
  return (displayed?.facets ?? []).map((facet) => ({
    dimension: facet.dimension,
    label: facet.label,
    status: statusLabel(facet.status),
    completion: facet.completion_pct,
    count: `${facet.dependencies_available.toLocaleString("en-US")} / ${facet.dependencies_expected.toLocaleString("en-US")} observed`,
  }));
}

function buildDetails(product, now, local) {
  const details = detailRows(product, now, local);
  const groupHead = element("tr", null, [
    element("th"),
    element("th", { colspan: "3" }, details.header),
    element("th", { colspan: "3" }, details.statsHeader),
  ]);
  const head = element("tr", null, [
    element("th", null, "horizon"),
    element("th", null, "status"),
    element("th", null, "time"),
    element("th", null, "duration"),
    element("th", null, "p50"),
    element("th", null, "p95"),
    element("th", null, "p99"),
  ]);
  const body = element("tbody");
  for (const row of details.rows) {
    body.append(
      element("tr", null, [
        element("td", null, row.label),
        element("td", null, row.status),
        element("td", null, row.time),
        element("td", null, row.duration),
        element("td", null, row.p50),
        element("td", null, row.p95),
        element("td", null, row.p99),
      ]),
    );
  }
  const leadTable = element("table", null, [
    element("thead", null, [groupHead, head]),
    body,
  ]);
  const facets = facetRows(product);
  if (facets.length === 0) return leadTable;

  const facetBody = element("tbody");
  for (const facet of facets) {
    facetBody.append(
      element("tr", null, [
        element("td", null, facet.dimension),
        element("td", null, facet.label),
        element("td", null, facet.status),
        element("td", null, facet.count),
        element("td", null, [
          element("progress", {
            max: "1",
            value: String(facet.completion),
            "aria-label": `${Math.round(facet.completion * 100)}% complete`,
          }),
          // the number holds three characters whatever it is — "5", "62", "100" —
          // so every bar ends in the same place, with the sign kept against it
          element("span", { class: "pipeline-facet-pct" }, [
            element(
              "span",
              { class: "pipeline-facet-num" },
              String(Math.round(facet.completion * 100)),
            ),
            "%",
          ]),
        ]),
      ]),
    );
  }
  const facetTable = element("table", { class: "pipeline-facets" }, [
    element("thead", null, [
      element("tr", null, [
        element("th", { colspan: "5" }, "arrival facets"),
      ]),
      element("tr", null, [
        element("th", null, "dimension"),
        element("th", null, "group"),
        element("th", null, "status"),
        element("th", null, "files"),
        element("th", null, "complete"),
      ]),
    ]),
    facetBody,
  ]);
  return element("div", null, [leadTable, facetTable]);
}

function hydrateRow(row, product, now, local, available) {
  // the lead grid is the view a row opens on; the facet grids are a click away
  const views = viewsOf(product);
  const index = wrapIndex(Number(row.dataset.view ?? 0), views.length);
  const view = views[index];
  row.dataset.view = String(index);

  const field = view.dimension
    ? renderFacetRows(
        product,
        local,
        runsThatFitFacetRows(product, available, view.dimension),
        view.dimension,
      )
    : renderField(product, local, runsThatFit(product, available, local));

  const viz = row.querySelector('[data-slot="field"]');
  viz.replaceChildren(field);
  // the cycle is only reachable, and only worth announcing, when a product has
  // more than the one view
  if (views.length > 1) {
    const next = views[(index + 1) % views.length];
    // a group, not a button: role="button" would collapse the field into one
    // node and hide every cell's own label from assistive tech
    viz.setAttribute("role", "group");
    viz.setAttribute("tabindex", "0");
    viz.setAttribute(
      "aria-label",
      `${view.rows} by ${view.dimension ? "lead group" : "init"}; activate for ${next.rows}`,
    );
  } else {
    viz.removeAttribute("role");
    viz.removeAttribute("tabindex");
    viz.removeAttribute("aria-label");
  }
  hydrateEta(row, product, now, local);

  const button = row.querySelector('[data-slot="details-button"]');
  const details = row.querySelector('[data-slot="details"]');
  if (product.lead_group_stats?.length || facetRows(product).length) {
    button.hidden = false;
    details.replaceChildren(buildDetails(product, now, local));
  } else {
    button.hidden = true;
    details.hidden = true;
  }
}

function hydrateEta(row, product, now, local) {
  const initSlot = row.querySelector('[data-slot="eta-init"]');
  const stateSlot = row.querySelector('[data-slot="eta-state"]');
  const lineSlot = row.querySelector('[data-slot="eta-line"]');
  const target = etaTarget(product);
  if (!target) {
    initSlot.textContent = "—";
    stateSlot.hidden = true;
    lineSlot.hidden = true;
  } else {
    initSlot.textContent = initShort(target.initTime, local);
    stateSlot.hidden = false;
    if (target.running) {
      const observed = (target.init?.completion_pct ?? 0) > 0;
      stateSlot.textContent = observed ? "processing" : "pending";
      if (target.init?.timing) {
        stateSlot.textContent += ` · ${target.init.timing.replace("_", " ")}`;
        stateSlot.dataset.timing = target.init.timing;
      } else {
        delete stateSlot.dataset.timing;
      }
    } else {
      const seconds = Math.floor((Date.parse(target.initTime) - now) / 1000);
      stateSlot.textContent =
        seconds <= 0 ? "processing" : `init in ${formatDuration(seconds)}`;
    }
    lineSlot.hidden = !target.target;
    if (target.target) {
      lineSlot.textContent = etaLineText(target.target, now, local);
    }
  }
}

function renderAdvisories(app, advisories, rows) {
  renderHealth(app, "agency-health", agencyHealth(advisories));

  for (const row of rows.values()) {
    const marker = row.querySelector('[data-slot="row-advisory"]');
    marker.hidden = true;
    marker.replaceChildren();
  }
  const slot = app.querySelector('[data-slot="advisories"]');
  slot.replaceChildren();
  if (advisories.length === 0) return;

  const container = element("div", { class: "pipeline-advisories" }, [
    element(
      "strong",
      null,
      `${advisories.length} active upstream dissemination advisor${advisories.length === 1 ? "y" : "ies"}`,
    ),
  ]);
  for (const advisory of advisories) {
    const description = `${advisory.agency.toUpperCase()} — ${advisory.title}`;
    container.append(
      element(
        "p",
        null,
        advisory.url
          ? element("a", { href: advisory.url }, description)
          : description,
      ),
    );
    for (const productId of advisory.product_ids ?? []) {
      const marker = rows
        .get(productId)
        ?.querySelector('[data-slot="row-advisory"]');
      if (!marker) continue;
      marker.hidden = false;
      marker.textContent = `⚠ ${advisory.agency.toUpperCase()} advisory`;
    }
  }
  slot.append(container);
}

function renderSnapshot(app, snapshot, rows, now) {
  const local = document.body.classList.contains("pipeline-time-local");
  app.querySelector('[data-slot="time-control"]').hidden = false;
  app
    .querySelector('[data-slot="generated-at"]')
    .replaceChildren(timeNode(snapshot.generated_at));
  // measure every row before writing any of them: the row body is a 1fr grid
  // column, so its width does not depend on the field it holds, and reading all
  // the widths first costs one layout instead of one per product
  const pending = [];
  for (const product of productsOf(snapshot)) {
    const row = rows.get(product.id);
    if (!row) continue;
    const body = row.querySelector(".pipeline-row-body");
    pending.push([row, product, body?.getBoundingClientRect().width ?? 0]);
  }
  for (const [row, product, available] of pending) {
    hydrateRow(row, product, now, local, available);
  }
  renderAdvisories(app, snapshot.advisories ?? [], rows);
}

function historyTimestamp(value) {
  return value.replace(
    /T(\d{2})-(\d{2})-(\d{2})Z$/,
    "T$1:$2:$3Z",
  );
}

function start(app) {
  const base = app.dataset.assetsBase.replace(/\/$/, "");
  const dashboardUrl = `${base}/dashboard.json`;
  const historyIndexUrl = `${base}/history/index.json`;
  const rows = new Map();
  const ribbon = app.querySelector('[data-slot="ribbon"]');
  const banners = app.querySelector('[data-slot="banners"]');
  const timeToggle = app.querySelector("#status-time-toggle");
  const historyButton = app.querySelector("#pipeline-history-toggle");
  const historyPanel = app.querySelector("#pipeline-history-panel");
  const historyRange = app.querySelector("#pipeline-history-range");
  const scrubLabel = app.querySelector('[data-slot="scrub-label"]');
  const scrubError = app.querySelector('[data-slot="scrub-error"]');
  const returnLive = app.querySelector('[data-slot="return-live"]');
  const statusUrl = app.querySelector(".status-health").dataset.statusUrl;

  let latest = null;
  let mode = "live";
  let historyIndex = null;
  let pollTimer = null;
  let countdownTimer = null;
  let structureSignature = null;
  let displayedSnapshot = null;
  let displayedAt = null;

  function displaySnapshot(snapshot, now) {
    displayedSnapshot = snapshot;
    displayedAt = now;
    renderSnapshot(app, snapshot, rows, now);
  }

  /* Clicking a product's field cycles its rows: lead time, then one grid per
     facet dimension. The listener is delegated to the group container so it
     survives every re-render, and the view index lives on the row. */

  function cycleView(row) {
    if (!row || !displayedSnapshot) return;
    const product = productsOf(displayedSnapshot).find(
      (entry) => entry.id === row.dataset.productId,
    );
    if (!product || viewsOf(product).length < 2) return;
    row.dataset.view = String(Number(row.dataset.view ?? 0) + 1);
    const body = row.querySelector(".pipeline-row-body");
    hydrateRow(
      row,
      product,
      displayedAt ?? Date.now(),
      document.body.classList.contains("pipeline-time-local"),
      body?.getBoundingClientRect().width ?? 0,
    );
  }

  const groupsSlot = app.querySelector('[data-slot="groups"]');
  groupsSlot.addEventListener("click", (event) => {
    // the details button and any link keep their own behaviour
    if (event.target.closest("button, a, summary")) return;
    cycleView(event.target.closest(".pipeline-viz")?.closest(".pipeline-row"));
  });
  groupsSlot.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const viz = event.target.closest?.(".pipeline-viz");
    if (!viz) return;
    event.preventDefault();
    cycleView(viz.closest(".pipeline-row"));
  });

  // the run count comes from the measured row, so a resize has to re-fit
  let refitTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      if (!displayedSnapshot) return;
      // a scrubbed snapshot keeps the time it was displayed at, exactly as the
      // time-mode handler does — re-timing it to now invents latencies
      displaySnapshot(
        displayedSnapshot,
        mode === "live" ? Date.now() : displayedAt,
      );
    }, 150);
  });

  function setTimeMode(local) {
    document.body.classList.toggle("pipeline-time-local", local);
    timeToggle.value = local ? "local" : "utc";
    if (displayedSnapshot) {
      displaySnapshot(
        displayedSnapshot,
        mode === "live" ? Date.now() : displayedAt,
      );
    }
    const selected = mode === "scrub" ? selectedTimestamp() : null;
    if (selected) updateScrubLabel(selected);
  }

  function showError(message) {
    banners.replaceChildren(
      element("div", { class: "pipeline-banner pipeline-banner--error" }, message),
    );
  }

  function applyLive() {
    const nextSignature = latest.groups
      .flatMap((group) => [group.id, ...group.products.map(({ id }) => id)])
      .join("\n");
    if (nextSignature !== structureSignature) {
      renderStructure(app, latest, rows);
      structureSignature = nextSignature;
    }
    banners.replaceChildren();
    ribbon.hidden =
      Date.now() - Date.parse(latest.generated_at) <= STALE_AFTER_MS;
    displaySnapshot(latest, Date.now());
  }

  async function fetchJson(url, cache = "default") {
    const response = await fetch(url, {
      cache,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function tick() {
    if (mode !== "live") return;
    try {
      const dashboard = validateDashboard(
        await fetchJson(dashboardUrl, "no-cache"),
      );
      if (mode !== "live") return;
      latest = dashboard;
      applyLive();
    } catch (error) {
      if (latest) {
        applyLive();
        showError(`Couldn't refresh pipeline status (${error.message}). Showing last-known state.`);
      } else {
        showError(`Couldn't load pipeline status (${error.message}).`);
      }
    }
  }

  async function loadSystemHealth() {
    try {
      renderHealth(
        app,
        "system-health",
        systemHealth(await fetchJson(statusUrl, "no-cache")),
      );
    } catch {
      renderHealth(app, "system-health", systemHealth(null));
    }
  }

  function selectedTimestamp() {
    if (!historyIndex?.length) return null;
    return historyIndex[historyIndex.length - 1 - Number(historyRange.value)];
  }

  function updateScrubLabel(timestamp) {
    const date = historyTimestamp(timestamp);
    scrubLabel.textContent = formatTime(
      date,
      document.body.classList.contains("pipeline-time-local"),
    );
    historyRange.setAttribute("aria-valuetext", scrubLabel.textContent);
    const max = Number(historyRange.max);
    const percent = max ? (Number(historyRange.value) / max) * 100 : 50;
    scrubLabel.style.setProperty("--thumb-pct", `${percent}%`);
    historyPanel.style.setProperty("--thumb-pct", `${percent}%`);
  }

  async function showSnapshot(timestamp) {
    try {
      const snapshot = await fetchJson(
        `${base}/history/${timestamp}.json`,
        "no-cache",
      );
      if (mode !== "scrub") return;
      displaySnapshot(snapshot, Date.parse(snapshot.generated_at));
      scrubError.hidden = true;
    } catch (error) {
      scrubError.hidden = false;
      scrubError.textContent = `Snapshot unavailable (${error.message}).`;
    }
  }

  async function openHistory() {
    historyPanel.hidden = false;
    historyButton.setAttribute("aria-expanded", "true");
    if (!historyIndex) {
      try {
        historyIndex = await fetchJson(historyIndexUrl, "no-cache");
        if (!Array.isArray(historyIndex) || historyIndex.length === 0) {
          throw new Error("empty history");
        }
      } catch (error) {
        scrubError.hidden = false;
        scrubError.textContent = `History unavailable (${error.message}).`;
        return;
      }
    }
    historyRange.max = historyIndex.length - 1;
    historyRange.value = historyIndex.length - 1;
    historyRange.disabled = false;
    updateScrubLabel(selectedTimestamp());
  }

  function resumeLive(close = false) {
    mode = "live";
    returnLive.hidden = true;
    ribbon.hidden = false;
    if (close) {
      historyPanel.hidden = true;
      historyButton.setAttribute("aria-expanded", "false");
    }
    tick();
    if (pollTimer == null) pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    if (countdownTimer == null) {
      countdownTimer = setInterval(updateLiveCountdowns, 1000);
    }
  }

  function updateLiveCountdowns() {
    if (mode !== "live" || !latest) return;
    const local = document.body.classList.contains("pipeline-time-local");
    const now = Date.now();
    for (const product of productsOf(latest)) {
      const row = rows.get(product.id);
      if (!row) continue;
      hydrateEta(row, product, now, local);
      const details = row.querySelector('[data-slot="details"]');
      if (!details.hidden) {
        details.replaceChildren(buildDetails(product, now, local));
      }
    }
  }

  historyButton.addEventListener("click", () => {
    if (historyPanel.hidden) openHistory();
    else if (mode === "scrub") resumeLive(true);
    else {
      historyPanel.hidden = true;
      historyButton.setAttribute("aria-expanded", "false");
    }
  });
  historyRange.addEventListener("input", () => {
    const timestamp = selectedTimestamp();
    if (!timestamp) return;
    updateScrubLabel(timestamp);
    if (Number(historyRange.value) === Number(historyRange.max)) {
      resumeLive();
      return;
    }
    mode = "scrub";
    clearInterval(pollTimer);
    pollTimer = null;
    clearInterval(countdownTimer);
    countdownTimer = null;
    ribbon.hidden = true;
    banners.replaceChildren();
    returnLive.hidden = false;
    showSnapshot(timestamp);
  });
  returnLive.addEventListener("click", () => resumeLive(true));
  app.addEventListener("click", (event) => {
    const button = event.target.closest('[data-slot="details-button"]');
    if (!button) return;
    const details = button
      .closest(".pipeline-row")
      .querySelector('[data-slot="details"]');
    details.hidden = !details.hidden;
    button.textContent = details.hidden ? "more details" : "less";
    button.setAttribute("aria-expanded", String(!details.hidden));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(pollTimer);
      pollTimer = null;
      clearInterval(countdownTimer);
      countdownTimer = null;
    } else if (mode === "live") {
      tick();
      pollTimer ??= setInterval(tick, POLL_INTERVAL_MS);
      countdownTimer ??= setInterval(updateLiveCountdowns, 1000);
    }
  });

  setTimeMode(setupTimeToggle(timeToggle, setTimeMode));
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
