// Where the /status page reads the event log from. Overridable alongside
// STATUS_URL so the page can be previewed against local artifacts.
module.exports =
  process.env.STATUS_LOG_URL || "https://assets.dynamical.org/status";
