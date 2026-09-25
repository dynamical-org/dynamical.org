// The #276 contract: each grain waits for its own source completion evidence.
export function sourceBudgetProduct(base, hours = 48) {
  return {
    ...base,
    id: `noaa-hrrr-forecast-${hours}-hour-virtual`,
    budget_after_source_s: 600,
    source_product_id: hours === 18 ? "external-noaa-hrrr-18h-aws" : "external-noaa-hrrr-aws",
    timing_baseline: { status: "established", method: "source_budget", history_days: 30, required_history_days: 0 },
    latency_stats: { ...base.latency_stats, delayed_threshold_s: null },
    lead_groups: [{ name: "f018", label: "18h", max_lead_hours: 18 }],
    lead_group_stats: [{ name: "f018", delayed_threshold_s: null }],
    recent_inits: [
      { init_time: "2026-07-25T00:00:00Z", status: "complete", latency_s: 4000, deadline_s: 4200, timing: "on_time",
        lead_groups: [{ name: "f018", status: "complete", latency_s: 3800, deadline_s: 3600, timing: "delayed" }] },
      { init_time: "2026-07-25T06:00:00Z", status: "complete", latency_s: 4000, deadline_s: 4500, timing: "on_time",
        lead_groups: [{ name: "f018", status: "complete", latency_s: 3800, deadline_s: null }] },
      { init_time: "2026-07-25T12:00:00Z", status: "pending", deadline_s: null,
        lead_groups: [{ name: "f018", status: "pending", deadline_s: null }] },
    ],
  };
}
