import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agencySummary,
  bandsOf,
  cellOf,
  cellTitle,
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
  // and the fit follows the rows it will actually draw: "pgrb2a.0p50" needs a
  // 66px gutter where "control" needs 42px, so the member view fits one more run
  assert.equal(runsThatFitFacetRows(joint, 390, "component"), 5);
  assert.equal(runsThatFitFacetRows(joint, 390, "member"), 6);
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
  // a block is its lead columns at proportional widths (18px + 30px) plus the
  // 2px between them, so 50px of block and 56px of pitch
  assert.equal(runsThatFitFacetRows(joint, 390), 5);
  assert.equal(runsThatFitFacetRows(joint, 240), 3);
  assert.equal(runsThatFitFacetRows(joint, 200), 2);
  assert.equal(runsThatFitFacetRows(joint, 1200), 10);
  // never zero, and an unmeasured row shows everything rather than nothing
  assert.equal(runsThatFitFacetRows(joint, 80), 1);
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

test("bands a history snapshot, which declares neither list up front", () => {
  const snapshot = facetedProduct();
  delete snapshot.lead_groups;
  delete snapshot.facet_groups;
  snapshot.lead_group_stats = [
    { name: "f000", label: "1d" },
    { name: "f240", label: "10d" },
  ];

  assert.deepEqual(
    bandsOf(snapshot).map((band) => `${band.kind}:${band.label}`),
    ["lead:10d", "lead:1d"],
  );
  // and still measures, rather than rendering an empty field
  const [longest] = bandsOf(snapshot);
  assert.equal(cellOf(longest, snapshot.recent_inits[0]).state, "in_flight");
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
      header: "07-26 12z",
      rows: [
        {
          label: "1d",
          status: "complete",
          time: "12:30",
          duration: "30m",
          p50: "20m",
          p95: "30m",
          p99: "40m",
        },
        {
          label: "3d",
          status: "processing",
          time: "ETA 13:00",
          duration: "30m 0s",
          p50: "40m",
          p95: "1h",
          p99: "1h 20m",
        },
      ],
    },
  );
});

test("shows the previous init details while waiting for the next init", () => {
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
  };

  const details = detailRows(
    product,
    Date.parse("2026-07-26T07:00:00Z"),
    false,
  );

  assert.equal(details.header, "07-26 06z · previous init");
  assert.deepEqual(
    details.rows.map(({ status, time, duration }) => ({
      status,
      time,
      duration,
    })),
    [
      { status: "complete", time: "06:20", duration: "20m" },
      { status: "complete", time: "06:45", duration: "45m" },
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
      completion: 0.75,
      count: "3 / 4 observed",
    },
    {
      dimension: "member",
      label: "control",
      status: "complete",
      completion: 1,
      count: "4 / 4 observed",
    },
  ]);
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
});

test("preview branches select the private staging route", () => {
  const source = readFileSync(
    new URL("../_data/pipelineAssetsBase.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /process\.env\.CF_PAGES_BRANCH/);
  assert.match(source, /\/pipeline-staging\/wxopticon/);
});

test("a resize re-fits without re-timing a scrubbed snapshot", () => {
  const script = readFileSync("public/pipeline.mjs", "utf8");
  const handler = script.slice(
    script.indexOf('window.addEventListener("resize"'),
    script.indexOf("function setTimeMode"),
  );
  assert.match(handler, /displaySnapshot\(/);
  assert.match(handler, /mode === "live" \? Date\.now\(\) : displayedAt/);
  assert.doesNotMatch(handler, /displaySnapshot\(\s*displayedSnapshot,\s*Date\.now\(\)/);
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
  assert.match(subnav, /statusSection == "pipeline"/);
  assert.match(subnav, /pipeline-history-toggle/);
  assert.doesNotMatch(subnav, /pipeline-controls-actions/);
  assert.match(status, /id="status-time-toggle"/);
  assert.match(pipeline, /id="status-time-toggle"/);
  assert.equal((base.match(/href="\/status\/"/g) ?? []).length, 2);
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
  assert.match(template, /hover a square for what it measured/);
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
