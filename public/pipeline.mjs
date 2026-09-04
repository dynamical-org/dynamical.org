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

function productsOf(dashboard) {
  return dashboard.groups.flatMap((group) => group.products);
}

// a dynamical row reads its lag off the sources beside it, so every row needs
// its group's products; one pass builds the lookup for a whole render
function groupProductsById(dashboard) {
  const index = new Map();
  for (const group of dashboard.groups) {
    for (const product of group.products) index.set(product.id, group.products);
  }
  return index;
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
   field — only which dimension owns which axis changes. */

function FacetLane({ product, local, runs, leads, facets, leadWidth }) {
  const joint = jointIndex(product, runs, leads);
  return html`<div class="pipeline-facet-lane">
    <${Band} className="pipeline-band pipeline-band--head" clumped>
      ${runs.map(
        (init) =>
          html`<div key=${init.init_time} class="pipeline-clump">
            ${leads.map(
              (lead) =>
                html`<${LeadLabel}
                  key=${lead.key}
                  lead=${lead}
                  width=${leadWidth(lead)}
                />`,
            )}
          </div>`,
      )}
    <//>
    <div class="pipeline-rows">
      ${facets.map(
        (facet) =>
          html`<${Band}
            key=${facet.name}
            kind="facet"
            label=${facetAxisLabel(facet)}
            labelTitle=${`${facet.label} (${facet.dimension})`}
            clumped
          >
            ${runs.map(
              (init) =>
                html`<div key=${init.init_time} class="pipeline-clump">
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
            )}
          <//>`,
      )}
    </div>
    <${InitTiers} runs=${runs} local=${local} />
  </div>`;
}

function FacetRowsField({ product, local, runCount, dimension }) {
  const runs = product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
  const leads = leadAxis(product); // shortest horizon first
  const facets = facetRowsOf(product, dimension);
  const extents = compactLeadExtents(product);
  const leadWidth = (lead) => extents.get(lead.key) ?? FACET_CELL_PX;
  const runWidth =
    leads.reduce((sum, lead) => sum + leadWidth(lead), 0) +
    Math.max(0, leads.length - 1) * FACET_CLUMP_GAP_PX;
  const laneCount = Math.min(FACET_LANES, Math.max(1, runs.length));
  const runsPerLane = Math.ceil(runs.length / laneCount);
  // older runs occupy the first lane; newer runs continue in the second
  const lanes = [];
  for (let start = 0; start < runs.length; start += runsPerLane) {
    lanes.push(runs.slice(start, start + runsPerLane));
  }
  return html`<div
    class="pipeline-field"
    data-fill="side"
    data-compact=""
    style=${`--sq:${FACET_CELL_PX}px;--clump-gap:${FACET_CLUMP_GAP_PX}px;--clumped-run-gap:${FACET_RUN_GAP_PX}px;--lane-gap:${FACET_LANE_GAP_PX}px;--band-gutter:${facetGutterPx(facets)}px;--run-width:${runWidth}px;--band-gap:${FACET_BAND_GAP_PX}px;--label-h:${LABEL_PX}px`}
  >
    ${lanes.map(
      (lane) =>
        html`<${FacetLane}
          key=${lane[0].init_time}
          product=${product}
          local=${local}
          runs=${lane}
          leads=${leads}
          facets=${facets}
          leadWidth=${leadWidth}
        />`,
    )}
  </div>`;
}

function LeadField({ product, local, runCount }) {
  const runs = product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
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

// A lag has no published baseline behind it, so its sample is the handful of
// runs the payload carries — named apart from the upstream rows' own count.
// The note beside it is about the row's own arrival baseline, not the lag
// sample: the lag stays, but without that baseline the run gets no timing.
function lagStatsHeader(sampleCount, note = null) {
  if (!sampleCount) return "lag after source";
  const samples = sampleCount === 1 ? "recent sample" : "recent samples";
  const header = `lag after source · ${sampleCount.toLocaleString("en-US")} ${samples}`;
  return note ? `${header} · ${note}` : header;
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

/* Ingestion lag. dynamical.org's own rows sit in the same group as the upstream
   sources they read, and their `source_label` is null; what matters for them is
   not time after init but how long after the source published the dataset
   landed. Both latencies are seconds after the same init, so the init cancels
   out of the subtraction. */

export function sourceRowsOf(products) {
  return (products ?? []).filter(({ source_label }) => source_label != null);
}

export function isDynamicalRow(product) {
  return product.source_label == null;
}

function completedLatency(measured) {
  return measured?.status === "complete" && Number.isFinite(measured.latency_s)
    ? measured.latency_s
    : null;
}

function initAt(product, initTime) {
  const at = Date.parse(initTime);
  return (product.recent_inits ?? []).find(
    (init) => Date.parse(init.init_time) === at,
  );
}

// The earliest source completion is the one to measure from — a mirror that
// lagged tells us nothing about when the data became available. Only whole
// runs are subtracted: two rows carrying the same number of lead groups is no
// evidence that they cut their horizons the same way, so there is no per-group
// lag to report.
export function lagAt(init, sources) {
  if (!init) return null;
  const mine = completedLatency(init);
  if (mine == null) return null;
  let earliest = null;
  for (const source of sources) {
    const theirs = completedLatency(initAt(source, init.init_time));
    if (theirs == null) continue;
    if (earliest == null || theirs < earliest) earliest = theirs;
  }
  return earliest == null ? null : mine - earliest;
}

export function lagSeries(product, sources) {
  return (product.recent_inits ?? [])
    .map((init) => lagAt(init, sources))
    .filter((lag) => lag != null);
}

// Nearest rank over the runs the payload carries: no baseline is published for
// a lag, so the columns summarise the sample on screen. Two runs is the least
// that reads as a distribution rather than a single number three times.
export function lagPercentile(lags, fraction) {
  if (lags.length < 2) return null;
  const sorted = [...lags].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil(fraction * sorted.length)) - 1];
}

export function detailRows(product, now, local, groupProducts = []) {
  const recent = product.recent_inits ?? [];
  const activeIndex = recent.findLastIndex(
    (init) => init.status === "pending" || init.status === "in_flight",
  );
  const active = activeIndex >= 0 ? recent[activeIndex] : null;
  const last = activeIndex >= 0 ? recent[activeIndex - 1] : recent.at(-1);
  const upcoming = active ? null : product.next_expected_init;
  const sources = isDynamicalRow(product) ? sourceRowsOf(groupProducts) : [];
  const lagged = sources.length > 0;
  // the lag is a property of the whole run, so every lead-group row of a
  // lagged product reports the same series
  const lags = lagged ? lagSeries(product, sources) : null;
  const lastLag = lagAt(last, sources);
  const runLag = lagAt(active, sources);
  return {
    lastHeader: labelledRun("last run", last?.init_time, local),
    runHeader: active
      ? labelledRun("current run", active.init_time, local)
      : labelledRun("upcoming run", upcoming, local),
    statsHeader: lagged
      ? lagStatsHeader(lags.length, timingBaselineNote(product))
      : statsHeader(
          product.latency_stats?.sample_init_count,
          timingBaselineNote(product),
        ),
    rows: (product.lead_group_stats ?? []).map((stats, index) => {
      return {
        label: stats.label,
        last: withLag(
          observedRunDetail(
            last,
            last?.lead_groups?.[index],
            stats,
            now,
            local,
            false,
          ),
          lagged,
          lastLag,
        ),
        run: withLag(
          active
            ? observedRunDetail(
                active,
                active.lead_groups?.[index],
                stats,
                now,
                local,
                true,
              )
            : upcomingRunDetail(upcoming, stats, local),
          lagged,
          runLag,
        ),
        p50: lags
          ? formatSignedLatency(lagPercentile(lags, 0.5))
          : formatLatency(stats.p50_s),
        p95: lags
          ? formatSignedLatency(lagPercentile(lags, 0.95))
          : formatLatency(stats.p95_s),
        p99: lags
          ? formatSignedLatency(lagPercentile(lags, 0.99))
          : formatLatency(stats.p99_s),
      };
    }),
  };
}

// On a lagged row the lag replaces the duration column outright — the
// wall-clock time beside it still says when the run finished, and a lag of
// null (no completed pair for that init) reads as "—".
function withLag(detail, lagged, lag) {
  return lagged ? { ...detail, duration: formatSignedLatency(lag) } : detail;
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

export function timingBaselineNote(product) {
  const baseline = product.timing_baseline;
  if (
    baseline?.status !== "insufficient_history" ||
    !Number.isInteger(baseline.history_days) ||
    !Number.isInteger(baseline.required_history_days)
  ) {
    return null;
  }
  const { history_days: days, required_history_days: required } = baseline;
  return `insufficient history (${days}/${required} days)`;
}

/* The details tables. Open details re-render once a second so their durations
   tick; the keyed diff keeps every node, so a table's own scroll box — and the
   reader's place in it — survives the tick. Every wide table on the site scrolls
   inside its own .table-container. */

function Details({ product, now, local, groupProducts }) {
  const details = detailRows(product, now, local, groupProducts);
  const leadTable = html`<div class="table-container">
    <table>
      <thead>
        <tr>
          <th rowspan="2">horizon</th>
          <th colspan="3">${details.lastHeader}</th>
          <th colspan="3">${details.runHeader}</th>
          <th colspan="3">${details.statsHeader}</th>
        </tr>
        <tr>
          <th>status</th>
          <th>time</th>
          <th>duration</th>
          <th>status</th>
          <th>time</th>
          <th>duration</th>
          <th>p50</th>
          <th>p95</th>
          <th>p99</th>
        </tr>
      </thead>
      <tbody>
        ${details.rows.map(
          (row) => html`<tr key=${row.label}>
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
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
  const facets = facetRows(product);
  if (facets.length === 0) return leadTable;

  return html`<div>
    ${leadTable}
    <div class="table-container">
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
            (facet) => html`<tr key=${`${facet.dimension}/${facet.label}`}>
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
    </div>
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
  groupProducts,
  advisory,
  local,
  now,
  viewIndex,
  expanded,
  resizeTick,
  onCycle,
  onToggle,
}) {
  // the run count comes from the measured row body: a 1fr grid column, so its
  // width does not depend on the field it holds. Measured after mount and
  // again after every resize, and the field waits for the measurement.
  const body = useRef(null);
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    setWidth(body.current?.getBoundingClientRect().width ?? 0);
  }, [resizeTick]);

  // the lead grid is the view a row opens on; the facet grids are a click away
  const views = viewsOf(product);
  const index = wrapIndex(viewIndex, views.length);
  const view = views[index];
  const field = useMemo(() => {
    if (width == null) return null;
    return view.dimension
      ? html`<${FacetRowsField}
          product=${product}
          local=${local}
          runCount=${runsThatFitFacetRows(product, width, view.dimension)}
          dimension=${view.dimension}
        />`
      : html`<${LeadField}
          product=${product}
          local=${local}
          runCount=${runsThatFit(product, width, local)}
        />`;
  }, [product, local, width, index]);

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
      <strong>${product.row_label}</strong>
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
            groupProducts=${groupProducts}
          />`
        : null}
    </div>
  </section>`;
}

function Advisories({ advisories }) {
  if (advisories.length === 0) return null;
  return html`<div class="pipeline-advisories">
    <strong>${`${advisories.length} active upstream dissemination advisor${advisories.length === 1 ? "y" : "ies"}`}</strong>
    ${advisories.map((advisory, index) => {
      const description = `${advisory.agency.toUpperCase()} — ${advisory.title}`;
      return html`<p key=${advisory.incident_id ?? index}>
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
  const signature = dashboard
    ? dashboard.groups
        .flatMap((group) => [group.id, ...group.products.map(({ id }) => id)])
        .join("\n")
    : null;
  // the toc script reads the headings after they exist, and again whenever
  // the set of groups changes
  useEffect(() => {
    if (signature === null) return;
    document.dispatchEvent(new Event("md-toc:refresh"));
  }, [signature]);

  if (!dashboard) {
    return html`<p data-slot="loading">Loading pipeline status…</p>`;
  }
  const siblings = groupProductsById(dashboard);
  const advisories = dashboard.advisories ?? [];
  return dashboard.groups.map(
    (group) => html`<section key=${group.id} class="pipeline-group">
      <h3 id=${`pipeline-group-${group.id}`}>${group.label}</h3>
      ${group.products.map(
        (product) => html`<${Row}
          key=${product.id}
          product=${product}
          groupProducts=${siblings.get(product.id)}
          advisory=${advisories.findLast((advisory) =>
            advisory.product_ids?.includes(product.id),
          )}
          local=${state.local}
          now=${state.now}
          viewIndex=${state.views[product.id] ?? 0}
          expanded=${state.expanded[product.id] ?? false}
          resizeTick=${state.resizeTick}
          onCycle=${() => actions.cycleView(product)}
          onToggle=${() => actions.toggleDetails(product.id)}
        />`,
      )}
    </section>`,
  );
}

/* The page's one state object. The poll writes the dashboard and any error,
   the countdown writes only `now`, user actions write the view and expanded
   maps, and a resize bumps a tick that makes every row re-measure. Every
   change repaints from the whole state; Preact's keyed diff decides what the
   DOM needs. */

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
    if (dashboard) {
      renderHealth(app, "agency-health", agencyHealth(dashboard.advisories));
    }
    if (state.systemHealth) {
      renderHealth(app, "system-health", state.systemHealth);
    }
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
      resizeTick: 0,
    },
    paint,
  );

  /* Clicking a product's field cycles its rows: lead time, then one grid per
     facet dimension. The view index lives in the state, keyed by product. */

  const actions = {
    cycleView(product) {
      if (viewsOf(product).length < 2) return;
      store.update((state) => ({
        views: { ...state.views, [product.id]: (state.views[product.id] ?? 0) + 1 },
        now: Date.now(),
      }));
    },
    toggleDetails(productId) {
      store.update((state) => ({
        expanded: { ...state.expanded, [productId]: !state.expanded[productId] },
      }));
    },
  };

  // the run count comes from the measured row, so a resize has to re-fit
  let refitTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      store.update((state) => ({
        resizeTick: state.resizeTick + 1,
        now: Date.now(),
      }));
    }, 150);
  });

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
    try {
      const dashboard = validateDashboard(
        await fetchJson(dashboardUrl, "no-cache"),
      );
      store.update({ dashboard, error: null, now: Date.now() });
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
