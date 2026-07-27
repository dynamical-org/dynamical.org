// Durable context for generated social cards. These labels describe what a
// visitor will find at a URL; they deliberately avoid values that can become
// false while a social platform caches a preview.

const CONTEXTS = {
  home: {
    label: "weather + climate",
    action: "Explore the work",
    items: [
      { name: "data", detail: "open cloud-native catalog" },
      { name: "evaluation", detail: "forecast scorecard" },
      { name: "research", detail: "methods + findings" },
    ],
  },
  catalog: {
    label: "data catalog",
    action: "Explore the catalog",
    items: [
      { name: "discover", detail: "forecast + analysis data" },
      { name: "access", detail: "Zarr + Icechunk" },
      { name: "verify", detail: "metadata + validation" },
    ],
  },
  model: {
    label: "model archive",
    action: "Explore model data",
    items: [
      { name: "datasets", detail: "forecast + analysis" },
      { name: "access", detail: "cloud-optimized arrays" },
      { name: "metadata", detail: "versions + provenance" },
    ],
  },
  validation: {
    label: "validation report",
    action: "Review the checks",
    items: [
      { name: "completeness", detail: "expected fields" },
      { name: "coverage", detail: "spatial + temporal" },
      { name: "availability", detail: "published assets" },
    ],
  },
  scorecard: {
    label: "forecast evaluation",
    action: "Explore the scorecard",
    items: [
      { name: "compare", detail: "forecast models" },
      { name: "verify", detail: "station observations" },
      { name: "inspect", detail: "transparent metrics" },
    ],
  },
  research: {
    label: "research",
    action: "Read the research",
    items: [
      { name: "question", detail: "weather data systems" },
      { name: "method", detail: "technical detail" },
      { name: "evidence", detail: "measured behavior" },
    ],
  },
  updates: {
    label: "dispatch",
    action: "Read the update",
    items: [
      { name: "product", detail: "catalog + tools" },
      { name: "research", detail: "findings + methods" },
      { name: "operations", detail: "service changes" },
    ],
  },
  podcast: {
    label: "weathering podcast",
    action: "Listen to the episode",
    items: [
      { name: "conversations", detail: "weather + climate" },
      { name: "practice", detail: "decisions under uncertainty" },
      { name: "format", detail: "the Weathering podcast" },
    ],
  },
  meetings: {
    label: "steering committee",
    action: "Read the notes",
    items: [
      { name: "agenda", detail: "upcoming work" },
      { name: "notes", detail: "decisions + actions" },
      { name: "participation", detail: "open steering committee" },
    ],
  },
  status: {
    label: "system status",
    action: "Open for current conditions",
    items: [
      { name: "availability", detail: "service reachability" },
      { name: "incidents", detail: "active + resolved events" },
      { name: "history", detail: "rolling 90-day record" },
    ],
  },
  pipeline: {
    label: "data pipeline",
    action: "Open the live pipeline",
    items: [
      { name: "source runs", detail: "forecast arrival" },
      { name: "latency", detail: "expected delivery" },
      { name: "advisories", detail: "upstream notices" },
    ],
  },
  about: {
    label: "about",
    action: "Meet dynamical",
    items: [
      { name: "mission", detail: "public-interest infrastructure" },
      { name: "work", detail: "data + evaluation" },
      { name: "structure", detail: "lab + community" },
    ],
  },
  sla: {
    label: "service level agreement",
    action: "Read the commitments",
    items: [
      { name: "availability", detail: "product reads" },
      { name: "delivery", detail: "publication targets" },
      { name: "support", detail: "response terms" },
    ],
  },
  privacy: {
    label: "privacy",
    action: "Read the policy",
    items: [
      { name: "collection", detail: "information we receive" },
      { name: "use", detail: "how information helps" },
      { name: "choices", detail: "controls + contact" },
    ],
  },
  license: {
    label: "license",
    action: "Read the terms",
    items: [
      { name: "reuse", detail: "permissions" },
      { name: "credit", detail: "attribution" },
      { name: "terms", detail: "conditions" },
    ],
  },
  generic: {
    label: "weather + climate",
    action: "Explore dynamical.org",
    items: [
      { name: "data", detail: "open infrastructure" },
      { name: "research", detail: "methods + findings" },
      { name: "operations", detail: "status + reliability" },
    ],
  },
};

function cardContext(url) {
  const pathname = new URL(url || "/", "https://dynamical.org").pathname;
  if (pathname === "/") return CONTEXTS.home;
  if (/^\/status\/pipeline\/?$/.test(pathname)) return CONTEXTS.pipeline;
  if (/^\/status\/?$/.test(pathname)) return CONTEXTS.status;
  if (/^\/catalog\/[^/]+\/validation\/?/.test(pathname)) {
    return CONTEXTS.validation;
  }
  if (/^\/catalog\/models\/?/.test(pathname)) return CONTEXTS.model;
  if (/^\/catalog\/?/.test(pathname)) return CONTEXTS.catalog;
  if (/^\/scorecard\/?/.test(pathname)) return CONTEXTS.scorecard;
  if (/^\/research\/?/.test(pathname)) return CONTEXTS.research;
  if (/^\/updates\/?/.test(pathname)) return CONTEXTS.updates;
  if (/^\/podcast\/?/.test(pathname)) return CONTEXTS.podcast;
  if (/^\/meetings\/?/.test(pathname)) return CONTEXTS.meetings;
  if (pathname === "/about/") return CONTEXTS.about;
  if (pathname === "/sla/") return CONTEXTS.sla;
  if (pathname === "/privacy/") return CONTEXTS.privacy;
  if (pathname === "/license/") return CONTEXTS.license;
  return CONTEXTS.generic;
}

module.exports = { cardContext };
