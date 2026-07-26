function unavailable(label) {
  return { state: "unavailable", label, value: "unavailable" };
}

export function systemHealth(data) {
  if (!Array.isArray(data?.endpoints) || data.endpoints.length === 0) {
    return unavailable("systems");
  }
  const statuses = new Set(data.endpoints.map(({ status }) => status));
  if (statuses.has("down")) {
    return { state: "down", label: "systems", value: "disrupted" };
  }
  if ([...statuses].some((status) => status !== "operational")) {
    return { state: "degraded", label: "some systems", value: "degraded" };
  }
  return { state: "operational", label: "all systems", value: "operational" };
}

export function agencyHealth(advisories) {
  if (!Array.isArray(advisories)) return unavailable("weather agencies");
  if (advisories.length === 0) {
    return { state: "nominal", label: "weather agencies", value: "nominal" };
  }
  const agencies = [
    ...new Set(advisories.map(({ agency }) => agency.toUpperCase())),
  ];
  return {
    state: "advisory",
    label: "weather agencies",
    value: `${agencies.join(", ")} advisor${advisories.length === 1 ? "y" : "ies"}`,
  };
}

export function renderHealth(root, slot, health) {
  const item = root.querySelector(`[data-slot="${slot}"]`);
  if (!item) return;
  item.dataset.state = health.state;
  item.querySelector("[data-health-label]").textContent = health.label;
  item.querySelector("strong").textContent = health.value;
}
