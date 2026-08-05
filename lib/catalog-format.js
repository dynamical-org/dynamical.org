function abbreviateDuration(value) {
  const duration = value == null ? "" : String(value);
  const withExplicitCadence = duration.replace(
    /\bevery\s+(hour|minute)\b/gi,
    (_match, unit) => `every 1${unit.toLowerCase() === "hour" ? "h" : "m"}`,
  );

  return withExplicitCadence.replace(
    /(\d+(?:\.\d+)?)\s+(hours?|minutes?)\b/gi,
    (_match, amount, unit) =>
      `${Number(amount)}${unit.toLowerCase().startsWith("hour") ? "h" : "m"}`,
  );
}

// The one-line fact summary for a dataset: spatial domain, variable count,
// spatial resolution, then either the forecast horizon and init cadence
// (forecasts) or the record extent and step (analyses). Rendered on the catalog
// list and reused verbatim as the social-card subtitle.
function datasetFacts(entry) {
  const head = [
    String(entry.spatial_domain || "").replaceAll(
      "Continental United States",
      "CONUS",
    ),
    entry.optimization === "space"
      ? "all variables"
      : `${entry.variable_count} variables`,
    abbreviateDuration(
      String(entry.spatial_resolution || "")
        .replace(/\s*\(~[^)]*\)/g, "")
        .replaceAll(" degrees", "°"),
    ),
  ];

  if (entry.forecast_domain) {
    return [
      ...head,
      abbreviateDuration(
        String(entry.forecast_domain)
          .replaceAll("Forecast lead time ", "")
          .replaceAll(" ahead", ""),
      ),
      abbreviateDuration(
        String(entry.time_resolution || "").replaceAll(
          "Forecasts initialized ",
          "",
        ),
      ),
    ];
  }

  return [
    ...head,
    String(entry.time_domain || "").replace(/ \d{2}:\d{2}:\d{2}/g, ""),
    abbreviateDuration(entry.time_resolution),
  ];
}

// What a model page holds, counted the same way the page splits its lists:
// live forecasts and live analyses. Used as the model card's subtitle.
function modelFacts(datasets) {
  const live = datasets.filter((d) => d.status !== "deprecated");
  const forecasts = live.filter((d) => d.forecast_domain).length;
  const analyses = live.length - forecasts;

  return [
    ...(forecasts ? [`${forecasts} forecast${forecasts === 1 ? "" : "s"}`] : []),
    ...(analyses ? [`${analyses} analys${analyses === 1 ? "is" : "es"}`] : []),
  ];
}

module.exports = { abbreviateDuration, datasetFacts, modelFacts };
