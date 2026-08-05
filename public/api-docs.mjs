// Live "run it" runners for /api/. Every request goes to the public data API at
// the base the page carries in `data-api-base`, so previewing against a local
// dynamical-api is an env var (DATA_API_BASE) rather than an edit here.
//
// These are credential-free public reads: no cookie, no Authorization header,
// which is what lets the API answer any origin with `Allow-Origin: *`.

const HOUR_MS = 3600 * 1000;

/** An hour-aligned ISO-8601 instant with a trailing Z, `hoursAgo` before now. */
function hourFloorIso(hoursAgo) {
  const stamp = Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS;
  return new Date(stamp).toISOString().replace(".000Z", "Z");
}

/** The requests behind each button, keyed by its `data-try` value. A request is
    `{method, path, body}`; `follow` builds a second request from the first
    response, which is how the canonical-link example works. */
const REQUESTS = {
  products: () => ({ method: "GET", path: "/v1/data-products" }),
  product: () => ({ method: "GET", path: "/v1/data-products/noaa-gfs-forecast" }),
  runs: () => ({
    method: "GET",
    path: "/v1/forecasts/runs?dataProductId=noaa-gfs-forecast&limit=3",
  }),
  // No queryId here even though the reference documents one: the deployed API
  // still rejects unknown fields, so a button that sent it would 422 until the
  // next `modal deploy`.
  forecast: () => ({
    method: "POST",
    path: "/v1/forecasts",
    body: {
      queries: [
        {
          dataProductId: "noaa-gfs-forecast",
          location: { latitude: 41.88, longitude: -87.63 },
          maxLeadTimeHours: 6,
          variables: ["temperature_2m", "precipitation_surface"],
        },
      ],
    },
  }),
  ensemble: () => ({
    method: "POST",
    path: "/v1/forecasts",
    body: {
      queries: [
        {
          dataProductId: "noaa-gefs-forecast-35-day",
          location: { latitude: 41.88, longitude: -87.63 },
          maxLeadTimeHours: 6,
          variables: ["temperature_2m"],
        },
      ],
    },
  }),
  // The analysis window is computed at click time: a date fixed in the page
  // would fall off the end of the published record.
  analysis: () => ({
    method: "POST",
    path: "/v1/analyses",
    body: {
      queries: [
        {
          dataProductId: "noaa-mrms-conus-analysis-hourly",
          location: { latitude: 41.88, longitude: -87.63 },
          startTime: hourFloorIso(12),
          endTime: hourFloorIso(6),
          variables: ["precipitation_surface"],
        },
      ],
    },
  }),
  // Two requests: a point query, then the immutable canonical link it returned.
  canonical: () => ({
    ...REQUESTS.forecast(),
    follow: (payload) => {
      const link = payload?.results?.[0]?.forecasts?.[0]?.links?.canonical;
      return link ? { method: "GET", path: link } : null;
    },
  }),
};

function requestLine(request) {
  if (request.method === "GET") {
    return `${request.method} ${request.path}`;
  }
  return `${request.method} ${request.path}\n${JSON.stringify(request.body)}`;
}

async function send(base, request) {
  const started = performance.now();
  const response = await fetch(base + request.path, {
    method: request.method,
    headers: request.body ? { "content-type": "application/json" } : undefined,
    body: request.body ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    elapsedMs: Math.round(performance.now() - started),
    // Readable cross-origin only because the API exposes them; see /api/#headers.
    workUnits: response.headers.get("x-dynamical-work-units"),
    datasetCache: response.headers.get("x-dynamical-dataset-cache"),
    payload,
    text,
  };
}

/** `HTTP 200 · 412 ms · 14 work units · dataset cache hit` */
function resultSummary(result) {
  const parts = [`HTTP ${result.status}`, `${result.elapsedMs} ms`];
  if (result.workUnits) {
    parts.push(`${result.workUnits} work units`);
  }
  if (result.datasetCache && result.datasetCache !== "unknown") {
    parts.push(`dataset cache ${result.datasetCache}`);
  }
  return parts.join(" · ");
}

async function run(base, button, status, output) {
  const build = REQUESTS[button.dataset.try];
  if (!build) {
    return;
  }
  button.disabled = true;
  status.classList.remove("failed");
  status.textContent = "running…";
  try {
    const request = build();
    const result = await send(base, request);
    const blocks = [
      `$ ${requestLine(request)}`,
      result.payload === null ? result.text : JSON.stringify(result.payload, null, 2),
    ];
    let summary = resultSummary(result);
    const followUp = result.ok && request.follow ? request.follow(result.payload) : null;
    if (followUp) {
      const second = await send(base, followUp);
      blocks.push(`$ ${requestLine(followUp)}`);
      blocks.push(second.payload === null ? second.text : JSON.stringify(second.payload, null, 2));
      summary = `${summary} → ${resultSummary(second)}`;
    }
    output.textContent = blocks.join("\n\n");
    output.hidden = false;
    status.textContent = summary;
    status.classList.toggle("failed", !result.ok);
    window.track("api_docs_try_it", { request: button.dataset.try, status: result.status });
  } catch (error) {
    // A network-level failure never reaches the summary path above, so surface
    // it in place rather than leaving the button looking idle.
    status.textContent = `request failed: ${error}`;
    status.classList.add("failed");
  } finally {
    button.disabled = false;
  }
}

const page = document.getElementById("api-docs");
const base = page.dataset.apiBase.replace(/\/$/, "");
for (const button of page.querySelectorAll("button[data-try]")) {
  const block = button.closest(".try");
  const status = block.querySelector(".try-status");
  const output = block.nextElementSibling;
  button.addEventListener("click", () => run(base, button, status, output));
}
