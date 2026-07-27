// Build-time generator for social / link-preview cards (Open Graph + Twitter).
//
// Renders a 1200x630 (1.91:1) PNG per page with the page's title in IBM Plex
// Mono on a high-contrast black-and-white brand template — the same aesthetic
// as the site. satori lays out the card and outlines the text to SVG paths (so no
// font is needed at raster time); sharp rasterizes the SVG to PNG.
//
// Results are content-hashed and cached under .cache/og so repeat builds and
// `--serve` rebuilds only regenerate cards whose text actually changed.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const satori = require("satori").default || require("satori");
const sharp = require("sharp");

const WIDTH = 1200;
const HEIGHT = 630;

// Bump when the template design changes so cached cards regenerate.
const TEMPLATE_VERSION = "7";

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

// Brand mark, recolored to solid black for the light card. The source SVG uses
// `fill="currentColor"`, which satori's <img> renderer can't resolve.
const ICON_SVG = fs
  .readFileSync(path.join(__dirname, "og-assets", "icon.svg"), "utf8")
  .replace('fill="currentColor"', 'fill="#111111"');
const ICON_DATA_URI =
  "data:image/svg+xml;base64," + Buffer.from(ICON_SVG).toString("base64");

const CACHE_DIR = path.join(__dirname, "..", ".cache", "og");

// Lightweight hyperscript so we can describe the layout without JSX/transpile.
// Leaf elements (e.g. <img>) get no `children` key at all — satori treats an
// empty `children: []` array as a malformed container and errors.
function h(type, props, ...children) {
  const flat = children.flat();
  return flat.length
    ? { type, props: { ...props, children: flat } }
    : { type, props: { ...props } };
}

// Title type scales down as the title gets longer so long headlines still fit
// in ~3 lines without overflowing.
function titleFontSize(title) {
  const len = title.length;
  if (len <= 24) return 82;
  if (len <= 55) return 66;
  if (len <= 95) return 54;
  if (len <= 145) return 46;
  return 40;
}

const COLORS = {
  ink: "#111111",
  paper: "#ffffff",
  muted: "#666666",
  mutedLight: "#d0d0d0",
  operational: "#5bc54a",
  degraded: "#f5a623",
  down: "#c5221f",
  unobserved: "#a8a8ad",
};

const STATE_PRESENTATION = {
  operational: { color: COLORS.operational, glyph: "+", label: "operational" },
  complete: { color: COLORS.operational, glyph: "+", label: "complete" },
  degraded: { color: COLORS.degraded, glyph: "!", label: "degraded" },
  delayed: { color: COLORS.degraded, glyph: "!", label: "delayed" },
  processing: { color: COLORS.degraded, glyph: "~", label: "processing" },
  stale: { color: COLORS.degraded, glyph: "!", label: "stale" },
  advisory: { color: COLORS.degraded, glyph: "!", label: "advisory" },
  down: { color: COLORS.down, glyph: "x", label: "down" },
  failed: { color: COLORS.down, glyph: "x", label: "failed" },
  unobserved: { color: COLORS.unobserved, glyph: "o", label: "unobserved" },
  pending: { color: COLORS.unobserved, glyph: "o", label: "pending" },
  unavailable: { color: COLORS.unobserved, glyph: "?", label: "unavailable" },
  unknown: { color: COLORS.unobserved, glyph: "?", label: "unknown" },
};

function presentation(state) {
  return STATE_PRESENTATION[state] || STATE_PRESENTATION.unknown;
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

function snapshotHeader(label, timestamp) {
  return h(
    "div",
    {
      style: {
        height: 94,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 48px",
        borderBottom: `3px solid ${COLORS.ink}`,
      },
    },
    brand(),
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          backgroundColor: COLORS.ink,
          color: COLORS.paper,
          padding: "9px 14px",
          borderRadius: 3,
          fontSize: 17,
          fontWeight: 700,
          textTransform: "uppercase",
        },
      },
      `${label} · ${timestamp}`,
    ),
  );
}

function verdict(model) {
  const state = presentation(model.state);
  return h(
    "div",
    {
      style: {
        minHeight: 104,
        display: "flex",
        alignItems: "center",
        borderBottom: `2px solid ${COLORS.ink}`,
      },
    },
    h(
      "div",
      {
        style: {
          width: 52,
          height: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
          marginRight: 20,
          borderRadius: 3,
          backgroundColor: state.color,
          color:
            model.state === "down" || model.state === "failed"
              ? COLORS.paper
              : COLORS.ink,
          fontSize: 34,
          fontWeight: 700,
        },
      },
      state.glyph,
    ),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
      h(
        "div",
        {
          style: {
            display: "flex",
            fontSize: 39,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -1.5,
          },
        },
        model.headline,
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 8,
            color: COLORS.muted,
            fontSize: 18,
          },
        },
        model.summary,
      ),
    ),
  );
}

function statePill(stateName) {
  const state = presentation(stateName);
  return h(
    "div",
    {
      style: {
        width: 166,
        display: "flex",
        alignItems: "center",
        padding: "5px 9px",
        borderRadius: 3,
        backgroundColor: state.color,
        color:
          stateName === "down" || stateName === "failed"
            ? COLORS.paper
            : COLORS.ink,
        fontSize: 15,
        fontWeight: 700,
      },
    },
    `${state.glyph} ${state.label}`,
  );
}

function historyStrip(states) {
  const cells = states.length ? states : Array(90).fill("nodata");
  return h(
    "div",
    {
      style: {
        flex: 1,
        display: "flex",
        alignItems: "center",
        gap: 1,
        height: 18,
        marginLeft: 20,
      },
    },
    ...cells.map((state) =>
      h("div", {
        style: {
          flex: "1 1 0",
          height: 15,
          border: `1px solid ${
            state === "nodata" ? COLORS.mutedLight : presentation(state).color
          }`,
          backgroundColor:
            state === "nodata" ? COLORS.paper : presentation(state).color,
        },
      }),
    ),
  );
}

function statusTemplate(model) {
  const components = model.components.slice(0, 5);
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
    snapshotHeader("status", model.timestamp),
    h(
      "div",
      {
        style: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "0 48px",
        },
      },
      verdict(model),
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
        ...(components.length
          ? components.map((component, index) =>
              h(
                "div",
                {
                  style: {
                    height: 54,
                    display: "flex",
                    alignItems: "center",
                    borderTop:
                      index === 0 ? "0" : `1px solid ${COLORS.mutedLight}`,
                  },
                },
                h(
                  "div",
                  {
                    style: {
                      width: 274,
                      display: "flex",
                      fontSize: component.name.length > 25 ? 15 : 18,
                      fontWeight: 700,
                    },
                  },
                  component.name,
                ),
                statePill(component.state),
                historyStrip(component.history),
              ),
            )
          : [
              h(
                "div",
                {
                  style: {
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    color: COLORS.muted,
                    fontSize: 22,
                  },
                },
                "Current component detail could not be loaded.",
              ),
            ]),
      ),
    ),
    h(
      "div",
      {
        style: {
          height: 58,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 48px",
          backgroundColor: COLORS.ink,
          color: COLORS.paper,
          fontSize: 16,
        },
      },
      h("div", { style: { display: "flex" } }, "dynamical.org/status"),
      h(
        "div",
        { style: { display: "flex" } },
        "+ operational · x outage · 90-day history · snapshot",
      ),
    ),
  );
}

function pipelineCell(stateName) {
  if (stateName === "empty") {
    return h("div", {
      style: {
        width: 53,
        height: 32,
        display: "flex",
        border: `1px solid ${COLORS.mutedLight}`,
        backgroundColor: COLORS.paper,
      },
    });
  }
  const state = presentation(stateName);
  return h(
    "div",
    {
      style: {
        width: 53,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${state.color}`,
        backgroundColor: state.color,
        color: stateName === "failed" ? COLORS.paper : COLORS.ink,
        fontSize: 20,
        fontWeight: 700,
      },
    },
    state.glyph,
  );
}

function pipelineTemplate(model) {
  const rows = model.rows.slice(0, 6);
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
    snapshotHeader("pipeline", model.timestamp),
    h(
      "div",
      {
        style: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "0 48px",
        },
      },
      verdict(model),
      h(
        "div",
        {
          style: {
            width: "100%",
            height: 42,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: COLORS.muted,
            fontSize: 16,
          },
        },
        h("div", { style: { display: "flex" } }, model.advisory),
        h("div", { style: { display: "flex" } }, "oldest to newest"),
      ),
      h(
        "div",
        {
          style: {
            flex: 1,
            display: "flex",
            flexDirection: "column",
          },
        },
        ...(rows.length
          ? rows.map((row, index) => {
              const runs = [
                ...Array(Math.max(0, 8 - row.runs.length)).fill("empty"),
                ...row.runs.slice(-8),
              ];
              return h(
                "div",
                {
                  style: {
                    height: 43,
                    display: "flex",
                    alignItems: "center",
                    borderTop:
                      index === 0 ? "0" : `1px solid ${COLORS.mutedLight}`,
                  },
                },
                h(
                  "div",
                  {
                    style: {
                      width: 580,
                      display: "flex",
                      fontSize:
                        row.label.length > 40
                          ? 14
                          : row.label.length > 30
                            ? 16
                            : 18,
                      fontWeight: 700,
                    },
                  },
                  row.label,
                ),
                h(
                  "div",
                  {
                    style: {
                      flex: 1,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 6,
                    },
                  },
                  ...runs.map(pipelineCell),
                ),
              );
            })
          : [
              h(
                "div",
                {
                  style: {
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    color: COLORS.muted,
                    fontSize: 22,
                  },
                },
                "Recent pipeline detail could not be loaded.",
              ),
            ]),
      ),
    ),
    h(
      "div",
      {
        style: {
          height: 58,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 48px",
          backgroundColor: COLORS.ink,
          color: COLORS.paper,
          fontSize: 15,
        },
      },
      h(
        "div",
        { style: { display: "flex" } },
        `dynamical.org/status/pipeline${
          model.extraRows ? ` · +${model.extraRows} more` : ""
        }`,
      ),
      h(
        "div",
        { style: { display: "flex" } },
        "+ complete · o pending · ~ progress · ! delayed · x failed",
      ),
    ),
  );
}

function genericTemplate({ title, subtitle, label }) {
  return h(
    "div",
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#ffffff",
        color: "#111111",
        fontFamily: "IBM Plex Mono",
        border: "10px solid #111111",
      },
    },
    // Header: brand mark + wordmark, with a small section label for context.
    h(
      "div",
      {
        style: {
          height: 112,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 62px",
          borderBottom: "3px solid #111111",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
          },
        },
        h("img", { src: ICON_DATA_URI, width: 44, height: 49 }),
        h(
          "div",
          {
            style: {
              display: "flex",
              marginLeft: 19,
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: -1,
            },
          },
          "dynamical.org"
        )
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            backgroundColor: "#111111",
            color: "#ffffff",
            padding: "9px 14px",
            borderRadius: 3,
            fontSize: 18,
            fontWeight: 700,
          },
        },
        label || "weather + climate"
      )
    ),
    // Keep the headline and its rule together so short titles feel intentional
    // instead of floating in a large empty middle band.
    h(
      "div",
      {
        style: {
          flex: 1,
          display: "flex",
          alignItems: "center",
          margin: "0 62px",
          padding: "24px 0",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            borderLeft: "12px solid #111111",
            paddingLeft: 30,
            maxHeight: 275,
            overflow: "hidden",
            fontSize: titleFontSize(title),
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -2,
          },
        },
        title
      )
    ),
    // The description is a first-class part of the card, not a faint caption.
    h(
      "div",
      {
        style: {
          minHeight: 166,
          display: "flex",
          alignItems: "center",
          backgroundColor: "#111111",
          color: "#ffffff",
          padding: "27px 62px 29px",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            fontSize: 27,
            lineHeight: 1.32,
            maxHeight: 108,
            overflow: "hidden",
          },
        },
        subtitle || "open, cloud-native weather data"
      )
    )
  );
}

function cacheKey({ title, subtitle, label, snapshot }) {
  return crypto
    .createHash("md5")
    .update(
      [
        TEMPLATE_VERSION,
        snapshot ? JSON.stringify(snapshot) : title,
        subtitle || "",
        label || "",
      ].join("\0"),
    )
    .digest("hex");
}

// Returns a PNG Buffer for the given page text, using the on-disk cache when the
// text (and template version) are unchanged.
async function renderCard({ title, subtitle, label, snapshot }) {
  const key = cacheKey({ title, subtitle, label, snapshot });
  const cachePath = path.join(CACHE_DIR, `${key}.png`);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  const tree =
    snapshot?.variant === "status"
      ? statusTemplate(snapshot)
      : snapshot?.variant === "pipeline"
        ? pipelineTemplate(snapshot)
        : genericTemplate({ title, subtitle, label });
  const svg = await satori(tree, {
    width: WIDTH,
    height: HEIGHT,
    fonts: FONTS,
  });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, png);
  return png;
}

module.exports = { renderCard };
