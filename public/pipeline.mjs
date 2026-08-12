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
const DASHBOARD_VERSIONS = new Set([1, 2]);
// Field geometry. JS owns these because the run count is computed from them;
// the CSS reads them back off the field as custom properties.
const SQUARE_PX = 8;
const CLUMP_GAP_PX = 1; // between facet squares within one run
const RUN_GAP_PX = 2; // between runs of a single square
const CLUMPED_RUN_GAP_PX = 6; // between runs of a clump, which needs daylight
const CH_PX = 6; // one monospace character at the band-label size
const GUTTER_MAX_CH = 24; // long facet labels get room, but not unbounded
const FACET_SQUARE_PX = 12; // wide enough for a lead label over each column
const FACET_GAP_PX = 2; // and enough air that the labels do not touch
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
    !DASHBOARD_VERSIONS.has(data.v) ||
    !hasTimestamp(data.generated_at) ||
    !Array.isArray(data.groups) ||
    data.groups.length === 0 ||
    !Array.isArray(data.advisories)
  ) {
    throw new TypeError("Invalid pipeline dashboard");
  }
  let hasFacetGroups = false;
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
          data.v !== 2 ||
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
        hasFacetGroups = true;
      }
      for (const init of product.recent_inits) {
        if (init.facets != null && (data.v !== 2 || !validFacets(init.facets))) {
          throw new TypeError("Invalid pipeline facet");
        }
        // the lead × facet joint: the same facet shape, reported per lead group
        for (const group of init.lead_groups ?? []) {
          if (group.facets == null) continue;
          if (data.v !== 2 || !validFacets(group.facets)) {
            throw new TypeError("Invalid pipeline facet");
          }
        }
      }
    }
  }
  if (data.v === 2 && !hasFacetGroups) {
    throw new TypeError("Invalid pipeline dashboard");
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

/* True once a payload reports facets per lead group. An empty array is a
   validated, supported input — a run that reported nothing yet — so it does not
   count as a joint. Until a real one arrives the two published marginals are all
   there is, and facets get their own bands. */

export function hasJointFacets(product) {
  return (product.recent_inits ?? []).some((init) =>
    (init.lead_groups ?? []).some((group) => group.facets?.length),
  );
}

/* The lead groups a product measures, shortest horizon first — the order the
   payload declares them in. History snapshots declare neither list up front,
   so both fall back to the newest run's own. */

export function leadAxis(product) {
  const newest = product.recent_inits?.at(-1);
  const labelOf = new Map(
    (product.lead_group_stats ?? []).map((stats) => [stats.name, stats.label]),
  );
  const declared = product.lead_groups?.length
    ? product.lead_groups
    : (newest?.lead_groups ?? []);
  return declared.map((group) => ({
    kind: "lead",
    key: group.name,
    label: group.label ?? labelOf.get(group.name) ?? group.name,
  }));
}

/* The bands of the marginal field, top row first: longest horizon down to the
   floor, then a band per facet grouped by dimension. Bands come from the product
   rather than one run, so the field keeps its shape as runs scroll through it. */

export function bandsOf(product) {
  const newest = product.recent_inits?.at(-1);
  // the banded field stacks bottom-up, so the longest horizon is the top row
  const leads = [...leadAxis(product)].reverse();

  const declaredFacets = product.facet_groups?.length
    ? product.facet_groups
    : (newest?.facets ?? []);
  const facets = declaredFacets.map((facet) => ({
    kind: "facet",
    key: facet.name,
    label: facet.label,
    dimension: facet.dimension,
  }));
  // with the joint, facets sit inside their lead band and a band of their own
  // would only repeat the run total
  return usesFacetRows(product) ? leads : [...leads, ...facets];
}

/* The facets of one lead group in one run, in the product's declared order.
   Empty when the payload reports no joint for that group. */

export function facetsAt(product, init, leadName) {
  const group = (init?.lead_groups ?? []).find(
    (entry) => entry.name === leadName,
  );
  if (!Array.isArray(group?.facets)) return [];
  const order = (product.facet_groups ?? []).map((facet) => facet.name);
  const measured = new Map(group.facets.map((facet) => [facet.name, facet]));
  const ordered = order.length ? order : group.facets.map((f) => f.name);
  // a facet absent at this lead simply has no square
  return ordered
    .map((name) => measured.get(name))
    .filter(Boolean);
}

/* The label gutter is only as wide as the labels beside it. Lead-only rows read
   "3d"; a facet row reads "precipitation and snow". Sizing it per product is
   what keeps the strip from starting a third of the way in. Stated in px, not
   ch: CSS resolves ch against the band's inherited font, which is not the
   font these labels are set in. */

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

export function runsThatFit(product, availablePx) {
  return runsFitting(
    availablePx,
    gutterPx(bandsOf(product)),
    SQUARE_PX,
    RUN_GAP_PX,
  );
}

/* Every band is the same skeleton: a gutter label, then its row of cells. */

function bandNode({
  className = "pipeline-band",
  kind,
  label = "",
  labelTitle,
  clumped = false,
  children,
}) {
  return element("div", { class: className, "data-kind": kind }, [
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
  const volume =
    cell.expected != null
      ? `${cell.available.toLocaleString("en-US")} / ${cell.expected.toLocaleString("en-US")} files`
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

function renderCell(band, init, local, measured) {
  const cell = measured ?? cellOf(band, init);
  return element(
    "div",
    {
      class: `pipeline-cell g-${cell.state}`,
      "data-init-time": init?.init_time,
      "data-timing": cell.timing,
      title: cellTitle(band, init, cell, local),
    },
    element("div", {
      class: "pipeline-cell-fill",
      style: `--fill:${Math.max(0, Math.min(100, (cell.completion ?? 0) * 100))}%`,
    }),
  );
}

/* The facet-row field spends width on lead-group columns inside every run, so
   it needs its own fit. */

export function facetRowsOf(product) {
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
  return [...declared, ...undeclared];
}

/* The layout only transposes when there are rows to draw. Without this a joint
   that reports nothing would hide the lead measurements it replaced. */

export function usesFacetRows(product) {
  return hasJointFacets(product) && facetRowsOf(product).length > 0;
}

export function runsThatFitFacetRows(product, availablePx) {
  // a run is still the group: one square per lead group inside it
  const leads = Math.max(1, leadAxis(product).length);
  return runsFitting(
    availablePx,
    gutterPx(facetRowsOf(product)),
    leads * FACET_SQUARE_PX + (leads - 1) * FACET_GAP_PX,
    CLUMPED_RUN_GAP_PX,
  );
}

/* The joint, indexed once per render: which facets a run reported under a lead
   group, and that group's timing. Built from `facetsAt` so the declared order
   still decides, then read by name per square. */

function jointIndex(product, runs, leads) {
  const index = new Map();
  for (const init of runs) {
    const byLead = new Map();
    for (const lead of leads) {
      const facets = facetsAt(product, init, lead.key);
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

function labelTier({ bandClass = "pipeline-band", spanClass, runs, textOf }) {
  return bandNode({
    className: bandClass,
    clumped: true,
    children: runs.map((init) =>
      element("span", { class: spanClass }, textOf(init)),
    ),
  });
}

/* The facet-row field: one row per facet, one block per run, one column per
   lead group inside a block. Same squares and same hover labels as the banded
   field — only which dimension owns which axis changes. */

function renderFacetRows(product, local, runCount) {
  const runs = product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
  const leads = leadAxis(product); // shortest horizon first
  const facets = facetRowsOf(product);
  const joint = jointIndex(product, runs, leads);
  const runWidth =
    leads.length * FACET_SQUARE_PX + (leads.length - 1) * FACET_GAP_PX;
  const field = element("div", {
    class: "pipeline-field",
    style: `--sq:${FACET_SQUARE_PX}px;--clump-gap:${FACET_GAP_PX}px;--clumped-run-gap:${CLUMPED_RUN_GAP_PX}px;--band-gutter:${gutterPx(facets)}px;--run-width:${runWidth}px`,
  });

  // the lead order repeats in every run, so name it once over the first block
  field.append(
    bandNode({
      className: "pipeline-band pipeline-band--head",
      clumped: true,
      children: runs.map((init, index) =>
        element(
          "div",
          { class: "pipeline-clump" },
          leads.map((lead) =>
            element(
              "span",
              index === 0
                ? { class: "pipeline-column-label", title: `lead ${lead.label}` }
                : { class: "pipeline-column-label" },
              index === 0 ? lead.label : "",
            ),
          ),
        ),
      ),
    }),
  );

  for (const facet of facets) {
    field.append(
      bandNode({
        kind: "facet",
        label: facet.label,
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
              );
            }),
          ),
        ),
      }),
    );
  }

  // the init time under every block, then the date only where it turns over, so
  // a date lines up with the first timestamp it covers
  const zone = selectedTimeZone(local);
  field.append(
    labelTier({
      bandClass: "pipeline-band pipeline-band--foot",
      spanClass: "pipeline-run-label",
      runs,
      textOf: (init) => initParts(init.init_time, zone).time,
    }),
  );
  let previousDate = null;
  field.append(
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
  );
  return field;
}

function renderField(product, local, runCount) {
  const runs = product.recent_inits.slice(-Math.max(1, runCount || RUNS_MAX));
  const field = element("div", {
    class: "pipeline-field",
    style: `--sq:${SQUARE_PX}px;--run-gap:${RUN_GAP_PX}px;--band-gutter:${gutterPx(bandsOf(product))}px`,
  });
  let dimension = null;

  for (const band of bandsOf(product)) {
    // name each facet dimension once, where it starts
    if (band.kind === "facet" && band.dimension !== dimension) {
      field.append(
        element("div", { class: "pipeline-dimension" }, band.dimension),
      );
    }
    dimension = band.kind === "facet" ? band.dimension : null;

    field.append(
      bandNode({
        kind: band.kind,
        label: band.label,
        labelTitle: band.label,
        children: runs.map((init) => renderCell(band, init, local)),
      }),
    );
  }

  const first = runs[0];
  const last = runs.at(-1);
  if (first && last) {
    field.append(
      element("div", { class: "pipeline-axis" }, [
        element("span"),
        element(
          "span",
          null,
          `${initShort(first.init_time, local)} → ${initShort(last.init_time, local)}`,
        ),
      ]),
    );
  }
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
            element("div", { "data-slot": "field" }),
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
    element("th", { colspan: "3" }, "time after init"),
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
          ` ${Math.round(facet.completion * 100)}%`,
        ]),
      ]),
    );
  }
  const facetTable = element("table", { class: "pipeline-facets" }, [
    element("thead", null, [
      element("tr", null, [
        element("th", { colspan: "5" }, "arrival coverage"),
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
  // with the joint, facets get their own labelled rows; without it, the two
  // published marginals get their own bands
  const nested = usesFacetRows(product);
  const runCount = nested
    ? runsThatFitFacetRows(product, available)
    : runsThatFit(product, available);
  row
    .querySelector('[data-slot="field"]')
    .replaceChildren(
      (nested ? renderFacetRows : renderField)(product, local, runCount),
    );
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
