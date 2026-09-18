import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  agencySummary,
  bandsOf,
  cellOf,
  cellTitle,
  compactLeadExtents,
  facetAxisLabel,
  facetRowsOf,
  leadAxis,
  leadExtents,
  viewAt,
  viewsOf,
  facetsAt,
  gutterPx,
  alignedChartScales,
  pinnedKeyItems,
  pinnedLayout,
  pinnedText,
  runChartKey,
  runChartScales,
  runChartSeries,
  runColumns,
  displayedRuns,
  runChartThreshold,
  runsThatFit,
  runsThatFitFacetRows,
  clockTime,
  detailRows,
  displayRowLabel,
  displaySource,
  isDynamicalRow,
  lagSourceLabels,
  etaLineText,
  facetRows,
  initColumnPx,
  initParts,
  selectedTimeZone,
  timingBaselineNote,
  validateDashboard,
} from "../public/pipeline.mjs";
import { onRequestGet } from "../functions/pipeline-staging/[[path]].js";
import {
  agencyHealth,
  systemHealth,
} from "../public/status-health.mjs";
import { localZoneLabel } from "../public/status-time.mjs";

function dashboard() {
  return {
    v: 2,
    generated_at: "2026-07-25T18:00:00Z",
    window_days: 90,
    advisories: [],
    groups: [
      {
        id: "noaa-gfs",
        label: "NOAA GFS forecast",
        products: [
          {
            id: "external-noaa-gfs-aws",
            row_label: "AWS",
            recent_inits: [],
          },
        ],
      },
    ],
  };
}

test("accepts the granular v2 dashboard contract", () => {
  assert.equal(validateDashboard(dashboard()).groups[0].id, "noaa-gfs");
});

test("accepts the HRRR virtual-family v3 dashboard contract", () => {
  const familyDashboard = dashboard();
  familyDashboard.v = 3;
  assert.equal(validateDashboard(familyDashboard).groups[0].id, "noaa-gfs");
});

test("labels dynamical.org virtual datasets without the implementation detail", () => {
  assert.equal(displayRowLabel("dynamical.org · virtual"), "dynamical.org");
  assert.equal(displayRowLabel("AWS"), "AWS");
});

test("rejects the lead-only schema it replaced", () => {
  // wxopticon#158 cut the representative/lead-only writer over; this frontend
  // consumes the granular schema only, so old JSON must fail loudly rather
  // than render as though it were complete
  const legacy = dashboard();
  legacy.v = 1;
  assert.throws(() => validateDashboard(legacy), /invalid pipeline dashboard/i);
});

test("accepts a product's facets", () => {
  const current = dashboard();
  const [product] = current.groups[0].products;
  product.facet_groups = [
    { dimension: "component", name: "component:pgrb2a", label: "pgrb2a" },
  ];
  product.recent_inits = [
    {
      init_time: "2026-07-25T12:00:00Z",
      status: "in_flight",
      facets: [
        {
          dimension: "component",
          name: "component:pgrb2a",
          label: "pgrb2a",
          dependencies_available: 9,
          dependencies_expected: 10,
          completion_pct: 0.9,
          status: "in_flight",
        },
      ],
    },
  ];

  assert.equal(validateDashboard(current), current);
});

test("rejects empty, unknown, and oversized dashboards", () => {
  assert.throws(() => validateDashboard({}), /invalid pipeline dashboard/i);
  assert.throws(
    () => validateDashboard({ ...dashboard(), v: 4 }),
    /invalid pipeline dashboard/i,
  );
  assert.throws(
    () => validateDashboard({ ...dashboard(), groups: [] }),
    /invalid pipeline dashboard/i,
  );
  const tooMany = dashboard();
  tooMany.groups[0].products[0].recent_inits = Array.from(
    { length: 11 },
    (_, index) => ({ init_time: String(index) }),
  );
  assert.throws(() => validateDashboard(tooMany), /invalid pipeline product/i);

  const malformedFacet = dashboard();
  malformedFacet.groups[0].products[0].facet_groups = [
    { dimension: "component", name: "component:pgrb2a", label: "pgrb2a" },
  ];
  malformedFacet.groups[0].products[0].recent_inits = [
    { facets: [{ completion_pct: 2 }] },
  ];
  assert.throws(
    () => validateDashboard(malformedFacet),
    /invalid pipeline facet/i,
  );
});


// the details rows are keyed on these names, so a payload that omits or
// repeats one cannot be rendered with stable rows
test("rejects lead group stats without a unique name", () => {
  const unnamed = dashboard();
  unnamed.groups[0].products[0].lead_group_stats = [
    { label: "0h", p50_s: 1, p95_s: 2, p99_s: 3 },
  ];
  assert.throws(
    () => validateDashboard(unnamed),
    /invalid pipeline lead group stats/i,
  );
  const repeated = dashboard();
  repeated.groups[0].products[0].lead_group_stats = [
    { name: "f000", label: "0h", p50_s: 1, p95_s: 2, p99_s: 3 },
    { name: "f000", label: "1d", p50_s: 1, p95_s: 2, p99_s: 3 },
  ];
  assert.throws(
    () => validateDashboard(repeated),
    /invalid pipeline lead group stats/i,
  );
});

test("summarizes upstream agency advisories without changing pipeline state", () => {
  assert.deepEqual(agencySummary([]), {
    state: "nominal",
    label: "nominal",
  });
  assert.deepEqual(
    agencySummary([
      { agency: "noaa" },
      { agency: "noaa" },
      { agency: "ecmwf" },
    ]),
    {
      state: "advisory",
      label: "NOAA, ECMWF advisories",
    },
  );
});

test("summarizes shared system and agency health", () => {
  assert.deepEqual(
    systemHealth({
      endpoints: [
        { status: "operational" },
        { status: "operational" },
      ],
    }),
    { state: "operational", label: "all systems", value: "operational" },
  );
  assert.deepEqual(
    systemHealth({
      endpoints: [{ status: "operational" }, { status: "down" }],
    }),
    { state: "down", label: "systems", value: "disrupted" },
  );
  assert.deepEqual(
    systemHealth({
      endpoints: [
        {
          status: "down",
          maintenance: { kind: "planned" },
        },
      ],
    }),
    {
      state: "advisory",
      label: "systems",
      value: "planned outage",
    },
  );
  assert.deepEqual(systemHealth({ endpoints: [{ status: "new-state" }] }), {
    state: "degraded",
    label: "some systems",
    value: "degraded",
  });
  assert.deepEqual(agencyHealth([]), {
    state: "nominal",
    label: "upstream forecast sources",
    value: "nominal",
  });
  assert.deepEqual(agencyHealth([{ agency: "noaa" }]), {
    state: "advisory",
    label: "upstream forecast sources",
    value: "NOAA advisory",
  });
});

test("formats init labels in UTC and the selected local timezone", () => {
  const timestamp = "2026-07-26T00:00:00Z";
  assert.deepEqual(initParts(timestamp), { date: "07-26", time: "00z" });
  assert.deepEqual(initParts(timestamp, "America/Chicago"), {
    date: "07-25",
    time: "19 CDT",
  });
});

test("falls back to UTC when the browser reports a non-IANA local timezone", () => {
  // Some browsers resolve to non-standard zones (e.g. "Etc/Unknown") that
  // Intl.DateTimeFormat itself rejects with a RangeError when passed explicitly.
  const RealDateTimeFormat = Intl.DateTimeFormat;
  function FakeDateTimeFormat(locale, options) {
    if (options?.timeZone === "Etc/Unknown") {
      throw new RangeError("Invalid time zone specified: Etc/Unknown");
    }
    const real = new RealDateTimeFormat(locale, options);
    if (!options) {
      const resolved = real.resolvedOptions();
      real.resolvedOptions = () => ({ ...resolved, timeZone: "Etc/Unknown" });
    }
    return real;
  }
  Intl.DateTimeFormat = FakeDateTimeFormat;
  try {
    assert.equal(selectedTimeZone(true), "UTC");
  } finally {
    Intl.DateTimeFormat = RealDateTimeFormat;
  }
});

test("shortens displayed web sources without changing other schemes", () => {
  assert.equal(displaySource("https://nomads.ncep.noaa.gov"), "nomads.ncep.noaa.gov");
  assert.equal(displaySource("http://example.com/data"), "example.com/data");
  assert.equal(displaySource("s3://noaa-gfs-bdp-pds"), "s3://noaa-gfs-bdp-pds");
});

function facetedProduct() {
  return {
    id: "external-noaa-gefs-long-aws",
    row_label: "AWS",
    lead_groups: [
      { name: "f000", label: "1d" },
      { name: "f240", label: "10d" },
    ],
    facet_groups: [
      { dimension: "component", name: "component:pgrb2a", label: "pgrb2a.0p50" },
      { dimension: "member", name: "members:control", label: "control" },
    ],
    recent_inits: [
      {
        init_time: "2026-07-26T00:00:00Z",
        status: "in_flight",
        timing: "delayed",
        lead_groups: [
          {
            name: "f000",
            status: "complete",
            timing: "on_time",
            completion_pct: 1,
            leads_available: 100,
            leads_expected: 100,
          },
          {
            name: "f240",
            status: "in_flight",
            timing: "delayed",
            completion_pct: 0.25,
            leads_available: 175,
            leads_expected: 400,
          },
        ],
        facets: [
          {
            dimension: "component",
            name: "component:pgrb2a",
            label: "pgrb2a.0p50",
            status: "in_flight",
            completion_pct: 0.5,
            dependencies_available: 200,
            dependencies_expected: 400,
          },
          {
            dimension: "member",
            name: "members:control",
            label: "control",
            status: "complete",
            completion_pct: 1,
            dependencies_available: 400,
            dependencies_expected: 400,
          },
        ],
      },
    ],
  };
}

test("bands the lead grid from the floor up, and only by lead group", () => {
  // facets have their own views now, so the lead grid stays lead-only whether
  // or not a product reports them
  assert.deepEqual(
    bandsOf(facetedProduct()).map((band) => `${band.kind}:${band.label}`),
    ["lead:10d", "lead:1d"],
  );

  const noFacets = facetedProduct();
  delete noFacets.facet_groups;
  for (const init of noFacets.recent_inits) delete init.facets;
  assert.deepEqual(
    bandsOf(noFacets).map((band) => `${band.kind}:${band.label}`),
    ["lead:10d", "lead:1d"],
  );
});

function jointProduct() {
  const product = facetedProduct();
  const [init] = product.recent_inits;
  const [shortLead, longLead] = init.lead_groups;
  shortLead.facets = [
    {
      dimension: "component",
      name: "component:pgrb2a",
      label: "pgrb2a.0p50",
      status: "complete",
      completion_pct: 1,
      dependencies_available: 100,
      dependencies_expected: 100,
    },
    {
      dimension: "member",
      name: "members:control",
      label: "control",
      status: "complete",
      completion_pct: 1,
      dependencies_available: 100,
      dependencies_expected: 100,
    },
  ];
  longLead.facets = [
    // declared second in facet_groups, reported first here
    {
      dimension: "member",
      name: "members:control",
      label: "control",
      status: "in_flight",
      completion_pct: 0.5,
      dependencies_available: 150,
      dependencies_expected: 300,
    },
    {
      dimension: "component",
      name: "component:pgrb2a",
      label: "pgrb2a.0p50",
      status: "pending",
      completion_pct: 0,
      dependencies_available: 0,
      dependencies_expected: 300,
    },
  ];
  return product;
}

test("sizes the label gutter to the labels beside it", () => {
  // the lead grid's bands are lead-only, so only "10d" has to fit
  assert.equal(gutterPx(bandsOf(facetedProduct())), 18);
  assert.equal(gutterPx(bandsOf(jointProduct())), 18);
  // the facet views carry the long labels instead
  assert.equal(gutterPx(facetRowsOf(jointProduct())), 66);
});

test("orders the lead axis shortest horizon first, and the bands from the floor up", () => {
  assert.deepEqual(
    leadAxis(facetedProduct()).map((lead) => lead.label),
    ["1d", "10d"],
  );
  assert.deepEqual(
    bandsOf(facetedProduct())
      .filter((band) => band.kind === "lead")
      .map((band) => band.label),
    ["10d", "1d"],
  );
});

test("gives an init column room for its own label, in any zone", () => {
  const product = facetedProduct();
  // "08-12" is five characters, and a UTC time is three
  assert.equal(initColumnPx(product, "UTC"), 30);
  // a zone with a letter abbreviation is six: "19 CDT"
  assert.equal(initColumnPx(product, "America/Chicago"), 36);
  // en-US has no abbreviation for these, so it renders a GMT offset — the case a
  // local/UTC guess got wrong, at nearly twice the width
  assert.equal(initColumnPx(product, "Europe/Berlin"), 48);
  assert.equal(initColumnPx(product, "Asia/Kolkata"), 66);
});

test("fits the run count to the width the row actually has", () => {
  const flat = facetedProduct();

  // production middle column is 390px, less 18px of lead gutter; a UTC-labelled
  // column costs 30px plus a 6px gap. The local-zone widths are asserted
  // separately, with explicit zones — asserting them through `local: true` here
  // would only test whatever zone the test machine happens to be in.
  assert.equal(runsThatFit(flat, 390, false), 10);
  // squeeze it
  assert.equal(runsThatFit(flat, 200, false), 4);
  // never zero, however cramped, and never more than the payload carries
  assert.equal(runsThatFit(flat, 40, false), 1);
  assert.equal(runsThatFit(flat, 4000, false), 10);
  // an unmeasurable row shows everything rather than nothing
  assert.equal(runsThatFit(flat, 0, false), 10);
});

test("moves facets out of their own bands once the joint is published", () => {
  const flat = facetedProduct();
  assert.deepEqual(facetRowsOf(flat), []);

  const joint = jointProduct();
  assert.ok(facetRowsOf(joint).length > 0);
  // facets own their own rows now, so a band of their own would only repeat
  // the run total the details table already carries
  assert.deepEqual(
    bandsOf(joint).map((band) => `${band.kind}:${band.label}`),
    ["lead:10d", "lead:1d"],
  );
});

test("sizes a lead group by its share of the run, never below its label", () => {
  // counts arrive cumulative: f000 owns 100 of the run's 400, f240 the other
  // 300. Each group starts at the 12px a two-character label needs, then shares
  // an allowance the size of the axis again.
  const extents = leadExtents(facetedProduct());
  assert.equal(extents.get("f000"), 12 + 0.25 * 24);
  assert.equal(extents.get("f240"), 12 + 0.75 * 24);
  assert.ok(extents.get("f240") > extents.get("f000"));

  // even a group that is a rounding error keeps room to name itself
  const lopsided = facetedProduct();
  const [init] = lopsided.recent_inits;
  init.lead_groups[0].leads_expected = 1;
  init.lead_groups[0].leads_available = 1;
  init.lead_groups[1].leads_expected = 4000;
  init.lead_groups[1].leads_available = 1;
  const floored = leadExtents(lopsided);
  assert.ok(floored.get("f000") >= 12);
  assert.ok(floored.get("f240") > floored.get("f000") * 2);

  // a product that reports no counts splits the allowance evenly
  const uncounted = facetedProduct();
  for (const group of uncounted.recent_inits[0].lead_groups) {
    delete group.leads_expected;
    delete group.leads_available;
  }
  assert.deepEqual([...leadExtents(uncounted).values()], [24, 24]);
});

test("compacts lead columns when facets own the rows", () => {
  const product = facetedProduct();
  const regular = leadExtents(product);
  const compact = compactLeadExtents(product);

  assert.ok(compact.get("f000") < regular.get("f000"));
  assert.ok(compact.get("f000") >= 12);
  assert.ok(compact.get("f240") < regular.get("f240"));
  assert.ok(compact.get("f240") > compact.get("f000"));
});

test("offers one view per facet dimension, opening on the lead grid", () => {
  // nothing to cycle without a joint: the lead grid is the only view
  assert.deepEqual(
    viewsOf(facetedProduct()).map((view) => view.rows),
    ["lead time"],
  );

  const joint = jointProduct();
  assert.deepEqual(
    viewsOf(joint).map((view) => view.rows),
    ["lead time", "component", "member"],
  );
  // clicking wraps back to the lead grid, in both directions
  assert.equal(viewAt(joint, 0).dimension, null);
  assert.equal(viewAt(joint, 1).dimension, "component");
  assert.equal(viewAt(joint, 2).dimension, "member");
  assert.equal(viewAt(joint, 3).dimension, null);
  assert.equal(viewAt(joint, -1).dimension, "member");
});

test("a facet view shows only its own dimension's rows", () => {
  const joint = jointProduct();
  assert.deepEqual(
    facetRowsOf(joint, "component").map((facet) => facet.label),
    ["pgrb2a.0p50"],
  );
  assert.deepEqual(
    facetRowsOf(joint, "member").map((facet) => facet.label),
    ["control"],
  );
  // both gutters leave enough room for all ten compact run blocks
  assert.equal(runsThatFitFacetRows(joint, 390, "component"), 10);
  assert.equal(runsThatFitFacetRows(joint, 390, "member"), 10);
});

test("abbreviates long facet axis labels without changing their data labels", () => {
  const abbreviations = new Map([
    ["cloud and convection", "cloud/conv"],
    ["natural levels", "nat lvls"],
    ["pgrb2a.0p50", "pgrb2a"],
    ["precipitation and snow", "precip/snow"],
    ["pressure levels", "prs lvls"],
    ["solar radiation", "solar"],
    ["surface state", "sfc state"],
    ["control", "ctl"],
    ["perturbed members", "pert"],
  ]);
  for (const [label, abbreviation] of abbreviations) {
    assert.equal(facetAxisLabel({ label }), abbreviation);
  }
  assert.equal(facetAxisLabel({ label: "wind" }), "wind");
});

test("gives every facet in the joint its own labelled row", () => {
  const joint = jointProduct();
  assert.deepEqual(
    facetRowsOf(joint).map((facet) => facet.label),
    ["pgrb2a.0p50", "control"],
  );

  // a facet the joint never reports gets no row
  const partial = jointProduct();
  for (const group of partial.recent_inits[0].lead_groups) {
    group.facets = group.facets.filter((facet) => facet.dimension === "component");
  }
  assert.deepEqual(
    facetRowsOf(partial).map((facet) => facet.label),
    ["pgrb2a.0p50"],
  );
});

test("keeps the lead grid usable when a joint reports nothing", () => {
  // the validator accepts an empty facets array, so this is supported input
  const empty = jointProduct();
  for (const group of empty.recent_inits[0].lead_groups) group.facets = [];
  assert.deepEqual(facetRowsOf(empty), []);
  // no facet views to cycle to, and the lead measurements still render
  assert.deepEqual(
    viewsOf(empty).map((view) => view.rows),
    ["lead time"],
  );
  assert.deepEqual(
    bandsOf(empty).map((band) => `${band.kind}:${band.label}`),
    ["lead:10d", "lead:1d"],
  );

  // a rollback drops the key entirely
  const rolledBack = jointProduct();
  for (const group of rolledBack.recent_inits[0].lead_groups) delete group.facets;
  assert.deepEqual(
    viewsOf(rolledBack).map((view) => view.rows),
    ["lead time"],
  );
  assert.equal(bandsOf(rolledBack).length, 2);
});

test("draws a facet row for anything the joint reported in the window", () => {
  // a rollout leaves the window mixed: the newest run has not reported yet
  const mixed = jointProduct();
  const older = mixed.recent_inits[0];
  const newest = JSON.parse(JSON.stringify(older));
  newest.init_time = "2026-07-26T06:00:00Z";
  for (const group of newest.lead_groups) group.facets = [];
  mixed.recent_inits = [older, newest];

  assert.ok(facetRowsOf(mixed).length > 0);
  // rows come from the whole window, not just the newest run
  assert.deepEqual(
    facetRowsOf(mixed).map((facet) => facet.label),
    ["pgrb2a.0p50", "control"],
  );
  // and the newest run's own cells read as unobserved rather than vanishing
  assert.deepEqual(facetsAt(mixed, newest, "f240"), []);

  // a facet the schema never declared still earns a row, since it was measured
  const undeclared = jointProduct();
  undeclared.facet_groups = undeclared.facet_groups.filter(
    (facet) => facet.dimension === "component",
  );
  assert.deepEqual(
    facetRowsOf(undeclared).map((facet) => facet.label),
    ["pgrb2a.0p50", "control"],
  );
});

test("fits run blocks of lead columns to the width, once facets own the rows", () => {
  const joint = jointProduct();
  // each lane keeps the text floor; two lanes double the fitted run count
  assert.equal(runsThatFitFacetRows(joint, 390), 10);
  assert.equal(runsThatFitFacetRows(joint, 240), 8);
  assert.equal(runsThatFitFacetRows(joint, 200), 6);
  assert.equal(runsThatFitFacetRows(joint, 1200), 10);
  // never zero, and an unmeasured row shows everything rather than nothing
  assert.equal(runsThatFitFacetRows(joint, 80), 2);
  assert.equal(runsThatFitFacetRows(joint, 0), 10);
});

test("orders a lead group's facets as the product declares them", () => {
  const joint = jointProduct();
  const init = joint.recent_inits[0];
  assert.deepEqual(
    facetsAt(joint, init, "f240").map((facet) => facet.label),
    ["pgrb2a.0p50", "control"],
  );
  assert.deepEqual(
    facetsAt(joint, init, "f000").map((facet) => facet.label),
    ["pgrb2a.0p50", "control"],
  );
  // a product without the joint has nothing to nest
  const flat = facetedProduct();
  assert.deepEqual(facetsAt(flat, flat.recent_inits[0], "f240"), []);
});

test("a nested square names its facet and the lead it arrived under", () => {
  const joint = jointProduct();
  const init = joint.recent_inits[0];
  const [facet] = facetsAt(joint, init, "f240");
  const band = {
    kind: "facet",
    key: facet.name,
    label: facet.label,
    dimension: facet.dimension,
    lead: "10d",
  };
  assert.equal(
    cellTitle(band, init, cellOf({ ...band, kind: "facet" }, init), false),
    "pgrb2a.0p50 (component) · lead 10d · 07-26 00z · 200 / 400 files · processing · delayed",
  );
});

test("rejects a malformed joint the same way as run-level facets", () => {
  const current = dashboard();
  current.v = 2;
  const [product] = current.groups[0].products;
  product.facet_groups = [
    { dimension: "component", name: "component:pgrb2a", label: "pgrb2a" },
  ];
  product.recent_inits = [
    {
      init_time: "2026-07-25T12:00:00Z",
      status: "in_flight",
      lead_groups: [
        {
          name: "f000",
          status: "in_flight",
          facets: [
            {
              dimension: "component",
              name: "component:pgrb2a",
              label: "pgrb2a",
              status: "in_flight",
              completion_pct: 0.5,
              dependencies_available: 5,
              dependencies_expected: 10,
            },
          ],
        },
      ],
    },
  ];
  assert.equal(validateDashboard(current), current);

  const broken = JSON.parse(JSON.stringify(current));
  broken.groups[0].products[0].recent_inits[0].lead_groups[0].facets[0].dependencies_available = 99;
  assert.throws(() => validateDashboard(broken), /invalid pipeline facet/i);

  // the schema itself is checked before its facets, so old JSON carrying a
  // joint is still rejected as the wrong schema
  const wrongVersion = JSON.parse(JSON.stringify(current));
  wrongVersion.v = 1;
  assert.throws(
    () => validateDashboard(wrongVersion),
    /invalid pipeline dashboard/i,
  );
});

test("measures a lead band by its own share, not the cumulative count", () => {
  const product = facetedProduct();
  const [longest] = bandsOf(product);
  const cell = cellOf(longest, product.recent_inits[0]);
  // 175/400 cumulative becomes 75/300 once the band below it is taken out
  assert.equal(cell.state, "in_flight");
  assert.equal(cell.timing, "delayed");
  assert.equal(cell.completion, 0.25);
});

test("preserves delayed timing on an empty pending lead band", () => {
  const product = facetedProduct();
  const init = product.recent_inits[0];
  init.status = "pending";
  init.timing = "delayed";
  init.completion_pct = 0;
  for (const group of init.lead_groups) {
    group.status = "pending";
    group.timing = "delayed";
    group.completion_pct = 0;
    group.leads_available = 0;
  }

  const cell = cellOf(bandsOf(product)[0], init);
  assert.equal(cell.state, "pending");
  assert.equal(cell.timing, "delayed");
  assert.equal(cell.completion, 0);
});

test("names what a square measured, facet first, in its hover label", () => {
  const product = facetedProduct();
  const init = product.recent_inits[0];
  const facetBand = {
    kind: "facet",
    key: "component:pgrb2a",
    label: "pgrb2a.0p50",
    dimension: "component",
  };
  assert.equal(
    cellTitle(facetBand, init, cellOf(facetBand, init), false),
    "pgrb2a.0p50 (component) · 07-26 00z · 200 / 400 files · processing · delayed",
  );

  const leadBand = bandsOf(product).find((band) => band.label === "1d");
  assert.equal(
    cellTitle(leadBand, init, cellOf(leadBand, init), false),
    "lead 1d · 07-26 00z · 100% · complete · on time",
  );

  // the unit agrees with the total: a band holding one file is not "1 files",
  // and an empty one is still "0 / 1 file"
  assert.match(
    cellTitle(facetBand, init, { ...cellOf(facetBand, init), available: 1, expected: 1 }, false),
    /1 \/ 1 file ·/,
  );
  assert.match(
    cellTitle(facetBand, init, { ...cellOf(facetBand, init), available: 0, expected: 1 }, false),
    /0 \/ 1 file ·/,
  );
});

test("reads an unreported band as unobserved rather than a failure", () => {
  const product = facetedProduct();
  const band = {
    kind: "facet",
    key: "component:pgrb2a",
    label: "pgrb2a.0p50",
    dimension: "component",
  };
  const blind = { ...product.recent_inits[0], status: "unobserved" };
  assert.equal(cellOf(band, blind).state, "unobserved");
  assert.match(
    cellTitle(band, blind, cellOf(band, blind), false),
    /no probe visibility; not a publication failure/,
  );

  const missing = { ...product.recent_inits[0], facets: [] };
  assert.equal(cellOf(band, missing).state, "unobserved");
});

test("shows exact and relative ETA in the selected timezone", () => {
  assert.equal(
    etaLineText(
      "2026-07-26T14:45:00Z",
      Date.parse("2026-07-26T13:00:00Z"),
      false,
    ),
    "ETA 14:45 (in 1h 45m)",
  );
  assert.equal(
    clockTime("2026-07-26T14:45:00Z", "America/Chicago"),
    "09:45",
  );
});

test("retains live horizon status, time, and duration in details", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T06:00:00Z",
        status: "complete",
        lead_groups: [
          { status: "complete", latency_s: 1200 },
          { status: "complete", latency_s: 2700 },
        ],
      },
      {
        init_time: "2026-07-26T12:00:00Z",
        status: "in_flight",
        lead_groups: [
          { status: "complete", latency_s: 1800 },
          { status: "in_flight" },
        ],
      },
    ],
    lead_group_stats: [
      { name: "f024", label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 },
      { name: "f072", label: "3d", p50_s: 2400, p95_s: 3600, p99_s: 4800 },
    ],
  };
  assert.deepEqual(
    detailRows(product, Date.parse("2026-07-26T12:30:00Z"), false),
    {
      lastHeader: "last run · 07-26 06z",
      runHeader: "current run · 07-26 12z",
      statsHeader: "time after init",
      rows: [
        {
          name: "f024",
          label: "1d",
          last: {
            status: "complete",
            state: "complete",
            timing: null,
            time: "06:20",
            duration: "20m",
          },
          run: {
            status: "complete",
            state: "complete",
            timing: null,
            time: "12:30",
            duration: "30m",
          },
          p50: "20m",
          p95: "30m",
          p99: "40m",
          threshold: "—",
        },
        {
          name: "f072",
          label: "3d",
          last: {
            status: "complete",
            state: "complete",
            timing: null,
            time: "06:45",
            duration: "45m",
          },
          run: {
            status: "processing",
            state: "in_flight",
            timing: null,
            time: "ETA 13:00",
            duration: "30m 0s",
          },
          p50: "40m",
          p95: "1h",
          p99: "1h 20m",
          threshold: "—",
        },
      ],
      lag: null,
    },
  );
});

test("treats a delayed pending init as the current run in details", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T12:00:00Z",
        status: "pending",
        timing: "delayed",
        lead_groups: [{ status: "pending", timing: "delayed" }],
      },
    ],
    lead_group_stats: [{ label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 }],
  };

  const details = detailRows(product, Date.parse("2026-07-26T12:45:00Z"), false);
  assert.equal(details.runHeader, "current run · 07-26 12z");
  assert.equal(details.rows[0].run.status, "pending");
  assert.equal(details.rows[0].run.duration, "45m 0s");
});

test("names the init sample the percentile columns summarise", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T06:00:00Z",
        status: "complete",
        lead_groups: [{ status: "complete", latency_s: 1200 }],
      },
    ],
    latency_stats: {
      p50_s: 1200,
      p95_s: 1800,
      p99_s: 2400,
      sample_init_count: 1394,
    },
    lead_group_stats: [{ label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 }],
  };

  assert.equal(
    detailRows(product, Date.parse("2026-07-26T07:00:00Z"), false).statsHeader,
    "time after init · 1,394 samples",
  );

  // a product monitored since its first init has a sample of exactly one
  product.latency_stats.sample_init_count = 1;
  assert.equal(
    detailRows(product, Date.parse("2026-07-26T07:00:00Z"), false).statsHeader,
    "time after init \u00b7 1 sample",
  );

  product.latency_stats.sample_init_count = 0;
  assert.equal(
    detailRows(product, Date.parse("2026-07-26T07:00:00Z"), false).statsHeader,
    "time after init",
  );
});

test("shows the last and upcoming runs while waiting for the next init", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T06:00:00Z",
        status: "complete",
        lead_groups: [
          { status: "complete", latency_s: 1200 },
          { status: "complete", latency_s: 2700 },
        ],
      },
    ],
    lead_group_stats: [
      { label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 },
      { label: "3d", p50_s: 2400, p95_s: 3600, p99_s: 4800 },
    ],
    next_expected_init: "2026-07-26T12:00:00Z",
  };

  const details = detailRows(
    product,
    Date.parse("2026-07-26T07:00:00Z"),
    false,
  );

  assert.equal(details.lastHeader, "last run · 07-26 06z");
  assert.equal(details.runHeader, "upcoming run · 07-26 12z");
  assert.deepEqual(
    details.rows.map(({ last, run }) => ({ last, run })),
    [
      {
        last: {
          status: "complete",
          state: "complete",
          timing: null,
          time: "06:20",
          duration: "20m",
        },
        run: {
          status: "upcoming",
          state: "upcoming",
          timing: null,
          time: "ETA 12:30",
          duration: "—",
        },
      },
      {
        last: {
          status: "complete",
          state: "complete",
          timing: null,
          time: "06:45",
          duration: "45m",
        },
        run: {
          status: "upcoming",
          state: "upcoming",
          timing: null,
          time: "ETA 13:00",
          duration: "—",
        },
      },
    ],
  );
});

test("groups component and member readiness for the displayed init", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T12:00:00Z",
        status: "in_flight",
        facets: [
          {
            dimension: "component",
            label: "pgrb2a",
            status: "in_flight",
            completion_pct: 0.75,
            dependencies_available: 3,
            dependencies_expected: 4,
          },
          {
            dimension: "member",
            label: "control",
            status: "complete",
            completion_pct: 1,
            dependencies_available: 4,
            dependencies_expected: 4,
          },
        ],
      },
    ],
  };

  assert.deepEqual(facetRows(product), [
    {
      name: undefined,
      dimension: "component",
      label: "pgrb2a",
      status: "processing",
      state: "in_flight",
      timing: null,
      completion: 0.75,
      count: "3 / 4 observed",
    },
    {
      name: undefined,
      dimension: "member",
      label: "control",
      status: "complete",
      state: "complete",
      timing: null,
      completion: 1,
      count: "4 / 4 observed",
    },
  ]);
});

// A facet reports no timing of its own, so its row inherits the run's — the
// grid's facet squares already do, and the two must not disagree about whether
// the same in-flight work is on time.
test("facet rows take the timing of the run they describe", () => {
  const product = {
    recent_inits: [
      {
        init_time: "2026-07-26T12:00:00Z",
        status: "in_flight",
        timing: "on_time",
        facets: [
          {
            dimension: "component",
            label: "pgrb2a",
            status: "in_flight",
            completion_pct: 0.5,
            dependencies_available: 2,
            dependencies_expected: 4,
          },
        ],
      },
    ],
  };

  assert.deepEqual(
    facetRows(product).map(({ status, timing }) => ({ status, timing })),
    [{ status: "processing", timing: "on_time" }],
  );
});

function readyPipelineLag(overrides = {}) {
  return {
    status: "ready",
    basis: "whole_run",
    source_ids: ["external-noaa-gfs-aws"],
    window_days: 365,
    window_start: "2025-07-25T18:00:00Z",
    window_end: "2026-07-25T18:00:00Z",
    generated_at: "2026-07-25T18:00:00Z",
    stats: {
      p50_s: 900,
      p95_s: 1800,
      p99_s: 2700,
      avg_s: 1200,
      sample_init_count: 1204,
      sample_day_count: 301,
    },
    ...overrides,
  };
}

function lagProduct(recentInits, pipelineLag = readyPipelineLag()) {
  return {
    source_label: null,
    row_label: "dynamical.org · virtual",
    recent_inits: recentInits,
    pipeline_lag: pipelineLag,
    lead_group_stats: [
      { name: "forecast", label: "fc", p50_s: 4100, p95_s: 5000, p99_s: 6100 },
    ],
    latency_stats: { p50_s: 4100, p95_s: 5000, p99_s: 6100, sample_init_count: 24 },
  };
}

test("identifies dynamical rows without deriving lag from their siblings", () => {
  assert.equal(isDynamicalRow({ source_label: null }), true);
  assert.equal(isDynamicalRow({ source_label: "AWS" }), false);
});

const HRRR_FAMILIES = ["nat", "prs", "sfc"];

function hrrrFacets(completedAt, overrides = {}) {
  return [...HRRR_FAMILIES, "subh"].map((family, index) => {
    const override = overrides[family] ?? {};
    const at = new Date(Date.parse(completedAt) + index * 60_000).toISOString();
    return {
      dimension: "component",
      name: `component:conus/${family}`,
      label: family,
      status: "complete",
      completion_pct: 1,
      dependencies_available: 1,
      dependencies_expected: 1,
      completed_at: at,
      ...override,
    };
  });
}

test("validates optional facet completion timestamps while accepting old payloads", () => {
  const old = dashboard();
  old.groups[0].products[0].recent_inits = [
    {
      init_time: "2026-07-25T12:00:00Z",
      facets: hrrrFacets("2026-07-25T12:30:00Z").map(
        ({ completed_at: _completedAt, ...facet }) => facet,
      ),
    },
  ];
  assert.equal(validateDashboard(old), old);

  const current = structuredClone(old);
  current.groups[0].products[0].recent_inits[0].facets = hrrrFacets(
    "2026-07-25T12:30:00Z",
  );
  current.groups[0].products[0].recent_inits[0].facets[0].completed_at =
    "2026-07-25T12:30:00+00:00";
  assert.equal(validateDashboard(current), current);

  for (const completedAt of ["not-a-timestamp", "2026-07-25T07:30:00-05:00"]) {
    const invalid = structuredClone(current);
    invalid.groups[0].products[0].recent_inits[0].facets[0].completed_at =
      completedAt;
    assert.throws(() => validateDashboard(invalid), /invalid pipeline facet/i);
  }
});

function lagInit(init_time, pipeline_lag_s, status = "complete") {
  const latency_s = status === "complete" ? 4000 : null;
  const init = {
    init_time,
    status,
    latency_s,
    lead_groups: [{ status, latency_s }],
  };
  if (pipeline_lag_s !== undefined) init.pipeline_lag_s = pipeline_lag_s;
  return init;
}

test("validates ready and pending published pipeline lag", () => {
  const current = dashboard();
  const [product] = current.groups[0].products;
  product.pipeline_lag = readyPipelineLag({
    stats: {
      p50_s: -60,
      p95_s: 0,
      p99_s: 30,
      avg_s: -10,
      sample_init_count: 2,
      sample_day_count: 1,
    },
  });
  product.recent_inits = [
    { init_time: "2026-07-25T06:00:00Z", pipeline_lag_s: 0 },
    { init_time: "2026-07-25T12:00:00Z", pipeline_lag_s: -30 },
  ];
  assert.equal(validateDashboard(current), current);

  product.pipeline_lag = {
    ...readyPipelineLag(),
    status: "pending",
    window_start: null,
    window_end: null,
    generated_at: null,
    stats: null,
  };
  assert.equal(validateDashboard(current), current);

  product.pipeline_lag = readyPipelineLag({
    stats: {
      p50_s: 0.828933,
      p95_s: 3600.828933,
      p99_s: 3600.8289329999993,
      avg_s: 1800.828933,
      sample_init_count: 12,
      sample_day_count: 3,
    },
  });
  assert.equal(validateDashboard(current), current);
  product.source_label = null;
  assert.equal(
    detailRows(product, Date.parse("2026-07-25T18:00:00Z"), false).lag.p95,
    "1h",
  );
});

test("malformed optional lag fields degrade only the affected lag", () => {
  const malformed = [
    null,
    readyPipelineLag({ status: "stale" }),
    readyPipelineLag({ basis: "recent_runs" }),
    readyPipelineLag({ source_ids: [] }),
    readyPipelineLag({ window_days: 0 }),
    readyPipelineLag({ window_start: "2025-07-25T13:00:00-05:00" }),
    readyPipelineLag({ stats: null }),
    readyPipelineLag({ stats: { sample_init_count: 0, sample_day_count: 0 } }),
    readyPipelineLag({
      stats: {
        p50_s: null,
        p95_s: null,
        p99_s: null,
        avg_s: null,
        sample_init_count: 1,
        sample_day_count: 1,
      },
    }),
    readyPipelineLag({
      stats: {
        p50_s: 3,
        p95_s: 2,
        p99_s: 1,
        avg_s: 2,
        sample_init_count: 3,
        sample_day_count: 3,
      },
    }),
    { ...readyPipelineLag(), status: "pending", stats: null },
  ];
  for (const pipelineLag of malformed) {
    const invalid = dashboard();
    const [affected] = invalid.groups[0].products;
    affected.source_label = null;
    affected.pipeline_lag = pipelineLag;
    const sibling = {
      ...lagProduct([lagInit("2026-07-25T12:00:00Z", 60)]),
      id: "noaa-gfs-forecast-virtual",
    };
    invalid.groups[0].products.push(sibling);

    assert.equal(validateDashboard(invalid), invalid);
    assert.equal(
      detailRows(affected, Date.parse("2026-07-25T18:00:00Z"), false).lag.note,
      "unavailable (no published baseline)",
    );
    assert.equal(
      detailRows(sibling, Date.parse("2026-07-25T18:00:00Z"), false).lag.p50,
      "15m",
    );
  }

  const invalidInit = dashboard();
  const [affectedInit] = invalidInit.groups[0].products;
  affectedInit.source_label = null;
  affectedInit.pipeline_lag = readyPipelineLag();
  affectedInit.recent_inits = [
    { init_time: "2026-07-25T12:00:00Z", pipeline_lag_s: null },
  ];
  assert.equal(validateDashboard(invalidInit), invalidInit);
  const details = detailRows(
    affectedInit,
    Date.parse("2026-07-25T18:00:00Z"),
    false,
  ).lag;
  assert.equal(details.last, "—");
  assert.equal(details.p50, "15m");
});

test("details use historical lag statistics instead of recent values", () => {
  const product = lagProduct([
    lagInit("2026-07-25T00:00:00Z", 60),
    lagInit("2026-07-25T06:00:00Z", 120),
    lagInit("2026-07-25T12:00:00Z", 180),
  ]);
  const details = detailRows(product, Date.parse("2026-07-25T14:00:00Z"), false);

  assert.deepEqual(details.lag, {
    note: "historical baseline (effective 2025-07-25–2026-07-25 UTC; as of 2026-07-25 18:00:00 UTC) · 1,204 samples across 301 days",
    last: "3m",
    p50: "15m",
    p95: "30m",
    p99: "45m",
  });
});

test("last lag uses the chosen last init and preserves signed zero and negatives", () => {
  const running = lagProduct([
    lagInit("2026-07-25T00:00:00Z", 0),
    lagInit("2026-07-25T06:00:00Z", -180),
    lagInit("2026-07-25T12:00:00Z", 999, "in_flight"),
  ]);
  assert.equal(
    detailRows(running, Date.parse("2026-07-25T12:20:00Z"), false).lag.last,
    "−3m",
  );

  const zero = lagProduct([lagInit("2026-07-25T00:00:00Z", 0)]);
  assert.equal(detailRows(zero, Date.parse("2026-07-25T01:00:00Z"), false).lag.last, "0s");
});

test("pending, empty, and missing lag baselines stay distinct", () => {
  const pending = lagProduct(
    [lagInit("2026-07-25T00:00:00Z", 60)],
    {
      ...readyPipelineLag(),
      status: "pending",
      window_start: null,
      window_end: null,
      generated_at: null,
      stats: null,
    },
  );
  const pendingRow = detailRows(pending, Date.parse("2026-07-25T01:00:00Z"), false).lag;
  assert.equal(pendingRow.note, "historical baseline pending");
  assert.deepEqual([pendingRow.last, pendingRow.p50, pendingRow.p95], ["1m", "—", "—"]);

  const empty = lagProduct(
    [lagInit("2026-07-25T00:00:00Z", undefined)],
    readyPipelineLag({
      stats: {
        p50_s: null,
        p95_s: null,
        p99_s: null,
        avg_s: null,
        sample_init_count: 0,
        sample_day_count: 0,
      },
    }),
  );
  const emptyRow = detailRows(empty, Date.parse("2026-07-25T01:00:00Z"), false).lag;
  assert.match(emptyRow.note, /0 samples across 0 days$/);
  assert.deepEqual([emptyRow.last, emptyRow.p50, emptyRow.p99], ["—", "—", "—"]);

  const old = lagProduct([lagInit("2026-07-25T00:00:00Z", undefined)]);
  delete old.pipeline_lag;
  const unavailable = detailRows(old, Date.parse("2026-07-25T01:00:00Z"), false).lag;
  assert.equal(
    unavailable.note,
    "unavailable (no published baseline)",
  );
  assert.deepEqual([unavailable.last, unavailable.p50, unavailable.p99], ["—", "—", "—"]);
});

test("the lag names the source it was measured from", () => {
  const product = lagProduct([lagInit("2026-07-25T00:00:00Z", 60)]);
  const mirrors = [
    { id: "external-noaa-gfs-aws", source_label: "AWS" },
    { id: "external-noaa-gfs-ftp", source_label: "NOMADS" },
    product,
  ];
  const noteOf = (lag) => {
    const row = { ...product, pipeline_lag: lag };
    return detailRows(
      row,
      Date.parse("2026-07-25T01:00:00Z"),
      false,
      lagSourceLabels(row, mirrors),
    ).lag.note;
  };

  assert.match(noteOf(readyPipelineLag()), /^after AWS · historical baseline/);
  // paired with both mirrors the metric measures from whichever published
  // first, which need not be the one the dataset was built from
  assert.match(
    noteOf(
      readyPipelineLag({
        source_ids: ["external-noaa-gfs-aws", "external-noaa-gfs-ftp"],
      }),
    ),
    /^after the earliest of AWS and NOMADS · historical baseline/,
  );
  // an id with no row in the group leaves the phrase off rather than guessing
  assert.match(
    noteOf(readyPipelineLag({ source_ids: ["external-noaa-gfs-gone"] })),
    /^historical baseline/,
  );
});

test("family lag labels its published comparison basis", () => {
  const product = lagProduct(
    [lagInit("2026-07-25T00:00:00Z", -600)],
    readyPipelineLag({
      basis: "shared_nat_prs_sfc",
      source_ids: ["external-noaa-hrrr-aws", "external-noaa-hrrr-ftp"],
    }),
  );
  const details = detailRows(product, Date.parse("2026-07-25T01:00:00Z"), false);
  assert.match(details.lag.note, /^matching nat\/prs\/sfc families/);
  assert.equal(details.lag.last, "−10m");
});

test("leaves upstream rows without a lag table", () => {
  const upstream = {
    ...lagProduct([lagInit("2026-07-25T00:00:00Z", 60)]),
    source_label: "AWS",
  };
  assert.equal(
    detailRows(upstream, Date.parse("2026-07-25T01:00:00Z"), false).lag,
    null,
  );
});

test("a product without enough history says so, and an established one says nothing", () => {
  assert.equal(
    timingBaselineNote({
      timing_baseline: {
        status: "insufficient_history",
        history_days: 23,
        required_history_days: 30,
      },
    }),
    "insufficient history (23/30 days)",
  );
  assert.equal(
    timingBaselineNote({
      timing_baseline: { status: "established", history_days: 41, required_history_days: 30 },
    }),
    null,
  );
  // a payload from before the baseline was published, or a malformed one,
  // renders as it always has rather than as "undefined/undefined days"
  assert.equal(timingBaselineNote({}), null);
  assert.equal(
    timingBaselineNote({ timing_baseline: { status: "insufficient_history" } }),
    null,
  );
});

test("local preview fixture carries a dynamical row lagging its source", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/pipeline-dashboard.json", import.meta.url),
      "utf8",
    ),
  );
  validateDashboard(fixture);
  const group = fixture.groups.find(({ id }) => id === "noaa-gfs");
  const product = group.products.find(({ source_label }) => source_label == null);
  assert.equal(product.row_label, "dynamical.org · virtual");

  const details = detailRows(
    product,
    Date.parse("2026-07-25T18:00:00Z"),
    false,
    lagSourceLabels(product, group.products),
  );
  // the note sits on the baseline it describes, not on the lag sample
  assert.equal(
    details.statsHeader,
    "time after init · 24 samples · insufficient history (24/30 days)",
  );
  // and it names the source the lag was measured from
  assert.deepEqual(details.lag, {
    note: "after AWS · historical baseline (effective 2025-07-25–2026-07-25 UTC; as of 2026-07-25 18:00:00 UTC) · 1,204 samples across 301 days",
    last: "5m",
    p50: "15m",
    p95: "30m",
    p99: "45m",
  });
});

test("local preview fixture exercises dashboard v2 facet rendering", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/pipeline-dashboard.json", import.meta.url),
      "utf8",
    ),
  );
  validateDashboard(fixture);
  const [product] = fixture.groups[0].products;
  assert.equal(fixture.v, 2);
  assert.equal(product.facet_groups.length, 5);
  assert.equal(facetRows(product).length, 5);
});

// A source with no mirror and no facets is the other shape the payload carries:
// one row under its group, one view, and a baseline as short as its monitoring.
test("local preview fixture carries a source-only group", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/pipeline-dashboard.json", import.meta.url),
      "utf8",
    ),
  );
  const group = fixture.groups.find(({ id }) => id === "eccc-hrdps");
  assert.equal(group.products.length, 1);

  const [product] = group.products;
  assert.equal(product.row_label, "MSC Datamart");
  assert.equal(displaySource(product.source), "dd.weather.gc.ca");
  assert.equal(product.facet_groups, undefined);
  assert.equal(viewsOf(product).length, 1);
  assert.deepEqual(
    (product.lead_group_stats ?? []).map(({ label }) => label),
    ["0h", "1d", "2d"],
  );
  // one sample is no baseline: the header says so where the percentiles sit,
  // the one place the product explains itself between runs
  assert.equal(
    detailRows(product, Date.parse("2026-07-25T18:00:00Z"), false).statsHeader,
    "time after init \u00b7 1 sample \u00b7 insufficient history (1/30 days)",
  );
});

test("preview pipeline route exposes only allowlisted staging JSON", async () => {
  const requested = [];
  const bucket = {
    async get(key) {
      requested.push(key);
      return key === "wxopticon/dashboard.json"
        ? { body: '{"v":2}', httpEtag: '"etag"' }
        : null;
    },
  };

  const response = await onRequestGet({
    env: { WXOPTICON_STAGING: bucket },
    params: { path: ["wxopticon", "dashboard.json"] },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"v":2}');
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(requested, ["wxopticon/dashboard.json"]);

  const unavailable = await onRequestGet({
    env: {},
    params: { path: ["wxopticon", "dashboard.json"] },
  });
  assert.equal(unavailable.status, 503);

  const denied = await onRequestGet({
    env: { WXOPTICON_STAGING: bucket },
    params: { path: ["wxopticon", "events.jsonl"] },
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(requested, ["wxopticon/dashboard.json"]);

  const history = await onRequestGet({
    env: { WXOPTICON_STAGING: bucket },
    params: { path: ["wxopticon", "history", "index.json"] },
  });
  assert.equal(history.status, 404);
  assert.deepEqual(requested, ["wxopticon/dashboard.json"]);
});

test("preview branches select the private staging route", () => {
  const source = readFileSync(
    new URL("../_data/pipelineAssetsBase.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /process\.env\.CF_PAGES_BRANCH/);
  assert.match(source, /\/pipeline-staging\/wxopticon/);
});

test("vendored module imports resolve and cache rules distinguish the shim", () => {
  const vendorDir = new URL("../public/vendor/", import.meta.url);
  const modules = readdirSync(vendorDir).filter((name) => name.endsWith(".mjs"));

  for (const name of modules) {
    const moduleUrl = new URL(name, vendorDir);
    const source = readFileSync(moduleUrl, "utf8");
    const specifiers = [
      ...source.matchAll(
        /\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?["'](\.[^"']+)["']/g,
      ),
      ...source.matchAll(
        /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
      ),
    ].map((match) => match[1]);

    for (const specifier of specifiers) {
      assert.ok(
        existsSync(new URL(specifier, moduleUrl)),
        `${name} imports missing ${specifier}`,
      );
    }
  }

  const headers = readFileSync(
    new URL("../public/_headers", import.meta.url),
    "utf8",
  );
  // a rule is a path line followed by its indented directives; a blank line
  // ends it, so a rule cannot borrow the next rule's directives
  const rules = new Map(
    headers
      .split(/\n\s*\n/)
      .map((block) => block.split("\n").filter((line) => !line.startsWith("#")))
      .filter((lines) => lines.length > 0)
      .map(([path, ...directives]) => [path.trim(), directives.join("\n")]),
  );
  const rule = (path) => rules.get(path);
  // every version-named library is immutable; nothing else in the directory
  // is, since its name does not change when its contents do
  for (const name of modules) {
    const versioned = /-\d+\.\d+\.\d+\.mjs$/.test(name);
    const cacheRule = rule(`/vendor/${name}`);
    if (versioned) {
      assert.match(
        cacheRule ?? "",
        /Cache-Control: public, max-age=31536000, immutable/,
        `${name} is not cached immutably`,
      );
    } else {
      assert.equal(cacheRule, undefined, `${name} must not have a cache rule`);
    }
  }
  assert.doesNotMatch(headers, /^\/vendor\/\*$/m);
  assert.doesNotMatch(headers, /^\/\*\.mjs$/m);
});

// A deploy must not pair fresh HTML with a stale stylesheet or script, so
// every first-party .css, .js, or .mjs the templates reference directly
// carries a content hash in its URL. What a module imports itself is
// revalidated on every load instead (see public/_headers).
test("the HTML versions every stylesheet and script it references", () => {
  const roots = ["content", "_includes"];
  const templates = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:njk|html|md)$/.test(entry.name)) templates.push(file);
    }
  };
  for (const root of roots) walk(new URL(`../${root}`, import.meta.url).pathname);

  // a page names its own stylesheet in front matter, and the layout links it
  const pageStylesheets = [];
  const references = [];
  for (const file of templates) {
    const source = readFileSync(file, "utf8");
    const declared = source.match(/^pageStylesheet:\s*(\S+)$/m)?.[1];
    if (declared) pageStylesheets.push({ file, url: declared });
    for (const match of source.matchAll(
      // a versioned query is one Nunjucks expression, which may quote a path
      /(?:src|href)="(\/[^"?]+\.(?:css|js|mjs)|\{\{ pageStylesheet \}\})(\?v=\{\{[^}]*\}\}|\?[^"]*)?"/g,
    )) {
      references.push({ file, url: match[1], query: match[2] ?? "" });
    }
  }
  assert.ok(pageStylesheets.length >= 1, "expected a page with its own stylesheet");
  for (const { file, url } of pageStylesheets) {
    assert.ok(
      existsSync(new URL(`../public${url}`, import.meta.url)),
      `${file} declares pageStylesheet ${url}, which is not in public/`,
    );
  }
  assert.ok(
    references.some(({ url }) => url === "{{ pageStylesheet }}"),
    "expected the layout to link the page stylesheet",
  );
  assert.ok(references.length >= 6, "expected to find the site's asset tags");
  for (const { file, url, query } of references) {
    if (url.startsWith("/")) {
      assert.ok(
        existsSync(new URL(`../public${url}`, import.meta.url)),
        `${file} references ${url}, which is not in public/`,
      );
    }
    assert.match(
      query,
      url === "{{ pageStylesheet }}"
        ? /^\?v=\{\{ \("public" ~ pageStylesheet\) \| fileHash \}\}$/
        : /^\?v=\{\{ (?:"public\/[^"]+" \| fileHash|assets\.mainCss) \}\}$/,
      `${file} references ${url} without a content hash`,
    );
  }
});
test("a row re-fits its runs whenever its body changes size", () => {
  const script = readFileSync("public/pipeline.mjs", "utf8");
  // each row watches its own body, so a font landing or the toc rail
  // appearing re-fits it as a window resize does
  assert.match(script, /new ResizeObserver\(measure\)/);
  assert.match(script, /observer\.disconnect\(\)/);
  assert.doesNotMatch(script, /addEventListener\("resize"/);
});

test("status pages share the uptime, pipeline, and pipeline webhooks subnav", () => {
  const base = readFileSync(
    new URL("../_includes/base.njk", import.meta.url),
    "utf8",
  );
  const status = readFileSync(
    new URL("../content/status.njk", import.meta.url),
    "utf8",
  );
  const pipeline = readFileSync(
    new URL("../content/status-pipeline.njk", import.meta.url),
    "utf8",
  );
  const subnav = readFileSync(
    new URL("../_includes/status-subnav.njk", import.meta.url),
    "utf8",
  );

  assert.match(status, /from "status-subnav\.njk" import statusSubnav/);
  assert.match(status, /call statusSubnav\(statusSection, statusFeed, pipelineAssetsBase\)/);
  assert.match(status, /statusSection: uptime/);
  assert.match(status, /href="\/status\/pipeline\/"/);
  assert.doesNotMatch(status, /noindex: true|sitemap: false/);
  assert.match(pipeline, /from "status-subnav\.njk" import statusSubnav/);
  assert.match(pipeline, /call statusSubnav\(statusSection, statusFeed, pipelineAssetsBase\)/);
  assert.doesNotMatch(pipeline, /noindex: true|sitemap: false/);
  assert.match(subnav, /class="status-subnav-row"/);
  assert.match(subnav, /class="status-subnav" role="navigation" aria-label="Status"/);
  assert.doesNotMatch(subnav, /<nav class="status-subnav"/);
  assert.match(subnav, /\{\{ caller\(\) \}\}/);
  assert.match(subnav, />uptime</);
  assert.match(subnav, /pipeline/);
  assert.match(subnav, /https:\/\/status\.dynamical\.org\/webhooks/);
  assert.match(
    subnav,
    /href="https:\/\/status\.dynamical\.org\/webhooks" target="_blank" rel="noopener"/,
  );
  assert.match(subnav, />pipeline webhooks<\/a>/);
  assert.match(subnav, /data-slot="system-health"/);
  assert.match(subnav, /data-slot="agency-health"/);
  assert.match(subnav, /upstream forecast sources/);
  assert.doesNotMatch(subnav, /weather agencies/);
  assert.doesNotMatch(subnav, /pipeline-history-toggle|pipeline-history-panel/);
  assert.doesNotMatch(subnav, /pipeline-controls-actions/);
  assert.match(status, /id="status-time-toggle"/);
  assert.match(pipeline, /id="status-time-toggle"/);
  assert.equal((base.match(/href="\/status\/"/g) ?? []).length, 2);
});

test("pipeline exposes no time-travel history controls or requests", () => {
  const script = readFileSync("public/pipeline.mjs", "utf8");
  const template = readFileSync("content/status-pipeline.njk", "utf8");

  assert.doesNotMatch(script, /history\/index|historyIndex|showSnapshot|openHistory/);
  assert.doesNotMatch(template, /pipeline-history|scrub-label|return-live/);
});

test("primary navigation styles the current section like the status subnav", () => {
  const base = readFileSync(
    new URL("../_includes/base.njk", import.meta.url),
    "utf8",
  );
  const mainCss = readFileSync(
    new URL("../public/main.css", import.meta.url),
    "utf8",
  );

  assert.match(base, /class="primary-nav"/);
  for (const section of ["catalog", "research", "updates", "about", "podcast", "status"]) {
    assert.match(base, new RegExp(`>${section}<`));
  }
  assert.equal((base.match(/aria-current="page"/g) ?? []).length, 6);
  assert.match(
    mainCss,
    /\.primary-nav \[aria-current="page"\],[\s\S]*\.status-subnav \[aria-current="page"\][\s\S]*font-weight: 700;[\s\S]*text-decoration: none;/,
  );
});

test("the shared time control shows only the browser's local zone", () => {
  const label = localZoneLabel(new Date("2026-07-26T12:00:00Z"));
  assert.ok(label.length > 0);
  assert.doesNotMatch(label, /local time/i);
});

test("either local status preview serves both fixture feeds", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["start:status", "start:pipeline"]) {
    assert.match(scripts[name], /STATUS_FIXTURE=1/);
    assert.match(scripts[name], /PIPELINE_FIXTURE=1/);
  }
});

test("pipeline page uses the shared subnav without a separate footer", () => {
  const template = readFileSync(
    new URL("../content/status-pipeline.njk", import.meta.url),
    "utf8",
  );
  const subnav = readFileSync(
    new URL("../_includes/status-subnav.njk", import.meta.url),
    "utf8",
  );
  const pipelineCss = readFileSync(
    new URL("../public/pipeline.css", import.meta.url),
    "utf8",
  );
  const pipelineScript = readFileSync(
    new URL("../public/pipeline.mjs", import.meta.url),
    "utf8",
  );
  const mainCss = readFileSync(
    new URL("../public/main.css", import.meta.url),
    "utf8",
  );

  assert.match(subnav, /https:\/\/status\.dynamical\.org\/webhooks/);
  // the migration notice and the page legend are gone: a cell's hover says
  // what it measured, and the squares and marks carry their own colors
  assert.doesNotMatch(template, /pipeline-notice|increasing the granularity/);
  assert.doesNotMatch(template, /pipeline-legend|part arrived|still expected/);
  assert.doesNotMatch(template, /no monitoring data|hover a cell/);
  assert.doesNotMatch(pipelineCss, /\.pipeline-notice|\.pipeline-legend/);
  assert.doesNotMatch(template, /pipeline-footer|window-days/);
  assert.doesNotMatch(pipelineScript, /window-days/);
  assert.match(template, /style="margin-top: 4rem;"/);
  assert.match(template, /status-page-updated[\s\S]*status-time-toggle/);
  assert.doesNotMatch(template, /Local time|Coordinated Universal Time/);
  assert.doesNotMatch(template, /Data product pipeline|Forecast-run arrival/);
  // "expected, nothing yet" and "no evidence either way" must not look alike
  assert.match(
    pipelineCss,
    /\.pipeline-cell\.g-pending\s*{\s*border: 1px solid var\(--pipeline-unobserved\);\s*}/,
  );
  assert.match(
    pipelineCss,
    /\.pipeline-cell\.g-pending\[data-timing="delayed"\]\s*{\s*border-color: var\(--pipeline-progress\);\s*}/,
  );
  assert.match(
    pipelineCss,
    /\.pipeline-cell\.g-unobserved\s*{[\s\S]*?repeating-linear-gradient/,
  );
  assert.doesNotMatch(
    pipelineCss,
    /\.pipeline-cell\.g-pending,\s*\.pipeline-cell\.g-unobserved/,
  );
  assert.match(
    pipelineCss,
    /\.pipeline-cell\.g-failed \.pipeline-cell-fill\s*{\s*height: 100%/,
  );
  assert.doesNotMatch(pipelineCss, /pipeline-bar|pipeline-lead-labels/);
  assert.doesNotMatch(
    mainCss,
    /\.status-subnav\s*{[^}]*font-size:/s,
  );
  assert.match(
    mainCss,
    /:where\(\.content\) :is\(ul, ol\):not\(\[class\]\) > li \+ li/,
  );
  assert.doesNotMatch(mainCss, /\.content \.status-health li \+ li/);
});

test("uptime uses light section headings without subtitles or rules", () => {
  const template = readFileSync(
    new URL("../content/status.njk", import.meta.url),
    "utf8",
  );
  const script = readFileSync(
    new URL("../public/status.mjs", import.meta.url),
    "utf8",
  );
  assert.match(template, />Core</);
  assert.match(template, /--index-row-border: 0/);
  assert.doesNotMatch(template, /class="status-(?:overall|groups)"/);
  assert.doesNotMatch(
    script,
    /All monitored public endpoints and tools are reporting normally\./,
  );
  assert.doesNotMatch(template, />Endpoints</);
  assert.doesNotMatch(template, /Data-serving and website/);
  assert.doesNotMatch(template, /Built on top of the data/);
  assert.doesNotMatch(template, /The data-serving path/);
  assert.doesNotMatch(template, /\.status-groups section > header/);
});

/* The run chart draws what the summarizer published: a point per run, and
   the current delayed threshold. */

function chartProduct(overrides = {}) {
  return {
    cadence_hours: 6,
    latency_stats: { p50_s: 3600, p95_s: 5400, delayed_threshold_s: 7200 },
    timing_baseline: { status: "established", history_days: 40, required_history_days: 30 },
    lead_group_stats: [
      { name: "f000", label: "0h", p50_s: 900, p95_s: 1200, delayed_threshold_s: 2100 },
      { name: "f072", label: "3d", p50_s: 3600, p95_s: 5400, delayed_threshold_s: 7200 },
    ],
    recent_inits: [
      { init_time: "2026-07-24T12:00:00Z", status: "complete", timing: "on_time", latency_s: 3500 },
      { init_time: "2026-07-24T18:00:00Z", status: "complete", timing: "delayed", latency_s: 7500 },
      { init_time: "2026-07-25T00:00:00Z", status: "failed" },
      { init_time: "2026-07-25T06:00:00Z", status: "unobserved" },
      { init_time: "2026-07-25T12:00:00Z", status: "in_flight", timing: "delayed" },
    ],
    ...overrides,
  };
}

test("run chart series: a point per landed run, elapsed for the run still arriving", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const series = runChartSeries(chartProduct(), now);
  assert.equal(series.threshold, 7200);
  assert.deepEqual(
    series.runs.map(({ init, seconds, elapsed, timing, status }) => ({
      init: init.init_time,
      seconds,
      elapsed,
      timing,
      status,
    })),
    [
      { init: "2026-07-24T12:00:00Z", seconds: 3500, elapsed: false, timing: "on_time", status: "complete" },
      { init: "2026-07-24T18:00:00Z", seconds: 7500, elapsed: false, timing: "delayed", status: "complete" },
      // two and a half hours into the run, drawn as elapsed time
      { init: "2026-07-25T12:00:00Z", seconds: 9000, elapsed: true, timing: "delayed", status: "in_flight" },
    ],
  );
  // the failure has no completion time, so it is not plotted; the unobserved
  // run is neither
});

test("run chart series: the marker follows the status, and a landed run without a time is left out", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const series = runChartSeries(
    chartProduct({
      recent_inits: [
        // a run still arriving is hollow at its elapsed time, whatever it reports
        { init_time: "2026-07-25T12:00:00Z", status: "in_flight", latency_s: 600 },
        { init_time: "2026-07-25T06:00:00Z", status: "complete" },
      ],
    }),
    now,
  );
  assert.deepEqual(
    series.runs.map(({ seconds, elapsed }) => ({ seconds, elapsed })),
    [{ seconds: 9000, elapsed: true }],
  );
});

test("run chart threshold: none without history, none when the feed omits it", () => {
  assert.equal(runChartThreshold(chartProduct()), 7200);
  assert.equal(
    runChartThreshold(
      chartProduct({
        timing_baseline: { status: "insufficient_history", history_days: 12, required_history_days: 30 },
      }),
    ),
    null,
  );
  assert.equal(
    runChartThreshold(chartProduct({ latency_stats: { p50_s: 3600, p95_s: 5400 } })),
    null,
  );
  assert.equal(
    runChartThreshold(chartProduct({ latency_stats: { delayed_threshold_s: null } })),
    null,
  );
  // the series still carries the points, so the chart draws without its line
  const series = runChartSeries(chartProduct({ latency_stats: {} }), Date.parse("2026-07-25T14:30:00Z"));
  assert.equal(series.threshold, null);
  assert.equal(series.runs.length, 3);
});

test("run chart key: names only the marks drawn", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const key = (product) =>
    runChartKey(product, runChartSeries(product, now).runs).map(({ mark, text }) => ({
      mark,
      text,
    }));
  // a landed on-time run, a landed delayed run, and a delayed run in flight:
  // each delayed mark is keyed as it is drawn, filled or hollow
  assert.deepEqual(key(chartProduct()), [
    { mark: "on-time", text: "judged on time" },
    { mark: "delayed", text: "judged delayed" },
    { mark: "delayed-elapsed", text: "judged delayed, not yet complete" },
  ]);
  // the only delayed run still arriving: no filled amber mark to name
  assert.deepEqual(
    key(
      chartProduct({
        recent_inits: [
          { init_time: "2026-07-24T12:00:00Z", status: "complete", timing: "on_time", latency_s: 3500 },
          { init_time: "2026-07-25T12:00:00Z", status: "in_flight", timing: "delayed" },
        ],
      }),
    ),
    [
      { mark: "on-time", text: "judged on time" },
      { mark: "delayed-elapsed", text: "judged delayed, not yet complete" },
    ],
  );
  // every run landed and none late: the color is still named
  assert.deepEqual(
    key(
      chartProduct({
        recent_inits: [
          { init_time: "2026-07-24T12:00:00Z", status: "complete", timing: "on_time", latency_s: 3500 },
          { init_time: "2026-07-24T18:00:00Z", status: "complete", timing: "on_time", latency_s: 3600 },
        ],
      }),
    ),
    [{ mark: "on-time", text: "judged on time" }],
  );
  // a run arriving on time is a green ring beside the ink ring of one too
  // early to judge, and each is keyed as drawn
  assert.deepEqual(
    key(
      chartProduct({
        recent_inits: [
          { init_time: "2026-07-24T12:00:00Z", status: "complete", timing: "on_time", latency_s: 3500 },
          { init_time: "2026-07-25T06:00:00Z", status: "in_flight", timing: "on_time" },
          { init_time: "2026-07-25T12:00:00Z", status: "pending", timing: null },
        ],
      }),
    ),
    [
      { mark: "on-time", text: "judged on time" },
      { mark: "on-time-elapsed", text: "judged on time, not yet complete" },
      { mark: "elapsed", text: "not yet complete: time so far" },
    ],
  );
  // an ink run beside a green one is complete too; it is named for its
  // missing verdict
  assert.deepEqual(
    key(
      chartProduct({
        recent_inits: [
          { init_time: "2026-07-24T12:00:00Z", status: "complete", timing: null, latency_s: 3500 },
          { init_time: "2026-07-24T18:00:00Z", status: "complete", timing: "on_time", latency_s: 3600 },
        ],
      }),
    ),
    [
      { mark: "on-time", text: "judged on time" },
      { mark: "complete", text: "complete, not judged" },
    ],
  );
  // a run too early to judge on a product with a baseline is only "not yet
  // complete"; its missing verdict is not a kind of run
  assert.deepEqual(
    key(
      chartProduct({
        recent_inits: [{ init_time: "2026-07-25T12:00:00Z", status: "pending", timing: null }],
      }),
    ),
    [{ mark: "elapsed", text: "not yet complete: time so far" }],
  );
  // a product short of history says why it has no verdicts and no line
  assert.deepEqual(
    key(
      chartProduct({
        timing_baseline: { status: "insufficient_history", history_days: 7, required_history_days: 30 },
        recent_inits: [
          { init_time: "2026-07-25T06:00:00Z", status: "complete", timing: null, latency_s: 5200 },
          { init_time: "2026-07-25T12:00:00Z", status: "in_flight", timing: null },
        ],
      }),
    ),
    [
      { mark: "complete", text: "complete" },
      { mark: "elapsed", text: "not yet complete: time so far" },
      { mark: null, text: "no delayed threshold yet: 7 of 30 days with a completed run" },
    ],
  );
});

// the computed colors are the e2e spec's to check; this keeps the on-time
// verdict colored and a grey for no verdict from coming back
test("run chart marks: green for on time, no grey for no verdict", () => {
  const css = readFileSync(new URL("../public/pipeline.css", import.meta.url), "utf8");
  assert.match(css, /\.pipeline-runs \[data-timing="on_time"\]\s*{[^}]*--pipeline-ok/);
  assert.doesNotMatch(css, /\.pipeline-runs circle\s*{[^}]*--muted-text/);
});

test("run chart scales: every value inside the plot, the late run above the line", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const series = runChartSeries(chartProduct(), now);
  const scale = runChartScales(series, 600, 6);
  // y grows downward, so a longer latency sits higher on the page
  const line = scale.y(series.threshold);
  const [onTime, delayed, running] = series.runs.map((run) => scale.y(run.seconds));
  assert.ok(onTime > line, "an on-time run sits below the line");
  assert.ok(delayed < line, "a delayed run sits above the line");
  assert.ok(running < line, "a run past its threshold sits above the line");
  for (const y of [line, onTime, delayed, running]) {
    assert.ok(y >= scale.top && y <= scale.bottom, `${y} inside the plot`);
  }
  // time is proportional: the missing 00z and 06z leave a gap twice the step
  const [x0, x1, x2] = series.runs.map((run) => scale.x(run.ms));
  assert.ok(Math.abs((x2 - x1) / (x1 - x0) - 3) < 1e-9);
  assert.ok(x0 > scale.left && x2 < scale.right);
  // ticks are round latencies inside the domain, few enough to read
  assert.ok(scale.yTicks.length >= 2 && scale.yTicks.length <= 5, String(scale.yTicks));
  for (const tick of scale.yTicks) {
    assert.equal(tick % 900, 0);
    assert.ok(scale.y(tick) >= scale.top && scale.y(tick) <= scale.bottom);
  }
  assert.equal(scale.labelEvery, 1);
});

test("run chart scales: one run, or runs all alike, still draw", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const one = runChartSeries(
    chartProduct({
      latency_stats: {},
      recent_inits: [
        { init_time: "2026-07-25T06:00:00Z", status: "complete", latency_s: 3600 },
      ],
    }),
    now,
  );
  const scale = runChartScales(one, 400, 24);
  const y = scale.y(3600);
  const x = scale.x(one.runs[0].ms);
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  assert.ok(y >= scale.top && y <= scale.bottom);
  assert.ok(Math.abs(x - (scale.left + scale.right) / 2) < 1e-9);
});

test("run chart scales: labels thin to what fits between the closest inits", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/pipeline-dashboard.json", import.meta.url),
      "utf8",
    ),
  );
  const [product] = fixture.groups[0].products;
  const series = runChartSeries(product, Date.parse(fixture.generated_at));
  const labelPx = initColumnPx(product, "UTC");
  assert.equal(labelPx, 30);
  // ten six-hourly runs: every init names itself across a row, every other
  // one in a phone column
  assert.equal(runChartScales(series, 600, 6, labelPx).labelEvery, 1);
  assert.equal(runChartScales(series, 300, 6, labelPx).labelEvery, 2);
});

test("run chart scales: a spread of seconds does not fill the plot, and weeks do not flood the axis", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const tight = runChartSeries(
    chartProduct({
      latency_stats: {},
      recent_inits: [
        { init_time: "2026-07-25T00:00:00Z", status: "complete", latency_s: 3600 },
        { init_time: "2026-07-25T06:00:00Z", status: "complete", latency_s: 3601 },
      ],
    }),
    now,
  );
  const scale = runChartScales(tight, 600, 6);
  // a second apart reads as a second apart, on an axis that still has ticks
  assert.ok(Math.abs(scale.y(3600) - scale.y(3601)) < 1);
  assert.ok(scale.yTicks.length >= 2);
  const stale = runChartSeries(
    chartProduct({
      latency_stats: {},
      recent_inits: [
        { init_time: "2026-06-01T00:00:00Z", status: "in_flight" },
        { init_time: "2026-06-08T00:00:00Z", status: "in_flight" },
      ],
    }),
    now,
  );
  assert.ok(runChartScales(stale, 600, 24).yTicks.length <= 5);
});

// A feed that has stalled, or an init that is stuck, leaves a run in flight for
// days. It is parked at the top edge with its time written beside it, so the
// landed runs keep the plot; a run merely late is drawn at its own time.
test("run chart scales: a run in flight for weeks is parked at the top, a late one drawn at its time", () => {
  const now = Date.parse("2026-08-14T12:00:00Z");
  const product = chartProduct({
    recent_inits: [
      { init_time: "2026-07-24T12:00:00Z", status: "complete", timing: "on_time", latency_s: 3500 },
      { init_time: "2026-07-24T18:00:00Z", status: "complete", timing: "delayed", latency_s: 7500 },
      { init_time: "2026-07-25T00:00:00Z", status: "in_flight", timing: "delayed" },
    ],
  });
  const series = runChartSeries(product, now);
  const scale = runChartScales(series, 600, 6);
  const [onTime, delayed, running] = series.runs;
  assert.equal(running.seconds, 20.5 * 86400);
  // the stale run is parked at the top edge, and says its time in words
  assert.ok(scale.pinned(running.seconds));
  assert.equal(scale.y(running.seconds), scale.top);
  assert.equal(pinnedText(running.seconds), "20d so far ↑");
  assert.equal(pinnedText(30000), "8h 20m so far ↑");
  // the landed runs keep the plot, either side of the line and off the floor
  const line = scale.y(series.threshold);
  assert.ok(scale.y(onTime.seconds) - line > 20, "on-time run well below the line");
  assert.ok(line - scale.y(delayed.seconds) > 2, "delayed run above the line");
  assert.ok(scale.bottom - scale.y(onTime.seconds) > 10, "not on the baseline");
  assert.ok(scale.yTicks.every((tick) => tick <= 7500 * 1.5));
  // a run merely late, twice the slowest landed one, costs the landed runs
  // little: they keep clear room either side of the line
  const late = runChartSeries(product, Date.parse("2026-07-25T04:10:00Z"));
  assert.equal(late.runs[2].seconds, 15000);
  const lateScale = runChartScales(late, 600, 6);
  assert.ok(!lateScale.pinned(15000));
  assert.ok(lateScale.y(15000) > lateScale.top);
  const lateLine = lateScale.y(late.threshold);
  assert.ok(lateScale.y(3500) - lateLine > 20, "on-time run well below the line");
  assert.ok(lateLine - lateScale.y(7500) > 2, "delayed run above the line");
  // with nothing landed, the elapsed times take the axis themselves
  const only = runChartSeries(
    chartProduct({
      latency_stats: {},
      recent_inits: [{ init_time: "2026-07-25T00:00:00Z", status: "pending" }],
    }),
    now,
  );
  const alone = runChartScales(only, 600, 6);
  assert.ok(alone.y(only.runs[0].seconds) > alone.top);
  assert.ok(alone.y(only.runs[0].seconds) < alone.bottom);
});

// A parked run says its time in the title row only when it is alone and its
// words fit beside the title; otherwise the words would collide, so every
// parked run is named under the chart by its init.
test("run chart parked runs: labelled beside the mark when alone and it fits, else named under the chart", () => {
  const run = (hour, seconds) => ({ init: { init_time: `2026-07-25T${hour}:00:00Z` }, seconds, elapsed: true });
  const opts = { em: 10, titleRight: 90, right: 400, top: 16 };
  const one = pinnedLayout([run("12", 51 * 86400)], () => 380, opts);
  assert.equal(one.labels.length, 1);
  assert.equal(one.labels[0].text, "51d so far ↑");
  assert.equal(one.labels[0].attrs["text-anchor"], "end");
  // its left edge clears the title and the gap after it, and it stays in the plot
  assert.ok(one.labels[0].attrs.x - one.labels[0].text.length * 6 >= 90 + 6);
  assert.ok(one.labels[0].attrs.x <= 400);
  assert.deepEqual(one.overflow, []);
  // a mark under the title: words ending at it would run into the title
  const underTitle = pinnedLayout([run("12", 51 * 86400)], () => 60, opts);
  assert.deepEqual(underTitle.labels, []);
  assert.equal(underTitle.overflow.length, 1);
  // a plot too narrow for the words beside the title
  const narrow = pinnedLayout([run("12", 51 * 86400)], () => 60, { ...opts, right: 100 });
  assert.deepEqual(narrow.labels, []);
  assert.equal(narrow.overflow.length, 1);
  // two parked runs would write over each other
  const two = pinnedLayout([run("06", 52 * 86400), run("12", 51 * 86400)], () => 380, opts);
  assert.deepEqual(two.labels, []);
  assert.deepEqual(pinnedKeyItems(two.overflow, false), [
    { mark: null, text: "above the chart: 07-25 06z, 52d so far; 07-25 12z, 51d so far" },
  ]);
  assert.deepEqual(pinnedKeyItems([], false), []);
});

test("run chart scales: repeated inits and a zero cadence still draw finite coordinates", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const one = { init_time: "2026-07-25T06:00:00Z", status: "complete", latency_s: 3600 };
  // a repeated timestamp is one point, not two on the same x with the same key
  const twice = runChartSeries(chartProduct({ recent_inits: [one, { ...one }] }), now);
  assert.equal(twice.runs.length, 1);
  for (const cadence of [0, null, undefined, -6]) {
    const scale = runChartScales(twice, 600, cadence);
    assert.ok(Number.isFinite(scale.x(twice.runs[0].ms)), `cadence ${cadence}`);
    assert.ok(Number.isFinite(scale.labelEvery) && scale.labelEvery >= 1);
  }
});

/* The aligned plot shares the latency domain and adds nothing but its own
   height; with nothing to plot and no line, the axis is not invented. */

test("aligned chart scales: the row chart's domain at the plot's own height", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const series = runChartSeries(chartProduct(), now);
  const across = runChartScales(series, 600, 6);
  const aligned = alignedChartScales(series);
  assert.deepEqual(aligned.yTicks, across.yTicks);
  assert.equal(aligned.pinned(1e6), across.pinned(1e6));
  assert.equal(aligned.empty, false);
  for (const run of series.runs) {
    assert.ok(aligned.y(run.seconds) >= aligned.top && aligned.y(run.seconds) <= aligned.bottom);
  }
  const none = runChartSeries(
    chartProduct({
      latency_stats: {},
      recent_inits: [{ init_time: "2026-07-25T06:00:00Z", status: "failed" }],
    }),
    now,
  );
  assert.equal(alignedChartScales(none).empty, true);
});

/* The aligned chart's columns are the lead field's: it draws the field's own
   slice of runs, a run width and gap apart. */

test("run chart columns: a point sits at the centre of its run's square", () => {
  const columns = runColumns(4, 30, 6);
  assert.equal(columns.width, 4 * 30 + 3 * 6);
  assert.deepEqual([0, 1, 2, 3].map(columns.x), [15, 51, 87, 123]);
  // a lone run is one column; no runs is no width, not a negative gap
  assert.equal(runColumns(1, 30, 6).width, 30);
  assert.equal(runColumns(0, 30, 6).width, 0);
});

test("run chart series: only the runs the field shows, kept in their columns", () => {
  const now = Date.parse("2026-07-25T14:30:00Z");
  const product = chartProduct();
  // the field shows the newest three: failed, unobserved, in flight
  const shown = displayedRuns(product, 3);
  assert.deepEqual(
    shown.map((init) => init.init_time),
    ["2026-07-25T00:00:00Z", "2026-07-25T06:00:00Z", "2026-07-25T12:00:00Z"],
  );
  const series = runChartSeries(product, now, shown);
  // only the run in flight has a time; the two before it keep their columns
  // (the chart looks each point up by init, never by its place in the series)
  assert.deepEqual(series.runs.map((run) => run.init.init_time), ["2026-07-25T12:00:00Z"]);
  assert.equal(displayedRuns(product, 0).length, 5);
  assert.equal(displayedRuns(product, null).length, 5);
});

test("details name each group's own delayed threshold beside its percentiles", () => {
  const product = chartProduct();
  const rows = detailRows(product, Date.parse("2026-07-25T14:30:00Z"), false).rows;
  assert.deepEqual(rows.map((row) => row.threshold), ["35m", "2h"]);
  // and none while the product is short of history, whatever the feed says
  product.timing_baseline.status = "insufficient_history";
  assert.deepEqual(
    detailRows(product, Date.parse("2026-07-25T14:30:00Z"), false).rows.map((row) => row.threshold),
    ["—", "—"],
  );
});

// The fixture is what the browser spec and the local preview draw, so its
// threshold has to be the one its percentiles imply, and its delayed run has
// to sit past it — or the chart would contradict the caption beside it.
test("local preview fixture carries a coherent delayed threshold and a run past it", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/pipeline-dashboard.json", import.meta.url),
      "utf8",
    ),
  );
  const [product] = fixture.groups[0].products;
  const { p50_s, p95_s, delayed_threshold_s } = product.latency_stats;
  assert.equal(delayed_threshold_s, p95_s + Math.max(p95_s - p50_s, 900));
  for (const stats of product.lead_group_stats) {
    assert.equal(
      stats.delayed_threshold_s,
      stats.p95_s + Math.max(stats.p95_s - stats.p50_s, 900),
      stats.name,
    );
  }
  for (const init of product.recent_inits) {
    if (init.status !== "complete") continue;
    assert.equal(
      init.timing,
      init.latency_s > delayed_threshold_s ? "delayed" : "on_time",
      init.init_time,
    );
  }
  const series = runChartSeries(product, Date.parse(fixture.generated_at));
  assert.equal(series.threshold, delayed_threshold_s);
  assert.ok(series.runs.some((run) => !run.elapsed && run.timing === "delayed"));
  // the products short of history publish no threshold, and draw no line
  for (const group of fixture.groups) {
    for (const other of group.products) {
      if (other.timing_baseline.status !== "insufficient_history") continue;
      assert.equal(other.latency_stats.delayed_threshold_s, null, other.id);
      assert.equal(runChartThreshold(other), null, other.id);
    }
  }
});
