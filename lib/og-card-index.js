// Contact sheet for the generated social cards, written by the same
// eleventy.after hook that renders them — so it lists exactly the cards the
// build produced, including pages that opt out of collections (e.g. /sla).
// Never written on a production build; see .eleventy.js.

const { subtitleCharsPerLine } = require("./og-card.js");

const escapeHtml = (value) =>
  String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// What's worth catching by eye on a card: prose clipped to an ellipsis, a
// missing subtitle (the card falls back to generic copy), or a title long
// enough that titleFontSize() has dropped it to its smallest tier.
//
// A fact line is meant to sit on one line, so flag it if it has outgrown the
// room the card leaves — a new dataset with a longer domain or resolution would
// otherwise start wrapping unnoticed. Prose is expected to wrap and isn't
// flagged for it.
function flags(card) {
  const isFactLine = card.subtitle.includes(" · ");
  const wraps =
    isFactLine && card.subtitle.length > subtitleCharsPerLine(card.hasArtwork);
  return [
    ...(wraps ? ["fact line wraps"] : []),
    ...(card.subtitle.endsWith("…") ? ["truncated"] : []),
    ...(card.subtitle ? [] : ["no subtitle"]),
    ...(card.title.length > 138 ? ["very long title"] : []),
  ];
}

function cardItem(card) {
  const issues = flags(card);
  return `      <li${issues.length ? ' class="flagged"' : ""}>
        <a href="/assets/og/${escapeHtml(card.slug)}.png"><img src="/assets/og/${escapeHtml(card.slug)}.png" alt="Social card for ${escapeHtml(card.title)}" width="1200" height="630" loading="lazy"/></a>
        <div>
          <p><a href="${escapeHtml(card.url)}">${escapeHtml(card.slug)}</a>${card.hasArtwork ? " · artwork" : ""}${issues.length ? ` · <mark>${issues.map(escapeHtml).join(" · ")}</mark>` : ""}</p>
          <p><b>${escapeHtml(card.title)}</b> <small>${card.title.length}</small></p>
          <p>${escapeHtml(card.subtitle) || "<i>none</i>"} <small>${card.subtitle.length}</small></p>
        </div>
      </li>`;
}

function renderCardIndex(cards) {
  const sorted = [...cards].sort(
    (a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug),
  );
  const labels = [...new Set(sorted.map((c) => c.label))];
  const flagged = sorted.filter((c) => flags(c).length);

  const sections = labels
    .map((label) => {
      const group = sorted.filter((c) => c.label === label);
      return `    <h2 id="${escapeHtml(label.replace(/\W+/g, "-"))}">${escapeHtml(label)} <small>${group.length}</small></h2>
    <ul>
${group.map(cardItem).join("\n")}
    </ul>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <meta name="robots" content="noindex, nofollow"/>
    <title>social cards — dynamical.org</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0 auto; padding: 2rem 1rem 6rem; max-width: 70rem; font: 14px/1.5 ui-monospace, "IBM Plex Mono", monospace; }
      h1 { margin: 0 0 0.5rem; font-size: 1.4rem; }
      h2 { margin: 3rem 0 1rem; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }
      nav { margin-top: 1.5rem; }
      nav a:not(:last-of-type)::after { content: " · "; }
      ul { margin: 0; padding: 0; list-style: none; }
      li { display: flex; gap: 1.5rem; align-items: flex-start; padding: 1.5rem 0; border-top: 1px solid; }
      li.flagged { padding-left: 1rem; border-left: 3px solid; }
      img { width: 30rem; max-width: 45vw; height: auto; border: 1px solid; }
      div { min-width: 0; }
      p { margin: 0 0 0.5rem; overflow-wrap: anywhere; }
      p:last-child { margin: 0; }
      small { opacity: 0.5; }
      mark { background: none; font-weight: 700; }
      @media (max-width: 45rem) { li { display: block; } img { width: 100%; max-width: none; margin-bottom: 1rem; } }
    </style>
  </head>
  <body>
    <h1>social cards <small>${sorted.length}</small></h1>
    <p>Every card this build generated, with the title and subtitle it was given.
      ${flagged.length} flagged. Regenerate by rebuilding; this page is not published from <code>main</code>.</p>
    <nav>${labels
      .map(
        (label) =>
          `<a href="#${escapeHtml(label.replace(/\W+/g, "-"))}">${escapeHtml(label)}</a>`,
      )
      .join("")}</nav>
${sections}
  </body>
</html>
`;
}

module.exports = { renderCardIndex };
