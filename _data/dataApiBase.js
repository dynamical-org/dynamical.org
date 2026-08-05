// Where /api/ sends its live "run it" requests. Overridable so the page can be
// previewed against a locally running dynamical-api.
module.exports = process.env.DATA_API_BASE || "https://api.dynamical.org";
