const routes = [
  {
    legacyPath: "/noaa/gfs/forecast",
    datasetId: "noaa-gfs-forecast",
  },
  {
    legacyPath: "/noaa/gfs/analysis",
    datasetId: "noaa-gfs-analysis",
  },
  {
    legacyPath: "/noaa/gfs/analysis-hourly",
    datasetId: "noaa-gfs-analysis",
    note: "This retired four-variable archive is replaced by the current GFS analysis dataset.",
  },
  {
    legacyPath: "/noaa/gefs/forecast-35-day",
    datasetId: "noaa-gefs-forecast-35-day",
  },
  {
    legacyPath: "/noaa/gefs/analysis",
    datasetId: "noaa-gefs-analysis",
  },
  {
    legacyPath: "/noaa/hrrr/forecast-48-hour",
    datasetId: "noaa-hrrr-forecast-48-hour",
  },
  {
    legacyPath: "/noaa/hrrr/analysis",
    datasetId: "noaa-hrrr-analysis",
  },
  {
    legacyPath: "/noaa/mrms/conus-analysis-hourly",
    datasetId: "noaa-mrms-conus-analysis-hourly",
  },
  {
    legacyPath: "/ecmwf/ifs-ens/forecast-15-day-0-25-degree",
    datasetId: "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
  },
  {
    legacyPath: "/ecmwf/aifs-single/forecast",
    datasetId: "ecmwf-aifs-single-forecast",
  },
  {
    legacyPath: "/dwd/icon-eu/forecast-5-day",
    datasetId: "dwd-icon-eu-forecast-5-day",
  },
];

module.exports = {
  deprecationDate: "2026-04-24",
  sunset: "2026-09-01T00:00:00Z",
  sunsetDisplay: "August 31, 2026",
  path: "/migrate-from-zarr/",
  routes,
  affectedDatasetIds: Object.fromEntries(
    routes.map(({ datasetId }) => [datasetId, true]),
  ),
};
