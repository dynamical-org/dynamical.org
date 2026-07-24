import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatUptime,
  isStatusDataStale,
  summarizeOverallStatus,
  validateStatusData,
} from "../public/status.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/status.json", import.meta.url), "utf8"),
);

const operationalData = {
  generated_at: "2026-07-24T19:55:00Z",
  datasets: [
    {
      id: "noaa-gfs-forecast",
      name: "NOAA GFS forecast",
      status: "operational",
      last_successful_update: "2026-07-24T18:00:00Z",
    },
  ],
  endpoints: [
    {
      id: "dynamical-org",
      name: "dynamical.org",
      status: "operational",
      uptime_90d: 99.9,
    },
  ],
};

test("accepts the published feed shape", () => {
  // Returns a normalized copy, not the same reference, so compare by value.
  assert.deepEqual(validateStatusData(fixture), fixture);
  assert.equal(fixture.datasets.length, 17);
  assert.deepEqual(summarizeOverallStatus(fixture), {
    status: "down",
    incidents: [
      { name: "NOAA HRRR forecast, 48 hour", status: "degraded" },
      { name: "NASA SMAP Level 3, 36 km, v9", status: "down" },
    ],
  });
});

test("never rounds an imperfect uptime up to 100%", () => {
  assert.equal(formatUptime(100), "100");
  assert.equal(formatUptime(99.9999), "99.999");
  assert.equal(formatUptime(99.9), "99.9");
  assert.equal(formatUptime(99.95), "99.95");
});

test("summarizes an operational feed", () => {
  assert.deepEqual(summarizeOverallStatus(operationalData), {
    status: "operational",
    incidents: [],
  });
});

test("lists degraded and down components with the worst overall state", () => {
  const data = structuredClone(operationalData);
  data.datasets[0].status = "degraded";
  data.endpoints[0].status = "down";

  assert.deepEqual(summarizeOverallStatus(data), {
    status: "down",
    incidents: [
      { name: "NOAA GFS forecast", status: "degraded" },
      { name: "dynamical.org", status: "down" },
    ],
  });
});

test("marks status data stale after twenty minutes", () => {
  const generatedAt = "2026-07-24T19:40:00Z";

  assert.equal(
    isStatusDataStale(generatedAt, new Date("2026-07-24T20:00:00Z")),
    false,
  );
  assert.equal(
    isStatusDataStale(generatedAt, new Date("2026-07-24T20:00:00.001Z")),
    true,
  );
});

test("rejects a malformed envelope", () => {
  assert.throws(() => validateStatusData({}), /invalid status document/i);
  assert.throws(
    () => validateStatusData({ ...operationalData, generated_at: "nope" }),
    /invalid status document/i,
  );
  assert.throws(
    () => validateStatusData({ ...operationalData, datasets: [{ id: 1 }] }),
    /invalid status entry/i,
  );
});

test("refuses a contentless document instead of reporting all clear", () => {
  // The worst possible failure for a status page: a well-formed envelope with no
  // components rendering as "All systems operational" during an outage.
  assert.throws(
    () => validateStatusData({ ...operationalData, datasets: [], endpoints: [] }),
    /no components/i,
  );
  assert.throws(
    () => validateStatusData({ ...operationalData, endpoints: [] }),
    /no components/i,
  );
});

test("keeps rendering when the publisher adds an unrecognized state", () => {
  // The publisher deploys from a separate repo; a fourth state must degrade one
  // row to Unknown, not black out the whole page.
  const data = structuredClone(operationalData);
  data.datasets.push({
    id: "nasa-smap-level3-36km-v9",
    name: "NASA SMAP Level 3, 36 km, v9",
    status: "maintenance",
  });

  const validated = validateStatusData(data);

  assert.equal(validated.datasets[1].status, "unknown");
  assert.deepEqual(summarizeOverallStatus(validated), {
    status: "degraded",
    incidents: [{ name: "NASA SMAP Level 3, 36 km, v9", status: "unknown" }],
  });
});
