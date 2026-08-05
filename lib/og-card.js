// Build-time generator for 1200×630 Open Graph and Twitter cards.
//
// Satori lays out the card and outlines IBM Plex Mono text to SVG paths; sharp
// rasterizes the result to PNG. Everything on the card comes from the page it
// links to — section label, title, subtitle, thumbnail, URL — and nothing else:
// a preview that invents its own copy just repeats itself at every size. Card
// content is also deliberately durable, because social platforms may cache
// previews long after the underlying page changes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const satori = require("satori").default || require("satori");
const sharp = require("sharp");

const WIDTH = 1200;
const HEIGHT = 630;
const TEMPLATE_VERSION = "10";
const CACHE_DIR = path.join(__dirname, "..", ".cache", "og");

const FONT_DIR = path.join(__dirname, "fonts");
const FONTS = [
  {
    name: "IBM Plex Mono",
    data: fs.readFileSync(path.join(FONT_DIR, "IBMPlexMono-Regular.ttf")),
    weight: 400,
    style: "normal",
  },
  {
    name: "IBM Plex Mono",
    data: fs.readFileSync(path.join(FONT_DIR, "IBMPlexMono-Bold.ttf")),
    weight: 700,
    style: "normal",
  },
];

const ICON_SVG = fs
  .readFileSync(path.join(__dirname, "og-assets", "icon.svg"), "utf8")
  .replace('fill="currentColor"', 'fill="#111111"');
const ICON_DATA_URI =
  "data:image/svg+xml;base64," + Buffer.from(ICON_SVG).toString("base64");

const COLORS = {
  ink: "#111111",
  paper: "#ffffff",
  quiet: "#6b6b6b",
  wash: "#f1f1ed",
};

const FALLBACK_LABEL = "weather + climate";

const BORDER = 10;
const ARTWORK_PANEL_WIDTH = 360;
const COLUMN_PADDING_X = 46;
const SUBTITLE_FONT_SIZE = 19;
// Prose gets a readable measure even when no artwork panel narrows the column.
const SUBTITLE_MAX_WIDTH = 760;

// IBM Plex Mono advances every glyph by 600/1000 em, so a line's width is
// exactly its length × size × this — the wrap point is arithmetic here rather
// than something to discover in the rendered PNG.
const MONO_ADVANCE = 0.6;

// How many characters of subtitle fit on one line. A full dataset fact line
// reaches 62 characters, so the artwork panel is sized to leave 63 — that
// margin is why those lines stay whole. Narrow the column and the two-character
// orphan this was sized to avoid comes back. Exported for tooling that flags a
// wrap without rendering (lib/og-card-index.js).
function subtitleCharsPerLine(hasArtwork) {
  const column =
    WIDTH - 2 * BORDER - (hasArtwork ? ARTWORK_PANEL_WIDTH : 0) - 2 * COLUMN_PADDING_X;
  const width = Math.min(column, SUBTITLE_MAX_WIDTH);
  return Math.floor(width / (SUBTITLE_FONT_SIZE * MONO_ADVANCE));
}

// Small hyperscript helper avoids a JSX/transpile dependency.
function h(type, props, ...children) {
  const flat = children.flat();
  return flat.length
    ? { type, props: { ...props, children: flat } }
    : { type, props: { ...props } };
}

function titleFontSize(title) {
  const length = String(title || "").length;
  if (length <= 28) return 64;
  if (length <= 58) return 56;
  if (length <= 92) return 48;
  if (length <= 138) return 41;
  return 35;
}

// A fact line that does overflow — the multi-resolution GEFS one is 86
// characters — should break between facts, never inside one. Binding each
// fact's own spaces leaves the separators as the only breakable spaces, so
// "every 6h" moves to the next line whole and "0-240h: 0.25°, 246-840h: 0.5°"
// never splits at its comma. Prose has no separators and is left alone; its
// spaces have to stay breakable.
const SEPARATOR = " \u00B7 ";
function bindWithinFacts(subtitle) {
  const facts = String(subtitle || "").split(SEPARATOR);
  if (facts.length < 2) return subtitle;
  return facts.map((fact) => fact.replace(/ /g, "\u00A0")).join(SEPARATOR);
}

function displayUrl(url) {
  try {
    const parsed = new URL(url || "https://dynamical.org/");
    const value = `${parsed.hostname}${parsed.pathname}`;
    if (value.length <= 68) return value;
    return `${value.slice(0, 64)}...`;
  } catch {
    return "dynamical.org";
  }
}

function brand() {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center" } },
    h("img", { src: ICON_DATA_URI, width: 40, height: 45 }),
    h(
      "div",
      {
        style: {
          display: "flex",
          marginLeft: 17,
          fontSize: 27,
          fontWeight: 700,
          letterSpacing: -1,
        },
      },
      "dynamical.org",
    ),
  );
}

function header(label) {
  return h(
    "div",
    {
      style: {
        height: 92,
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 46px",
        borderBottom: `3px solid ${COLORS.ink}`,
      },
    },
    brand(),
    h(
      "div",
      {
        style: {
          display: "flex",
          backgroundColor: COLORS.ink,
          color: COLORS.paper,
          padding: "9px 14px",
          borderRadius: 3,
          fontSize: 17,
          fontWeight: 700,
          textTransform: "uppercase",
        },
      },
      label,
    ),
  );
}

function artworkPanel(artwork) {
  return h(
    "div",
    {
      style: {
        width: ARTWORK_PANEL_WIDTH,
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "34px 30px",
        borderLeft: `2px solid ${COLORS.ink}`,
        backgroundColor: COLORS.wash,
      },
    },
    // Width-only: satori derives the height from the image, so a dataset
    // thumbnail (4:3) and the podcast artwork (square) both keep their own
    // aspect rather than being center-cropped to a shared box. The panel is
    // 388px tall inside its padding, so artwork must be no taller than square.
    h("img", {
      src: artwork,
      width: ARTWORK_PANEL_WIDTH - 60,
      style: { border: `2px solid ${COLORS.ink}` },
    }),
  );
}

function body({ title, subtitle, artwork }) {
  return h(
    "div",
    {
      style: {
        flex: 1,
        minHeight: 0,
        display: "flex",
      },
    },
    h(
      "div",
      {
        style: {
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: `34px ${COLUMN_PADDING_X}px 36px`,
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            maxHeight: 292,
            overflow: "hidden",
            fontSize: titleFontSize(title),
            fontWeight: 700,
            lineHeight: 1.04,
            letterSpacing: -2,
          },
        },
        title || "dynamical.org",
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            maxWidth: SUBTITLE_MAX_WIDTH,
            maxHeight: 52,
            overflow: "hidden",
            marginTop: 20,
            color: COLORS.quiet,
            fontSize: SUBTITLE_FONT_SIZE,
            lineHeight: 1.35,
          },
        },
        bindWithinFacts(subtitle) || "Open, cloud-native weather data.",
      ),
    ),
    ...(artwork ? [artworkPanel(artwork)] : []),
  );
}

function footer(url) {
  return h(
    "div",
    {
      style: {
        height: 62,
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 46px",
        backgroundColor: COLORS.ink,
        color: COLORS.paper,
        fontSize: 15,
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          overflow: "hidden",
          whiteSpace: "nowrap",
        },
      },
      displayUrl(url),
    ),
  );
}

function richTemplate({ title, subtitle, url, label, artwork }) {
  return h(
    "div",
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.paper,
        color: COLORS.ink,
        fontFamily: "IBM Plex Mono",
        border: `${BORDER}px solid ${COLORS.ink}`,
      },
    },
    header(label || FALLBACK_LABEL),
    body({ title, subtitle, artwork }),
    footer(url),
  );
}

function cacheKey({ title, subtitle, url, label, artwork }) {
  return crypto
    .createHash("md5")
    .update(
      [
        TEMPLATE_VERSION,
        title || "",
        subtitle || "",
        url || "",
        label || FALLBACK_LABEL,
        artwork || "",
      ].join("\0"),
    )
    .digest("hex");
}

async function renderCard({ title, subtitle, url, label, artwork }) {
  const key = cacheKey({ title, subtitle, url, label, artwork });
  const cachePath = path.join(CACHE_DIR, `${key}.png`);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);

  const svg = await satori(
    richTemplate({ title, subtitle, url, label, artwork }),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
    },
  );
  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, png);
  return png;
}

module.exports = { renderCard, bindWithinFacts, subtitleCharsPerLine };
