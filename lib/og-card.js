// Build-time generator for 1200×630 Open Graph and Twitter cards.
//
// Satori lays out an adaptive, section-aware card and outlines IBM Plex Mono
// text to SVG paths; sharp rasterizes the result to PNG. Card content is
// deliberately durable because social platforms may cache previews long after
// the underlying page changes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const satori = require("satori").default || require("satori");
const sharp = require("sharp");

const WIDTH = 1200;
const HEIGHT = 630;
const TEMPLATE_VERSION = "8";
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
  rule: "#d6d6d6",
  wash: "#f1f1ed",
};

const FALLBACK_CONTEXT = {
  label: "weather + climate",
  action: "Explore dynamical.org",
  items: [
    { name: "data", detail: "open infrastructure" },
    { name: "research", detail: "methods + findings" },
    { name: "operations", detail: "status + reliability" },
  ],
};

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

function header(context) {
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
      context.label,
    ),
  );
}

function featureRow(item, index, compact) {
  return h(
    "div",
    {
      style: {
        minHeight: compact ? 68 : 105,
        display: "flex",
        alignItems: "center",
        borderTop: index === 0 ? "0" : `1px solid ${COLORS.rule}`,
      },
    },
    h(
      "div",
      {
        style: {
          width: compact ? 36 : 43,
          height: compact ? 28 : 34,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginRight: compact ? 13 : 17,
          border: `1px solid ${COLORS.ink}`,
          fontSize: compact ? 12 : 14,
          fontWeight: 700,
        },
      },
      String(index + 1).padStart(2, "0"),
    ),
    h(
      "div",
      {
        style: {
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            fontSize: compact ? 15 : 18,
            fontWeight: 700,
            lineHeight: 1.15,
          },
        },
        item.name,
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: compact ? 3 : 6,
            color: COLORS.quiet,
            fontSize: compact ? 12 : 14,
            lineHeight: 1.2,
          },
        },
        item.detail,
      ),
    ),
  );
}

function contextPanel(context, artwork) {
  const items = context.items.slice(0, 3);
  return h(
    "div",
    {
      style: {
        width: 410,
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        padding: artwork ? "20px 26px" : "24px 30px",
        borderLeft: `2px solid ${COLORS.ink}`,
        backgroundColor: COLORS.wash,
      },
    },
    ...(artwork
      ? [
          h("img", {
            src: artwork,
            width: 356,
            height: 184,
            style: {
              objectFit: "cover",
              border: `2px solid ${COLORS.ink}`,
            },
          }),
          h(
            "div",
            {
              style: {
                flex: 1,
                display: "flex",
                flexDirection: "column",
                marginTop: 10,
              },
            },
            ...items.map((item, index) => featureRow(item, index, true)),
          ),
        ]
      : [
          h(
            "div",
            {
              style: {
                height: 45,
                display: "flex",
                alignItems: "center",
                color: COLORS.quiet,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
              },
            },
            "on this page",
          ),
          h(
            "div",
            {
              style: {
                flex: 1,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
              },
            },
            ...items.map((item, index) => featureRow(item, index, false)),
          ),
        ]),
  );
}

function body({ title, subtitle, context, artwork }) {
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
          padding: "34px 46px 36px",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            marginBottom: 18,
            color: COLORS.quiet,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: "uppercase",
          },
        },
        h("div", {
          style: {
            width: 34,
            height: 4,
            display: "flex",
            marginRight: 12,
            backgroundColor: COLORS.ink,
          },
        }),
        "open weather infrastructure",
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            maxHeight: 226,
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
            maxHeight: 78,
            overflow: "hidden",
            marginTop: 20,
            color: COLORS.quiet,
            fontSize: 19,
            lineHeight: 1.35,
          },
        },
        subtitle || "Open, cloud-native weather data.",
      ),
    ),
    contextPanel(context, artwork),
  );
}

function footer(url, context) {
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
          maxWidth: 690,
          display: "flex",
          overflow: "hidden",
          whiteSpace: "nowrap",
        },
      },
      displayUrl(url),
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          fontWeight: 700,
          textTransform: "uppercase",
        },
      },
      `${context.action} ->`,
    ),
  );
}

function richTemplate({ title, subtitle, url, context, artwork }) {
  const resolvedContext = context || FALLBACK_CONTEXT;
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
        border: `10px solid ${COLORS.ink}`,
      },
    },
    header(resolvedContext),
    body({
      title,
      subtitle,
      context: resolvedContext,
      artwork,
    }),
    footer(url, resolvedContext),
  );
}

function cacheKey({ title, subtitle, url, context, artwork }) {
  return crypto
    .createHash("md5")
    .update(
      [
        TEMPLATE_VERSION,
        title || "",
        subtitle || "",
        url || "",
        JSON.stringify(context || FALLBACK_CONTEXT),
        artwork || "",
      ].join("\0"),
    )
    .digest("hex");
}

async function renderCard({
  title,
  subtitle,
  url,
  context,
  artwork,
}) {
  const key = cacheKey({ title, subtitle, url, context, artwork });
  const cachePath = path.join(CACHE_DIR, `${key}.png`);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);

  const svg = await satori(
    richTemplate({ title, subtitle, url, context, artwork }),
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

module.exports = { renderCard };
