// Where the /status page fetches its public feed. Overridable so the page can be
// previewed against test/fixtures/status.json before the publisher is deployed.
module.exports =
  process.env.STATUS_URL || "https://assets.dynamical.org/status/status.json";
