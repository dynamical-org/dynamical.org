// The requests /api/ documents, and the pure formatting that turns each one into
// the curl command and the response JSON the page shows.
//
// Requests and responses come from the same definition, so the command on the
// page is the command that produced the payload below it — they cannot drift
// apart the way two hand-written blocks can. The fetching lives in
// _data/apiExamples.js; everything here is pure and unit-tested.

const HOUR_MS = 3600 * 1000;

/** An hour-aligned ISO-8601 instant with a trailing Z, `hoursAgo` before `now`. */
function hourFloorIso(hoursAgo, now = Date.now()) {
  const stamp = Math.floor((now - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS;
  return new Date(stamp).toISOString().replace(".000Z", "Z");
}

// `build(now)` so the analysis window is computed per build rather than frozen
// into the file; `follow` chains a second request built from the first response,
// which is how the canonical-link example stays valid as snapshots roll forward.
const REQUESTS = {
  // The shortest request that does something useful: latest run, one location,
  // one variable, every lead time the product publishes.
  forecast: {
    build: () => ({
      method: "POST",
      path: "/v1/forecasts",
      body: {
        queries: [
          {
            dataProductId: "noaa-gfs-forecast",
            location: { latitude: 41.88, longitude: -87.63 },
            variables: ["temperature_2m"],
          },
        ],
      },
    }),
  },
  products: {
    build: () => ({ method: "GET", path: "/v1/data-products" }),
    objectArrayLimit: 2,
  },
  product: {
    build: () => ({ method: "GET", path: "/v1/data-products/noaa-gfs-forecast" }),
    // 25 variables would bury the shape of the response.
    objectLimits: { variables: 1 },
  },
  runs: {
    build: () => ({
      method: "GET",
      path: "/v1/forecasts/runs?dataProductId=noaa-gfs-forecast&limit=3",
    }),
    objectArrayLimit: 3,
  },
  analysis: {
    build: (now) => ({
      method: "POST",
      path: "/v1/analyses",
      body: {
        queries: [
          {
            dataProductId: "noaa-mrms-conus-analysis-hourly",
            location: { latitude: 41.88, longitude: -87.63 },
            startTime: hourFloorIso(12, now),
            endTime: hourFloorIso(6, now),
            variables: ["precipitation_surface"],
          },
        ],
      },
    }),
  },
  // Trimmed deliberately: 31 members over a 35-day horizon is the case the
  // surrounding prose warns about.
  ensemble: {
    build: () => ({
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
  },
  // A point query, then the immutable canonical link it handed back.
  canonical: {
    build: (now) => REQUESTS.forecast.build(now),
    follow: (payload) => {
      const link = payload?.results?.[0]?.forecasts?.[0]?.links?.canonical;
      return link ? { method: "GET", path: link } : null;
    },
  },
};

/** The copy-pasteable form of a request, against `base`. */
function curlFor(base, request) {
  const url = `${base}${request.path}`;
  if (request.method === "GET") {
    return `curl '${url}'`;
  }
  // Compact, not pretty-printed: the point of the quickstart is that the request
  // is short, and a 16-line expansion of three fields argues the opposite. The
  // frame scrolls horizontally, and the line pastes into a shell as-is.
  return [
    `curl -X ${request.method} '${url}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify(request.body)}'`,
  ].join("\n");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A display copy of `payload` with long runs collapsed, so a 209-value axis or a
 * 31-member ensemble still reads as a shape. Truncation is always announced in
 * place, so a reader can tell an elision from the real end of an array.
 */
function elide(payload, options = {}) {
  const { arrayLimit = 3, objectArrayLimit = 2, objectLimits = {} } = options;

  const walk = (value) => {
    if (Array.isArray(value)) {
      const structured = value.some((item) => item !== null && typeof item === "object");
      const limit = structured ? objectArrayLimit : arrayLimit;
      if (value.length <= limit) {
        return value.map(walk);
      }
      const kept = value.slice(0, limit).map(walk);
      const last = value[value.length - 1];
      return [
        ...kept,
        structured
          ? `… ${value.length} entries`
          : `… ${value.length} values, last ${String(last)}`,
      ];
    }
    if (isPlainObject(value)) {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        const limit = objectLimits[key];
        if (limit !== undefined && isPlainObject(item)) {
          const entries = Object.entries(item);
          out[key] = {};
          for (const [name, child] of entries.slice(0, limit)) {
            out[key][name] = walk(child);
          }
          if (entries.length > limit) {
            out[key]["…"] = `${entries.length - limit} more`;
          }
          continue;
        }
        out[key] = walk(item);
      }
      return out;
    }
    return value;
  };

  return walk(payload);
}

/** The response JSON as the page prints it. */
function formatJson(payload, options) {
  return JSON.stringify(elide(payload, options), null, 2);
}

/**
 * What a failed request tells us, from the error eleventy-fetch throws: its
 * `cause` is the Response when the API answered, and the underlying error when it
 * did not. It says what was observed, not why — a refusal is where drift shows up,
 * but a WAF change can refuse too, and the body is printed so a reader can tell.
 *
 * - `refused`: the API answered 4xx. Asking again will get the same answer.
 * - `failed`: a 5xx, a 408 or 429, a timeout, or no connection. Worth one retry,
 *   and a reason to rebuild later rather than to change anything here.
 * - `other`: anything else, such as a 200 whose body was not JSON.
 */
function classifyFailure(error) {
  const cause = error?.cause;
  if (typeof cause?.status === "number") {
    const transient = cause.status >= 500 || cause.status === 408 || cause.status === 429;
    return transient || cause.status < 400 ? "failed" : "refused";
  }
  // Node's fetch rejects with a TypeError for network failures, and AbortSignal
  // timeouts are named for what they are.
  if (["TypeError", "AbortError", "TimeoutError"].includes(cause?.name)) return "failed";
  return "other";
}

/** A line of detail for a failure: the API's own `detail` where it sent one. */
async function failureDetail(error) {
  const cause = error?.cause;
  if (typeof cause?.status !== "number") {
    // "fetch failed" alone says nothing; the reason (ECONNREFUSED, a DNS miss) is
    // one cause further down.
    const reason = cause?.cause?.code || cause?.cause?.message;
    const message = cause?.message || error?.message;
    return reason ? `${message} (${reason})` : message;
  }
  let body = "";
  try {
    body = (await cause.text()).trim();
  } catch {
    // Already read, or the connection dropped mid-body; the status still stands.
  }
  try {
    const { detail } = JSON.parse(body);
    if (detail !== undefined) {
      body = typeof detail === "string" ? detail : JSON.stringify(detail);
    }
  } catch {
    // Not JSON — an HTML error page from the edge, say. Show the start of it.
  }
  return body ? `HTTP ${cause.status}: ${body.slice(0, 500)}` : `HTTP ${cause.status}`;
}

module.exports = {
  REQUESTS,
  classifyFailure,
  curlFor,
  elide,
  failureDetail,
  formatJson,
  hourFloorIso,
};
