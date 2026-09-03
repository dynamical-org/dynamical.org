import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  runsThatFit,
  runsThatFitFacetRows,
  clockTime,
  detailRows,
  displaySource,
  isDynamicalRow,
  lagAt,
  lagPercentile,
  lagSeries,
  sourceRowsOf,
  etaLineText,
  facetRows,
  initColumnPx,
  initParts,
  selectedTimeZone,
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

test("accepts the granular dashboard contract", () => {
  assert.equal(validateDashboard(dashboard()).groups[0].id, "noaa-gfs");
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
    () => validateDashboard({ ...dashboard(), v: 3 }),
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
      { label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 },
      { label: "3d", p50_s: 2400, p95_s: 3600, p99_s: 4800 },
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
        },
        {
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
        },
      ],
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
      dimension: "component",
      label: "pgrb2a",
      status: "processing",
      state: "in_flight",
      timing: null,
      completion: 0.75,
      count: "3 / 4 observed",
    },
    {
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

/* Ingestion lag. dynamical.org's own rows carry a null `source_label` and sit
   in the group of the sources they read, so the frontend subtracts: both
   latencies are seconds after the same init. */

function sourceRow(label, latencies) {
  return {
    source_label: label,
    recent_inits: Object.entries(latencies).map(([init_time, latency_s]) => ({
      init_time,
      status: latency_s == null ? "in_flight" : "complete",
      latency_s,
      lead_groups: [
        { status: "complete", latency_s: 900 },
        { status: latency_s == null ? "in_flight" : "complete", latency_s },
      ],
    })),
  };
}

function dynamicalRow(latencies) {
  return {
    source_label: null,
    row_label: "dynamical.org · virtual",
    recent_inits: Object.entries(latencies).map(([init_time, latency_s]) => ({
      init_time,
      status: latency_s == null ? "in_flight" : "complete",
      latency_s,
      lead_groups: [
        { status: latency_s == null ? "in_flight" : "complete", latency_s },
      ],
    })),
    lead_group_stats: [{ label: "fc", p50_s: 4100, p95_s: 5000, p99_s: 6100 }],
    latency_stats: { p50_s: 4100, p95_s: 5000, p99_s: 6100, sample_init_count: 24 },
  };
}

test("reads the source rows of a group off the null source label", () => {
  const aws = sourceRow("AWS", { "2026-07-25T00:00:00Z": 3400 });
  const virtual = dynamicalRow({ "2026-07-25T00:00:00Z": 4000 });

  assert.deepEqual(sourceRowsOf([aws, virtual]), [aws]);
  assert.equal(isDynamicalRow(virtual), true);
  assert.equal(isDynamicalRow(aws), false);
});

test("splits the HRRR group into its two mirrors and the virtual row", () => {
  // the shape wxopticon publishes: dynamical's dataset sits in the group of
  // the sources it reads, and only it carries a null source_label
  const products = [
    { id: "external-noaa-hrrr-aws", source_label: "AWS" },
    { id: "external-noaa-hrrr-ftp", source_label: "NOMADS" },
    { id: "noaa-hrrr-forecast-48-hour-virtual", source_label: null },
  ];

  assert.deepEqual(
    sourceRowsOf(products).map(({ id }) => id),
    ["external-noaa-hrrr-aws", "external-noaa-hrrr-ftp"],
  );
  assert.deepEqual(
    products.filter(isDynamicalRow).map(({ id }) => id),
    ["noaa-hrrr-forecast-48-hour-virtual"],
  );
});

test("lags a dynamical init behind the earliest source completion", () => {
  const at = "2026-07-25T00:00:00Z";
  const aws = sourceRow("AWS", { [at]: 3400 });
  const nomads = sourceRow("NOMADS", { [at]: 3200 });
  const [init] = dynamicalRow({ [at]: 4000 }).recent_inits;

  assert.equal(lagAt(init, [aws]), 600);
  // the earliest publication is the one worth measuring from, so two mirrors
  // lag from the faster of them
  assert.equal(lagAt(init, [aws, nomads]), 800);
  assert.equal(lagAt(init, [nomads, aws]), 800);

  // dynamical can land before a mirror it is not reading
  const [early] = dynamicalRow({ [at]: 3000 }).recent_inits;
  assert.equal(lagAt(early, [aws]), -400);
});

test("has no lag without a completed pair for the init", () => {
  const at = "2026-07-25T00:00:00Z";
  const aws = sourceRow("AWS", { [at]: 3400 });
  const [running] = dynamicalRow({ [at]: null }).recent_inits;
  const [done] = dynamicalRow({ [at]: 4000 }).recent_inits;

  assert.equal(lagAt(running, [aws]), null); // dynamical still in flight
  assert.equal(lagAt(done, [sourceRow("AWS", { [at]: null })]), null); // source is
  assert.equal(lagAt(done, [sourceRow("AWS", { "2026-07-25T06:00:00Z": 3400 })]), null);
  assert.equal(lagAt(done, []), null);
  assert.equal(lagAt(null, [aws]), null);
});

test("takes lag percentiles by nearest rank, and only from a real sample", () => {
  const lags = [600, 540, 660, 480, 720, 600, 540, 300];
  assert.equal(lagPercentile(lags, 0.5), 540);
  assert.equal(lagPercentile(lags, 0.95), 720);
  assert.equal(lagPercentile(lags, 0.99), 720);

  // one run is a number, not a distribution
  assert.equal(lagPercentile([600], 0.5), null);
  assert.equal(lagPercentile([], 0.5), null);
  assert.equal(lagPercentile([-300, 600], 0.5), -300);
});

test("details read a dynamical row as lag after its source", () => {
  const inits = {
    "2026-07-25T00:00:00Z": 3400,
    "2026-07-25T06:00:00Z": 3600,
    "2026-07-25T12:00:00Z": 3500,
  };
  const aws = sourceRow("AWS", inits);
  const virtual = dynamicalRow({
    "2026-07-25T00:00:00Z": 3400 + 600,
    "2026-07-25T06:00:00Z": 3600 - 180,
    "2026-07-25T12:00:00Z": 3500 + 120,
  });
  const details = detailRows(
    virtual,
    Date.parse("2026-07-25T14:00:00Z"),
    false,
    [aws, virtual],
  );

  assert.equal(details.statsHeader, "lag after source · 3 recent samples");
  const [row] = details.rows;
  // the duration column carries the lag; the time beside it still says when
  // the run finished
  assert.equal(row.last.duration, "2m");
  assert.equal(row.last.time, "13:00");
  assert.equal(lagSeries(virtual, [aws]).length, 3);
  assert.deepEqual([row.p50, row.p95, row.p99], ["2m", "10m", "10m"]);

  // a single lagged run names its sample in the singular and reports no spread
  const lone = dynamicalRow({ "2026-07-25T00:00:00Z": 4000 });
  const only = detailRows(lone, Date.parse("2026-07-25T14:00:00Z"), false, [
    sourceRow("AWS", { "2026-07-25T00:00:00Z": 3400 }),
    lone,
  ]);
  assert.equal(only.statsHeader, "lag after source · 1 recent sample");
  assert.deepEqual(
    [only.rows[0].last.duration, only.rows[0].p50],
    ["10m", "—"],
  );
});

test("renders a negative lag with a sign", () => {
  const at = "2026-07-25T00:00:00Z";
  const virtual = dynamicalRow({ [at]: 3220 });
  const details = detailRows(
    virtual,
    Date.parse("2026-07-25T14:00:00Z"),
    false,
    [sourceRow("AWS", { [at]: 3400 }), virtual],
  );
  assert.equal(details.rows[0].last.duration, "\u22123m");
});

test("keeps time after init where a row has no source beside it", () => {
  const at = "2026-07-25T00:00:00Z";
  const virtual = dynamicalRow({ [at]: 4000 });

  // a dynamical row alone in its group, and the default with no group at all
  for (const group of [[virtual], undefined]) {
    const details = detailRows(
      virtual,
      Date.parse("2026-07-25T14:00:00Z"),
      false,
      group,
    );
    assert.equal(details.statsHeader, "time after init · 24 samples");
    assert.deepEqual(
      [details.rows[0].last.duration, details.rows[0].p50],
      ["1h 7m", "1h 8m"],
    );
  }
});

test("leaves an upstream row untouched by a dynamical sibling", () => {
  const at = "2026-07-25T00:00:00Z";
  const aws = {
    ...sourceRow("AWS", { [at]: 3600 }),
    lead_group_stats: [{ label: "1d", p50_s: 1200, p95_s: 1800, p99_s: 2400 }],
    latency_stats: { p50_s: 1200, p95_s: 1800, p99_s: 2400, sample_init_count: 30 },
  };
  const virtual = dynamicalRow({ [at]: 4000 });
  const now = Date.parse("2026-07-25T14:00:00Z");

  assert.deepEqual(
    detailRows(aws, now, false, [aws, virtual]),
    detailRows(aws, now, false),
  );
  assert.equal(
    detailRows(aws, now, false, [aws, virtual]).statsHeader,
    "time after init · 30 samples",
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
    group.products,
  );
  assert.equal(details.statsHeader, "lag after source · 8 recent samples");
  assert.equal(details.rows[0].last.duration, "5m");
  assert.deepEqual(
    [details.rows[0].p50, details.rows[0].p95, details.rows[0].p99],
    ["9m", "12m", "12m"],
  );
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
  assert.equal(
    detailRows(product, Date.parse("2026-07-25T18:00:00Z"), false).statsHeader,
    "time after init \u00b7 1 sample",
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

test("a resize re-fits the live dashboard at the current time", () => {
  const script = readFileSync("public/pipeline.mjs", "utf8");
  const handler = script.slice(
    script.indexOf('window.addEventListener("resize"'),
    script.indexOf("function setTimeMode"),
  );
  assert.match(handler, /displayDashboard\(displayedDashboard, Date\.now\(\)\)/);
  assert.doesNotMatch(handler, /mode|displayedAt/);
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
  // the migration notice is deliberate copy, not decoration: it should leave
  // with the cutover and backfill it describes
  assert.match(template, /increasing the granularity of arrival monitoring/);
  assert.match(template, /intermittent or\s+show arrival states that appear incorrect/);
  assert.match(pipelineCss, /\.pipeline-notice \{/);
  assert.match(template, /part arrived/);
  assert.match(template, /still expected/);
  assert.match(template, /no monitoring data/);
  assert.match(template, /hover a cell for what it measured/);
  assert.match(template, /no monitoring data/);
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
