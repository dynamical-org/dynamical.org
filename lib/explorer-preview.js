// The Explore section's preview: an empty map of a dataset's initial view, drawn
// at build time as an inline SVG so the page shows where the map will open
// without loading the explorer or any weather data. Country borders come from the
// same world-atlas countries-50m file the explorer draws, projected to Web
// Mercator and fitted the way the explorer's mount() fits initialView.bounds.
const { mesh } = require("topojson-client");

// The frame, in SVG user units = CSS px of a desktop page, measured 2026-09-25
// in a 1280-wide page: the Explore box inside its border is 778 × 437 (16:9),
// and once mounted the explorer's map is its top 778 × 356, above the controls
// strip. The bounds are fitted to that map area with mount()'s padding for its
// size (min(20, width / 10, height / 10)), so the preview's centre and scale are
// the map's on the click; the strip's rows then cover the rest.
const FRAME = { width: 778, height: 437, mapHeight: 356, padding: 20 };
const MAX_LAT = 85.051129;

// Web Mercator, in world units: 0..1 west to east and north to south.
function mercator([lon, lat]) {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
}

// A projection that fits bounds [west, south, east, north] into width × height
// less padding on every side, centred, as WebMercatorViewport.fitBounds does,
// then held at mount()'s zoom floor of 0 (the world 512 px wide).
function fitBounds([w, s, e, n], { width, height, padding }) {
  const [x0, y0] = mercator([w, n]);
  const [x1, y1] = mercator([e, s]);
  const fit = Math.min((width - 2 * padding) / (x1 - x0), (height - 2 * padding) / (y1 - y0));
  const scale = Math.max(512, fit);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return (lonLat) => {
    const [x, y] = mercator(lonLat);
    return [width / 2 + (x - cx) * scale, height / 2 + (y - cy) * scale];
  };
}

// Border lines as SVG path data, cut to the frame: a run keeps the points inside
// it plus one on each side, so a line leaving the frame still reaches its edge.
// Points are whole units (CSS px), and one closer than `minStep` to the last
// kept point is dropped, unless it ends the run and isn't the same point; each run is a move then relative lines, which is what
// keeps a page's preview to a few KB compressed.
function borderPath(lines, project, { width, height }, minStep = 1.5) {
  const inside = ([x, y]) => x >= 0 && x <= width && y >= 0 && y <= height;
  let d = "";
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const steps = run.slice(1).map(([x, y], i) => `${x - run[i][0]} ${y - run[i][1]}`);
      d += `M${run[0][0]} ${run[0][1]}l${steps.join(" ").replace(/ -/g, "-")}`;
    }
    run = [];
  };
  for (const line of lines) {
    const points = line.map((p) => project(p).map(Math.round));
    points.forEach((p, i) => {
      const next = i + 1 < points.length && inside(points[i + 1]);
      if (!inside(p) && !(i > 0 && inside(points[i - 1])) && !next) return flush();
      const last = run[run.length - 1];
      const gap = last ? Math.hypot(p[0] - last[0], p[1] - last[1]) : Infinity;
      if (gap >= minStep || (!next && gap > 0)) run.push(p);
    });
    flush();
  }
  return d;
}

// The preview for one dataset: countries-50m's borders over initialView.bounds.
// Colour comes from the site's tokens, so both themes work.
function previewSvg(topology, bounds, frame = FRAME) {
  const lines = mesh(topology, topology.objects.countries).coordinates;
  const { width, mapHeight: height, padding } = frame;
  const d = borderPath(lines, fitBounds(bounds, { width, height, padding }), frame);
  return (
    `<svg viewBox="0 0 ${frame.width} ${frame.height}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">` +
    `<path d="${d}" fill="none" stroke="var(--text-color)" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    `</svg>`
  );
}

module.exports = { FRAME, mercator, fitBounds, borderPath, previewSvg };
