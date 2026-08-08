module.exports =
  process.env.PIPELINE_ASSETS_BASE ||
  (process.env.CF_PAGES_BRANCH && process.env.CF_PAGES_BRANCH !== "main"
    ? "/pipeline-staging/wxopticon"
    : "https://assets.dynamical.org/wxopticon");
