(function () {
  var canvas = document.getElementById("globe-canvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  var SIZE = 300;
  canvas.width = SIZE;
  canvas.height = SIZE;

  var DEG2RAD = Math.PI / 180;
  var RAD2DEG = 180 / Math.PI;
  var TWO_PI = 2 * Math.PI;

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // --- Hash-based 3D value noise ---
  function hash3(ix, iy, iz) {
    var n = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
    n = Math.imul(n ^ (n >> 13), 0x5bd1e995);
    n = n ^ (n >> 15);
    return (n & 0x7fffffff) / 0x7fffffff;
  }

  function noise3d(x, y, z) {
    var ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z);
    var fx = x - ix,
      fy = y - iy,
      fz = z - iz;
    var sx = fx * fx * (3 - 2 * fx);
    var sy = fy * fy * (3 - 2 * fy);
    var sz = fz * fz * (3 - 2 * fz);
    var a = hash3(ix, iy, iz),
      b = hash3(ix + 1, iy, iz);
    var c = hash3(ix, iy + 1, iz),
      d = hash3(ix + 1, iy + 1, iz);
    var e = hash3(ix, iy, iz + 1),
      f = hash3(ix + 1, iy, iz + 1);
    var g = hash3(ix, iy + 1, iz + 1),
      hh = hash3(ix + 1, iy + 1, iz + 1);
    return (
      a * (1 - sx) * (1 - sy) * (1 - sz) +
      b * sx * (1 - sy) * (1 - sz) +
      c * (1 - sx) * sy * (1 - sz) +
      d * sx * sy * (1 - sz) +
      e * (1 - sx) * (1 - sy) * sz +
      f * sx * (1 - sy) * sz +
      g * (1 - sx) * sy * sz +
      hh * sx * sy * sz
    );
  }

  // --- Data state ---
  var globe = null; // loaded async
  var viewAngle = 0;  // camera rotation — only changes on drag
  var sunAngle = 0;   // sun orbit — auto-increments

  // --- Lighting & rotation ---
  var lightX = 0, lightY = 0, lightZ = 1; // updated each frame from sun position

  var tilt = 0.2;
  var cosT = Math.cos(tilt),
    sinT = Math.sin(tilt);

  // --- Sun position from UTC timestamp ---
  function sunPosition(timeStr) {
    var d = new Date(timeStr);
    var hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    var start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
    var dayOfYear = Math.floor((d - start) / 86400000);
    var sunLon = -(hour - 12) * 15; // degrees
    var sunLat = 23.45 * Math.sin((TWO_PI / 365) * (dayOfYear - 81));
    return { lat: sunLat, lon: sunLon };
  }

  function sunLightDirection(timeStr, cosA, sinA) {
    var sp = sunPosition(timeStr);
    var pos = latLonToXYZ(sp.lat, sp.lon, 1);
    var tr = transform(pos.x, pos.y, pos.z, cosA, sinA);
    return { x: tr.rx, y: tr.ry, z: tr.rz };
  }

  // --- Drag interaction state ---
  var dragging = false;
  var dragLastX = 0;
  var sliderDragging = false;

  // --- Timeline slider elements ---
  var sliderEl = document.getElementById("globe-slider");
  var timeStartEl = document.getElementById("globe-time-start");
  var timeEndEl = document.getElementById("globe-time-end");

  // --- Visual config per color scheme ---
  var THEME = {
    dark: {
      landBoost: 0.3,
      lightWeight: 0.25,    // how much lighting drives dither density
      brightMin: 0.15,      // minimum land dot brightness (shadow side)
      brightMult: 1.2,      // brightness amplification
      oceanThresh: 0.6,     // dither threshold for ocean dots
      oceanBright: 0.35,    // ocean dot brightness
      windBright: 0.75,     // wind tracer brightness
      windDimStep: 0.15,    // brightness reduction per wind layer
      cloudBright: { min: 0.25, max: 0.8 },
    },
    light: {
      landBoost: 0.15,
      lightWeight: 0.4,
      brightMin: 0.0,
      brightMult: 1.8,
      oceanThresh: 0.7,
      oceanBright: 0.5,
      windBright: 0.35,
      windDimStep: 0.1,
      cloudBright: { min: 0.25, max: 0.8 },
    },
  };

  var dotR = 232,
    dotG = 232,
    dotB = 234;
  var isDark = true;
  var cfg = THEME.dark;

  function updateColor() {
    var c = getComputedStyle(document.documentElement)
      .getPropertyValue("--text-color")
      .trim();
    if (c && c.charAt(0) === "#" && c.length === 7) {
      dotR = parseInt(c.slice(1, 3), 16);
      dotG = parseInt(c.slice(3, 5), 16);
      dotB = parseInt(c.slice(5, 7), 16);
    }
    isDark = window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true;
    cfg = isDark ? THEME.dark : THEME.light;
  }
  updateColor();
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", updateColor);
  }

  // --- Temperature color mapping ---
  function tempColor(tempC, brightness) {
    var t = Math.max(0, Math.min(1, (tempC + 30) / 65)); // 0=cold, 1=warm

    if (isDark) {
      // Dark mode: tint the light base dots
      var r, g, b;
      if (t < 0.5) {
        var s = t * 2;
        r = 0.6 + s * 0.4;
        g = 0.7 + s * 0.3;
        b = 1.0;
      } else {
        var s = (t - 0.5) * 2;
        r = 1.0;
        g = 1.0 - s * 0.15;
        b = 1.0 - s * 0.4;
      }
      return {
        r: Math.min(255, (dotR * r * brightness) | 0),
        g: Math.min(255, (dotG * g * brightness) | 0),
        b: Math.min(255, (dotB * b * brightness) | 0),
      };
    } else {
      // Light mode: use actual distinct colors (dark base can't show tints)
      // Cold: blue (40, 80, 180) → Neutral: dark gray (50,50,50) → Warm: red (180, 50, 30)
      var r, g, b;
      if (t < 0.5) {
        var s = t * 2;
        r = 40 + s * 10;
        g = 80 - s * 30;
        b = 180 - s * 130;
      } else {
        var s = (t - 0.5) * 2;
        r = 50 + s * 130;
        g = 50 - s * 10;
        b = 50 - s * 20;
      }
      return {
        r: (r * brightness) | 0,
        g: (g * brightness) | 0,
        b: (b * brightness) | 0,
      };
    }
  }

  // --- Grid helpers ---
  var nLat, nLon, latMax, latMin, lonMin, lonMax, dLat, dLon, latDesc;

  function initGrid(data) {
    nLat = data.lats.length;
    nLon = data.lons.length;
    latDesc = data.lats[0] > data.lats[nLat - 1];
    latMax = latDesc ? data.lats[0] : data.lats[nLat - 1];
    latMin = latDesc ? data.lats[nLat - 1] : data.lats[0];
    lonMin = data.lons[0];
    lonMax = data.lons[nLon - 1];
    dLat = Math.abs(data.lats[1] - data.lats[0]);
    dLon = Math.abs(data.lons[1] - data.lons[0]);
  }

  function gridIndices(latDeg, lonDeg) {
    latDeg = Math.max(latMin, Math.min(latMax, latDeg));
    while (lonDeg < lonMin) lonDeg += 360;
    while (lonDeg > lonMax + dLon) lonDeg -= 360;
    var fi = latDesc ? (latMax - latDeg) / dLat : (latDeg - latMin) / dLat;
    var fj = (lonDeg - lonMin) / dLon;
    var i0 = Math.max(0, Math.min(Math.floor(fi), nLat - 1));
    var j0 = Math.max(0, Math.min(Math.floor(fj), nLon - 1));
    return {
      i0: i0,
      j0: j0,
      i1: Math.min(i0 + 1, nLat - 1),
      j1: (j0 + 1) % nLon,
      fy: fi - Math.floor(fi),
      fx: fj - Math.floor(fj),
    };
  }

  function bilerp(grid, g) {
    return (
      grid[g.i0][g.j0] * (1 - g.fy) * (1 - g.fx) +
      grid[g.i1][g.j0] * g.fy * (1 - g.fx) +
      grid[g.i0][g.j1] * (1 - g.fy) * g.fx +
      grid[g.i1][g.j1] * g.fy * g.fx
    );
  }

  function sampleGrid(grid, latDeg, lonDeg) {
    return bilerp(grid, gridIndices(latDeg, lonDeg));
  }

  // --- Lerp between two grids for temporal interpolation ---
  function lerpGridSample(gridA, gridB, frac, latDeg, lonDeg) {
    var g = gridIndices(latDeg, lonDeg);
    var a = bilerp(gridA, g);
    var b = bilerp(gridB, g);
    return a + (b - a) * frac;
  }

  // --- Transform helper ---
  function transform(x, y, z, cosA, sinA) {
    var rx = x * cosA + z * sinA;
    var rz = -x * sinA + z * cosA;
    var ry = y;
    var ry2 = ry * cosT - rz * sinT;
    var rz2 = ry * sinT + rz * cosT;
    return { rx: rx, ry: ry2, rz: rz2 };
  }

  function latLonToXYZ(latDeg, lonDeg, r) {
    var la = latDeg * DEG2RAD;
    var lo = lonDeg * DEG2RAD;
    return {
      x: Math.cos(la) * Math.sin(lo) * r,
      y: Math.sin(la) * r,
      z: Math.cos(la) * Math.cos(lo) * r,
    };
  }

  // --- 8x8 Bayer dither matrix (normalized 0..1) ---
  // Pinned to globe geometry via lat/lon mapping — rotates with the sphere
  var bayer8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  // Normalize to 0..1
  for (var bi = 0; bi < 8; bi++)
    for (var bj = 0; bj < 8; bj++) bayer8[bi][bj] /= 64;

  // --- Initialize globe from loaded data ---
  var points = [];
  var cloudPoints = [];
  var windLayers = [];
  var footnoteEl = document.getElementById("globe-footnote");

  function initGlobe(data) {
    initGrid(data);

    // Sphere points
    var N = 6000;
    var PHI = (1 + Math.sqrt(5)) / 2;
    points = [];

    for (var i = 0; i < N; i++) {
      var py = 1 - (i / (N - 1)) * 2;
      var pr = Math.sqrt(1 - py * py);
      var theta = (TWO_PI * i) / PHI;
      var px = Math.cos(theta) * pr;
      var pz = Math.sin(theta) * pr;

      var lat = Math.asin(py) * RAD2DEG;
      var lon = Math.atan2(px, pz) * RAD2DEG;
      var land = sampleGrid(data.land, lat, lon);

      var jitter = (Math.random() - 0.5) * 0.015;

      points.push({
        x: px + jitter,
        y: py + jitter,
        z: pz + jitter,
        lat: lat,
        lon: lon,
        land: land,
        noise: noise3d(px * 3, py * 3, pz * 3),
        fp: Math.random() * TWO_PI,
        fs: 0.3 + Math.random() * 1.5,
      });
    }

    // Cloud points — separate fibonacci sphere at slightly elevated radius
    // Bayer dither threshold mapped via lat/lon so pattern is pinned to globe
    var CLOUD_RADIUS = 1.06;
    var CN = 5000;
    cloudPoints = [];

    for (var ci = 0; ci < CN; ci++) {
      var cpy = 1 - (ci / (CN - 1)) * 2;
      var cpr = Math.sqrt(1 - cpy * cpy);
      // Use different golden angle offset so cloud points don't overlap land points
      var ctheta = (TWO_PI * ci) / (PHI * PHI);
      var cpx = Math.cos(ctheta) * cpr;
      var cpz = Math.sin(ctheta) * cpr;

      var clat = Math.asin(cpy) * RAD2DEG;
      var clon = Math.atan2(cpx, cpz) * RAD2DEG;

      // Map lat/lon to bayer matrix indices (pinned to geometry)
      // Scale so the pattern repeats ~6 times around the globe
      var brow = Math.floor(((clat + 90) / 180) * 48) % 8;
      var bcol = Math.floor(((clon + 180) / 360) * 48) % 8;
      var bayerThreshold = bayer8[brow][bcol];

      cloudPoints.push({
        x: cpx * CLOUD_RADIUS,
        y: cpy * CLOUD_RADIUS,
        z: cpz * CLOUD_RADIUS,
        lat: clat,
        lon: clon,
        bt: bayerThreshold,
      });
    }

    // Wind layers: 10m (lower, more tracers) and 100m (higher, fewer)
    var layerDefs = [
      { key: "wind_10m", elevation: 1.04, count: 800, trail: 8, speed: 0.008 },
      {
        key: "wind_100m",
        elevation: 1.12,
        count: 600,
        trail: 10,
        speed: 0.012,
      },
    ];

    windLayers = [];
    for (var li = 0; li < layerDefs.length; li++) {
      var def = layerDefs[li];
      var tracers = [];
      for (var ti = 0; ti < def.count; ti++) {
        tracers.push({
          lat: Math.asin(Math.random() * 2 - 1) * RAD2DEG,
          lon: Math.random() * 360 - 180,
          age: Math.floor(Math.random() * 150),
          trail: [],
        });
      }
      windLayers.push({
        key: def.key,
        elevation: def.elevation,
        speed: def.speed,
        trailLen: def.trail,
        maxAge: 150,
        tracers: tracers,
      });
    }

    globe = data;

    // Set initial view to face the pre-dawn region (~3am local solar time)
    var initialFd = getFrameData();
    var sp = sunPosition(interpolateTime(initialFd));
    viewAngle = -(sp.lon - 135) * DEG2RAD;

    // Populate timeline labels
    if (timeStartEl && timeEndEl && data.frames.length > 0) {
      var first = new Date(data.frames[0].time);
      var last = new Date(data.frames[data.frames.length - 1].time);
      var spansMultipleDays = first.getUTCDate() !== last.getUTCDate()
        || first.getUTCMonth() !== last.getUTCMonth();
      var fmt = function (d) {
        var time = pad(d.getUTCHours()) + ":00";
        if (spansMultipleDays) {
          return pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + time;
        }
        return time + " UTC";
      };
      timeStartEl.textContent = fmt(first);
      timeEndEl.textContent = fmt(last);
    }
  }

  // --- Get interpolated frame data (derived from sunAngle) ---
  var angleOffset = 40 * DEG2RAD; // bias so dayside faces the viewer
  function getFrameData() {
    var nFrames = globe.frames.length;
    var a = (((sunAngle + angleOffset) % TWO_PI) + TWO_PI) % TWO_PI;
    var pos = (a / TWO_PI) * nFrames;
    var idx0 = Math.floor(pos) % nFrames;
    var idx1 = (idx0 + 1) % nFrames;
    var frac = pos - Math.floor(pos);
    return { f0: globe.frames[idx0], f1: globe.frames[idx1], frac: frac };
  }

  // --- Interpolate timestamp between two frames ---
  function interpolateTime(fd) {
    var t0 = new Date(fd.f0.time).getTime();
    var t1 = new Date(fd.f1.time).getTime();
    // Handle wrap-around using actual frame step
    if (t1 < t0) {
      var step = new Date(globe.frames[1].time).getTime() - new Date(globe.frames[0].time).getTime();
      t1 = t0 + step;
    }
    var t = t0 + (t1 - t0) * fd.frac;
    return new Date(t).toISOString();
  }

  function updateFootnote(fd) {
    if (!footnoteEl) return;
    var d = new Date(fd.f0.time);
    var timeStr = pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate())
      + " " + pad(d.getUTCHours()) + ":00:00";
    footnoteEl.innerHTML =
      '<a href="/catalog/noaa-gfs-analysis/">GFS analysis</a> · ' + timeStr + " UTC · dynamical.org";
  }

  // --- Update wind tracers ---
  function updateWindLayer(wl, fd) {
    var uA = fd.f0[wl.key].u,
      vA = fd.f0[wl.key].v;
    var uB = fd.f1[wl.key].u,
      vB = fd.f1[wl.key].v;

    for (var i = 0; i < wl.tracers.length; i++) {
      var tr = wl.tracers[i];
      var g = gridIndices(tr.lat, tr.lon);

      var u = bilerp(uA, g) + (bilerp(uB, g) - bilerp(uA, g)) * fd.frac;
      var v = bilerp(vA, g) + (bilerp(vB, g) - bilerp(vA, g)) * fd.frac;

      if (u !== u) {
        // NaN check
        tr.age = wl.maxAge + 1;
      } else {
        var cosLat = Math.cos(tr.lat * DEG2RAD);
        if (cosLat < 0.01) cosLat = 0.01;
        tr.lon += (u * wl.speed) / cosLat;
        tr.lat += v * wl.speed;
      }

      if (tr.lon > 180) tr.lon -= 360;
      if (tr.lon < -180) tr.lon += 360;
      tr.lat = Math.max(-89, Math.min(89, tr.lat));

      var pos = latLonToXYZ(tr.lat, tr.lon, wl.elevation);
      tr.trail.push(pos);
      if (tr.trail.length > wl.trailLen) tr.trail.shift();

      tr.age++;
      if (tr.age > wl.maxAge) {
        wl.tracers[i] = {
          lat: Math.asin(Math.random() * 2 - 1) * RAD2DEG,
          lon: Math.random() * 360 - 180,
          age: Math.floor(Math.random() * wl.maxAge),
          trail: [],
        };
      }
    }
  }

  // --- Render loop ---
  var imageData = ctx.createImageData(SIZE, SIZE);
  var lastFootnoteUpdate = 0;

  function render(time) {
    if (!globe) {
      requestAnimationFrame(render);
      return;
    }

    var t = time * 0.001;
    var data = imageData.data;

    for (var k = 0; k < data.length; k++) data[k] = 0;

    var cosA = Math.cos(viewAngle);
    var sinA = Math.sin(viewAngle);
    var radius = SIZE * 0.39;
    var cx = SIZE / 2;
    var cy = SIZE / 2;

    var fd = getFrameData();

    // Sun position comes from the timestamp (which advances via sunAngle);
    // transform by viewAngle only so the sun visibly orbits the static globe
    var sun = sunLightDirection(interpolateTime(fd), cosA, sinA);
    lightX = sun.x;
    lightY = sun.y;
    lightZ = sun.z;

    // Update footnote and slider every ~1 second
    if (t - lastFootnoteUpdate > 1) {
      updateFootnote(fd);
      lastFootnoteUpdate = t;
      // Sync slider position from sunAngle (unless user is dragging the slider)
      if (sliderEl && !sliderDragging) {
        var norm = (((sunAngle % TWO_PI) + TWO_PI) % TWO_PI) / TWO_PI;
        sliderEl.value = Math.round(norm * 1000);
      }
    }

    // --- Globe outline (thin circle) ---
    // Blend text color toward background: faint in both modes
    var oa = isDark ? 0.08 : 0.06;
    var bgR = isDark ? 15 : 255;
    var bgG = isDark ? 15 : 255;
    var bgB = isDark ? 16 : 255;
    var outlineR = (dotR * oa + bgR * (1 - oa)) | 0;
    var outlineG = (dotG * oa + bgG * (1 - oa)) | 0;
    var outlineB = (dotB * oa + bgB * (1 - oa)) | 0;
    var r2 = radius * radius;
    for (var oy = -Math.ceil(radius); oy <= Math.ceil(radius); oy++) {
      var ox1 = Math.sqrt(Math.max(0, r2 - oy * oy));
      // Plot two pixels on each side of the circle at this y
      for (var side = -1; side <= 1; side += 2) {
        var osx = Math.round(side * ox1 + cx);
        var osy = Math.round(oy + cy);
        if (osx >= 0 && osx < SIZE && osy >= 0 && osy < SIZE) {
          var oidx = (osy * SIZE + osx) * 4;
          data[oidx] = outlineR;
          data[oidx + 1] = outlineG;
          data[oidx + 2] = outlineB;
          data[oidx + 3] = 255;
        }
      }
    }

    // --- Sphere points ---
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var tr = transform(p.x, p.y, p.z, cosA, sinA);

      if (tr.rz < 0) continue;

      var lighting = tr.rx * lightX + tr.ry * lightY + tr.rz * lightZ;
      var flicker = Math.sin(t * p.fs + p.fp) * 0.06;

      var landBoost = p.land * cfg.landBoost;
      var value =
        lighting * cfg.lightWeight + landBoost + tr.rz * 0.05 + p.noise * 0.05 + flicker;

      if (p.land > 0.5) {
        // Dither by density: skip dots on the shadow side instead of dimming
        if (value < cfg.brightMin) continue;
        // Use noise as a per-dot dither threshold against the lighting value
        var ditherThresh = p.noise * 0.5 + 0.25; // 0.25..0.75 per dot
        if (value < ditherThresh * cfg.brightMult * 0.5) continue;

        // Dots that pass the threshold render at full color (no brightness fade)
        var temp = lerpGridSample(
          fd.f0.temperature,
          fd.f1.temperature,
          fd.frac,
          p.lat,
          p.lon
        );
        var col = tempColor(temp, 1.0);
      } else {
        // Ocean: same density-based dither as land
        var oceanDither = p.noise * 0.5 + 0.25;
        if (value < oceanDither * cfg.oceanThresh) continue;
        var col = {
          r: (dotR * cfg.oceanBright) | 0,
          g: (dotG * cfg.oceanBright) | 0,
          b: (dotB * cfg.oceanBright) | 0,
        };
      }

      var sx = Math.round(tr.rx * radius + cx);
      var sy = Math.round(-tr.ry * radius + cy);

      if (sx < 0 || sx >= SIZE || sy < 0 || sy >= SIZE) continue;

      if (p.land > 0.5 && sx + 1 < SIZE && sy + 1 < SIZE) {
        for (var dy = 0; dy < 2; dy++) {
          for (var dx = 0; dx < 2; dx++) {
            var idx = ((sy + dy) * SIZE + (sx + dx)) * 4;
            data[idx] = col.r;
            data[idx + 1] = col.g;
            data[idx + 2] = col.b;
            data[idx + 3] = 255;
          }
        }
      } else {
        var idx = (sy * SIZE + sx) * 4;
        data[idx] = col.r;
        data[idx + 1] = col.g;
        data[idx + 2] = col.b;
        data[idx + 3] = 255;
      }
    }

    // --- Cloud layer (Bayer-dithered) ---
    if (cloudPoints.length > 0 && fd.f0.cloud_cover) {
      for (var ci = 0; ci < cloudPoints.length; ci++) {
        var cp = cloudPoints[ci];
        var ctr = transform(cp.x, cp.y, cp.z, cosA, sinA);

        if (ctr.rz < 0.02) continue;

        // Lighting-based density dither — hide clouds on shadow side
        var clight = ctr.rx * lightX + ctr.ry * lightY + ctr.rz * lightZ;
        var clightVal = clight * cfg.lightWeight + ctr.rz * 0.1;
        if (clightVal < cp.bt * 0.6) continue;

        // Sample cloud cover (0-100) interpolated between frames
        var cc =
          lerpGridSample(
            fd.f0.cloud_cover,
            fd.f1.cloud_cover,
            fd.frac,
            cp.lat,
            cp.lon
          ) / 100;

        // Bayer threshold dither: show dot if cloud cover exceeds threshold
        if (cc < cp.bt) continue;

        var cbright = Math.max(cfg.cloudBright.min, Math.min(cfg.cloudBright.max, clight * 0.6 + 0.3));

        var csx = Math.round(ctr.rx * radius + cx);
        var csy = Math.round(-ctr.ry * radius + cy);

        if (csx < 0 || csx + 1 >= SIZE || csy < 0 || csy + 1 >= SIZE) continue;

        var cidx = (csy * SIZE + csx) * 4;
        data[cidx] = (dotR * cbright) | 0;
        data[cidx + 1] = (dotG * cbright) | 0;
        data[cidx + 2] = (dotB * cbright) | 0;
        data[cidx + 3] = 255;
      }
    }

    // --- Wind layers ---
    for (var wli = 0; wli < windLayers.length; wli++) {
      var wl = windLayers[wli];
      updateWindLayer(wl, fd);

      // Wind dots — subtle ghost traces
      var brightness = cfg.windBright - wli * cfg.windDimStep;
      var wR = (dotR * brightness) | 0;
      var wG = (dotG * brightness) | 0;
      var wB = (dotB * brightness) | 0;

      for (var wi = 0; wi < wl.tracers.length; wi++) {
        var wt = wl.tracers[wi];
        for (var wj = 0; wj < wt.trail.length; wj++) {
          var tp = wt.trail[wj];
          var ttr = transform(tp.x, tp.y, tp.z, cosA, sinA);

          if (ttr.rz < 0.05) continue;

          // Lighting density dither — hide wind on shadow side
          var wlight = ttr.rx * lightX + ttr.ry * lightY + ttr.rz * lightZ;
          if (wlight * cfg.lightWeight + ttr.rz * 0.1 < 0.15) continue;

          var tsx = Math.round(ttr.rx * radius + cx);
          var tsy = Math.round(-ttr.ry * radius + cy);

          if (tsx < 0 || tsx >= SIZE || tsy < 0 || tsy >= SIZE) continue;

          var tidx = (tsy * SIZE + tsx) * 4;
          data[tidx] = wR;
          data[tidx + 1] = wG;
          data[tidx + 2] = wB;
          data[tidx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);

    if (!dragging && !sliderDragging) {
      sunAngle += 0.0008;
    }
    requestAnimationFrame(render);
  }

  // --- Load data and start ---
  fetch("https://sa.dynamical.org/site/globe-data.json")
    .then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    })
    .then(initGlobe);

  // --- Mouse/touch drag to rotate ---
  var dragSensitivity = Math.PI / canvas.width; // ~π per canvas-width

  canvas.addEventListener("mousedown", function (e) {
    dragging = true;
    dragLastX = e.clientX;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    var dx = e.clientX - dragLastX;
    viewAngle += dx * dragSensitivity;
    dragLastX = e.clientX;
  });
  window.addEventListener("mouseup", function () {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "grab";
  });

  canvas.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) return;
    dragging = true;
    dragLastX = e.touches[0].clientX;
  }, { passive: true });
  window.addEventListener("touchmove", function (e) {
    if (!dragging || e.touches.length !== 1) return;
    e.preventDefault();
    var dx = e.touches[0].clientX - dragLastX;
    viewAngle += dx * dragSensitivity;
    dragLastX = e.touches[0].clientX;
  }, { passive: false });
  window.addEventListener("touchend", function () {
    dragging = false;
  });

  canvas.style.cursor = "grab";

  // --- Timeline slider interaction ---
  if (sliderEl) {
    sliderEl.addEventListener("input", function () {
      sliderDragging = true;
      var norm = sliderEl.value / 1000;
      sunAngle = norm * TWO_PI;
    });
    sliderEl.addEventListener("change", function () {
      sliderDragging = false;
    });
  }

  requestAnimationFrame(render);
})();
