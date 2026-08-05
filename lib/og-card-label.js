// Section label for a generated social card — the short chip in the card
// header naming which part of the site a URL belongs to. Deliberately durable:
// nothing here can become false while a social platform caches a preview.

const LABELS = {
  "/": "weather + climate",
  "/about/": "about",
  "/sla/": "service level agreement",
  "/privacy/": "privacy",
  "/license/": "license",
};

const SECTIONS = [
  [/^\/status\/pipeline\/?$/, "data pipeline"],
  [/^\/status\/?$/, "system status"],
  [/^\/catalog\/[^/]+\/validation\/?/, "validation report"],
  [/^\/catalog\/models\/?/, "model archive"],
  [/^\/catalog\/?/, "data catalog"],
  [/^\/scorecard\/?/, "forecast evaluation"],
  [/^\/research\/?/, "research"],
  [/^\/updates\/?/, "dispatch"],
  [/^\/podcast\/?/, "weathering podcast"],
  [/^\/meetings\/?/, "steering committee"],
];

function cardLabel(url) {
  const pathname = new URL(url || "/", "https://dynamical.org").pathname;
  if (LABELS[pathname]) return LABELS[pathname];
  const section = SECTIONS.find(([pattern]) => pattern.test(pathname));
  return section ? section[1] : "weather + climate";
}

module.exports = { cardLabel };
