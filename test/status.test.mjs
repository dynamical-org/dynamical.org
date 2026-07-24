import assert from "node:assert/strict";
import test from "node:test";

import {
  isStatusDataStale,
  partitionEndpoints,
  summarizeOverallStatus,
  validateStatusData,
} from "../public/status.mjs";

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
      group: "platform",
      status: "operational",
      uptime_90d: 99.9,
    },
  ],
};

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

test("separates platform uptime from upstream availability", () => {
  const endpoints = [
    operationalData.endpoints[0],
    {
      id: "noaa-nomads",
      name: "NOAA NOMADS",
      group: "upstream",
      status: "operational",
      uptime_90d: 99.8,
    },
  ];

  assert.deepEqual(partitionEndpoints(endpoints), {
    platform: [endpoints[0]],
    upstream: [endpoints[1]],
  });
});

test("rejects malformed or non-public status values", () => {
  const data = structuredClone(operationalData);
  data.datasets[0].status = "unknown";

  assert.throws(() => validateStatusData(data), /invalid status entry/i);
  assert.throws(() => validateStatusData({}), /invalid status document/i);

  data.datasets[0].status = "operational";
  delete data.endpoints[0].group;
  assert.throws(() => validateStatusData(data), /invalid endpoint/i);
});
