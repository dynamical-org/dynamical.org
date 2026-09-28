// Where each catalog dataset is also listed, keyed by catalog id. Catalog pages
// link only the platforms named here, so leave a platform out until its listing
// is live — never fill in a URL by pattern.
//
// Full sweep 2026-09-28: every URL loads and names its dataset (evidence and the
// known gaps are in dynamical-org/dynamical.org#253). Move this date only after
// rechecking every entry. Sources, when adding or rechecking:
// - earthmover: the dynamical.org cards on https://app.earthmover.io/marketplace
//   (no public listing API found). A missing id renders "Listing Not Found".
// - source_coop: https://source.coop/api/v1/products/dynamical — match a product to
//   the catalog id by its mirror prefix, not its product id (the 46-day IFS ENS
//   products drop "forecast").
// - aws: the model's awslabs/open-data-registry datasets/dynamical-<model>.yaml,
//   which must list https://dynamical.org/catalog/<id>/. The registry page is per model.
module.exports = {
  "noaa-gfs-analysis": {
    earthmover: "https://app.earthmover.io/marketplace/698e959a27b60023f8d1d478",
    source_coop: "https://source.coop/dynamical/noaa-gfs-analysis",
    aws: "https://registry.opendata.aws/dynamical-noaa-gfs/",
  },
  "noaa-gfs-forecast": {
    earthmover: "https://app.earthmover.io/marketplace/697056d6fe533c1523faf4ca",
    source_coop: "https://source.coop/dynamical/noaa-gfs-forecast",
    aws: "https://registry.opendata.aws/dynamical-noaa-gfs/",
  },
  "noaa-gefs-forecast-35-day": {
    earthmover: "https://app.earthmover.io/marketplace/697055dd0ddd53afe1329ca7",
    source_coop: "https://source.coop/dynamical/noaa-gefs-forecast-35-day",
    aws: "https://registry.opendata.aws/dynamical-noaa-gefs/",
  },
  "noaa-gefs-analysis": {
    earthmover: "https://app.earthmover.io/marketplace/6970566255e09e23d5bcbbc0",
    source_coop: "https://source.coop/dynamical/noaa-gefs-analysis",
    aws: "https://registry.opendata.aws/dynamical-noaa-gefs/",
  },
  "noaa-hrrr-forecast-18-hour-virtual": {
    earthmover: "https://app.earthmover.io/marketplace/6a735ce39e5d7646dc8c52cd",
    source_coop: "https://source.coop/dynamical/noaa-hrrr-forecast-18-hour-virtual",
    aws: "https://registry.opendata.aws/dynamical-noaa-hrrr/",
  },
  "noaa-hrrr-forecast-48-hour": {
    earthmover: "https://app.earthmover.io/marketplace/6970586155e09e23d5bcbbf2",
    source_coop: "https://source.coop/dynamical/noaa-hrrr-forecast-48-hour",
    aws: "https://registry.opendata.aws/dynamical-noaa-hrrr/",
  },
  "noaa-hrrr-forecast-48-hour-virtual": {
    earthmover: "https://app.earthmover.io/marketplace/6a591f63810bac7ca3d77def",
    source_coop: "https://source.coop/dynamical/noaa-hrrr-forecast-48-hour-virtual",
    aws: "https://registry.opendata.aws/dynamical-noaa-hrrr/",
  },
  "noaa-hrrr-analysis": {
    earthmover: "https://app.earthmover.io/marketplace/6970589fe0cf33d466e36682",
    aws: "https://registry.opendata.aws/dynamical-noaa-hrrr/",
  },
  "noaa-hrrr-analysis-virtual": {
    earthmover: "https://app.earthmover.io/marketplace/6a97156057cc94d6d159c0ea",
    source_coop: "https://source.coop/dynamical/noaa-hrrr-analysis-virtual",
    aws: "https://registry.opendata.aws/dynamical-noaa-hrrr/",
  },
  "noaa-mrms-conus-analysis-hourly": {
    earthmover: "https://app.earthmover.io/marketplace/69b17d6d9b47e3348aeb99dc",
    source_coop: "https://source.coop/dynamical/noaa-mrms-conus-analysis-hourly",
    aws: "https://registry.opendata.aws/dynamical-noaa-mrms/",
  },
  "ecmwf-aifs-single-forecast": {
    earthmover: "https://app.earthmover.io/marketplace/69cad4f4209facf5e7b737ac",
    source_coop: "https://source.coop/dynamical/ecmwf-aifs-single-forecast",
    aws: "https://registry.opendata.aws/dynamical-ecmwf-aifs-single/",
  },
  "ecmwf-aifs-single-forecast-virtual": {
    earthmover: "https://app.earthmover.io/marketplace/6aba9885a0d400265b871f84",
    source_coop: "https://source.coop/dynamical/ecmwf-aifs-single-forecast-virtual",
    aws: "https://registry.opendata.aws/dynamical-ecmwf-aifs-single/",
  },
  "ecmwf-aifs-ens-forecast": {
    earthmover: "https://app.earthmover.io/marketplace/6a10729e8a69e6bcaeae0f90",
    source_coop: "https://source.coop/dynamical/ecmwf-aifs-ens-forecast",
    aws: "https://registry.opendata.aws/dynamical-ecmwf-aifs-ens/",
  },
  "ecmwf-ifs-ens-forecast-15-day-0-25-degree": {
    earthmover: "https://app.earthmover.io/marketplace/6970578f0ddd53afe1329ccb",
    source_coop: "https://source.coop/dynamical/ecmwf-ifs-ens-forecast-15-day-0-25-degree",
    aws: "https://registry.opendata.aws/dynamical-ecmwf-ifs-ens/",
  },
  "ecmwf-ifs-ens-forecast-46-day-daily-1-5-degree": {
    earthmover: "https://app.earthmover.io/marketplace/6ab40994761cf0c365482acc",
    source_coop: "https://source.coop/dynamical/ecmwf-ifs-ens-46-day-daily-1-5-degree",
    aws: "https://registry.opendata.aws/dynamical-ecmwf-ifs-ens/",
  },
  "ecmwf-ifs-ens-forecast-46-day-6-hourly-1-5-degree": {
    earthmover: "https://app.earthmover.io/marketplace/6ab413e28d0664cded8d4c84",
    source_coop: "https://source.coop/dynamical/ecmwf-ifs-ens-46-day-6-hourly-1-5-degree",
    aws: "https://registry.opendata.aws/dynamical-ecmwf-ifs-ens/",
  },
  "dwd-icon-eu-forecast-5-day": {
    earthmover: "https://app.earthmover.io/marketplace/69eae67968ef2387158671a1",
    source_coop: "https://source.coop/dynamical/dwd-icon-eu-forecast-5-day",
    aws: "https://registry.opendata.aws/dynamical-dwd-icon-eu/",
  },
  "nasa-imerg-analysis-early": {
    earthmover: "https://app.earthmover.io/marketplace/6a66c1bdcc4cfeb1baa60d09",
    source_coop: "https://source.coop/dynamical/nasa-imerg-analysis-early",
    aws: "https://registry.opendata.aws/dynamical-nasa-imerg/",
  },
  "nasa-imerg-analysis-late": {
    earthmover: "https://app.earthmover.io/marketplace/6a66c1f0d47dd72777c2f833",
    source_coop: "https://source.coop/dynamical/nasa-imerg-analysis-late",
    aws: "https://registry.opendata.aws/dynamical-nasa-imerg/",
  },
  "eccc-hrdps-forecast": {
    earthmover: "https://app.earthmover.io/marketplace/6a9716dc243cda5a26c7f728",
    source_coop: "https://source.coop/dynamical/eccc-hrdps-forecast",
    aws: "https://registry.opendata.aws/dynamical-eccc-hrdps/",
  },
};
