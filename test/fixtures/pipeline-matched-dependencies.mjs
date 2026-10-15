// Synthetic matched-subset clocks; source horizons deliberately cover other files.
export function matchedDependencyFixtures() {
  const initTime = "2026-01-01T00:00:00Z";
  return [
    ["rrfs-forecast-sub-hourly", "rrfs-18h", [["f001", "1h", 1, 401], ["f006", "6h", 6, 406], ["forecast", "18h", 18, 418]]],
    ["rrfs-forecast-18-hour", "rrfs-18h", [["f000", "0h", 1, 400], ["f006", "6h", 7, 406], ["forecast", "18h", 19, 418]]],
    ["refs-forecast-3-hourly", "refs", [["f003", "3h", 1, 403], ["f006", "6h", 2, 406], ["f018", "18h", 6, 418], ["f048", "2d", 16, 448], ["forecast", "60h", 20, 460]]],
  ].map(([suffix, sourceSuffix, bands]) => {
    const sourceId = `external-noaa-${sourceSuffix}-aws`;
    const lags = [-10, 20, 0, -10, 20];
    const leadGroups = bands.map(([name, , , deadline], index) => ({
      name, status: "complete", latency_s: deadline - 300 + lags[index], deadline_s: deadline,
    }));
    const product = {
      id: `noaa-${suffix}-virtual`,
      row_label: "dynamical.org · virtual", source_label: null,
      source_product_id: sourceId, budget_after_source_s: 300,
      pipeline_lag: {
        status: "ready", basis: "matched_dependencies", source_ids: [sourceId], window_days: 365,
        window_start: initTime, window_end: "2026-01-01T01:00:00Z", generated_at: "2026-01-01T01:00:00Z",
        stats: { p50_s: -10, p95_s: -10, p99_s: -10, avg_s: -10, sample_init_count: 1, sample_day_count: 1 },
      },
      lead_group_stats: bands.map(([name, label, count]) => ({ name, label, leads_in_group: count })),
      recent_inits: [{ init_time: initTime, status: "complete", latency_s: leadGroups.at(-1).latency_s, pipeline_lag_s: -10, lead_groups: leadGroups }],
    };
    const source = {
      id: sourceId, source_label: "AWS", row_label: "AWS",
      lead_group_stats: bands.map(([name, label, count]) => ({
        name, label, leads_in_group: suffix === "rrfs-forecast-18-hour" ? count : count + 1,
      })),
      recent_inits: [{ init_time: initTime, status: "complete", lead_groups: bands.map(([name]) => ({
        name, status: "complete", latency_s: 900,
      })) }],
    };
    return { product, source, expectedLags: lags.slice(0, bands.length).map(lag => lag < 0 ? "−10s" : lag === 0 ? "0s" : "20s") };
  });
}
