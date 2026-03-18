(function () {
  var canvas = document.getElementById("globe-canvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  var SIZE = 300;
  canvas.width = SIZE;
  canvas.height = SIZE;

  var DEG2RAD = Math.PI / 180;
  var RAD2DEG = 180 / Math.PI;

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
  var angle = 0;

  // --- Lighting & rotation ---
  var ll = Math.sqrt(0.7 * 0.7 + 0.25 * 0.25 + 0.3 * 0.3);
  var lightX = 0.7 / ll,
    lightY = 0.25 / ll,
    lightZ = 0.3 / ll;

  var tilt = 0.2;
  var cosT = Math.cos(tilt),
    sinT = Math.sin(tilt);

  // --- Dot color from CSS ---
  var dotR = 232,
    dotG = 232,
    dotB = 234;

  function updateColor() {
    var c = getComputedStyle(document.documentElement)
      .getPropertyValue("--text-color")
      .trim();
    if (c && c.charAt(0) === "#" && c.length === 7) {
      dotR = parseInt(c.slice(1, 3), 16);
      dotG = parseInt(c.slice(3, 5), 16);
      dotB = parseInt(c.slice(5, 7), 16);
    }
  }
  updateColor();
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", updateColor);
  }

  // --- Temperature color mapping ---
  // Maps temperature (°C) to subtle RGB tint
  // Cold (-30): blue-ish, Neutral (10): base color, Warm (35): amber-ish
  function tempColor(tempC, brightness) {
    var t = Math.max(0, Math.min(1, (tempC + 30) / 65)); // 0=cold, 1=warm
    // Interpolate: cold blue (0.6, 0.7, 1.0) → neutral (1,1,1) → warm amber (1.0, 0.85, 0.6)
    var r, g, b;
    if (t < 0.5) {
      var s = t * 2; // 0..1 within cold→neutral
      r = 0.6 + s * 0.4;
      g = 0.7 + s * 0.3;
      b = 1.0;
    } else {
      var s = (t - 0.5) * 2; // 0..1 within neutral→warm
      r = 1.0;
      g = 1.0 - s * 0.15;
      b = 1.0 - s * 0.4;
    }
    return {
      r: Math.min(255, (dotR * r * brightness) | 0),
      g: Math.min(255, (dotG * g * brightness) | 0),
      b: Math.min(255, (dotB * b * brightness) | 0),
    };
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
  var frameTime = 0; // seconds into the animation cycle
  var frameDuration = 6; // seconds per data frame (faster timestep cycling)
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
      var theta = (2 * Math.PI * i) / PHI;
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
        fp: Math.random() * Math.PI * 2,
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
      var ctheta = (2 * Math.PI * ci) / (PHI * PHI);
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
  }

  // --- Get interpolated frame data ---
  function getFrameData() {
    var nFrames = globe.frames.length;
    var totalCycle = nFrames * frameDuration;
    var pos = (frameTime % totalCycle) / frameDuration;
    var idx0 = Math.floor(pos) % nFrames;
    var idx1 = (idx0 + 1) % nFrames;
    var frac = pos - Math.floor(pos);
    return { f0: globe.frames[idx0], f1: globe.frames[idx1], frac: frac };
  }

  function updateFootnote(fd) {
    if (!footnoteEl) return;
    // Show the current frame's time
    var timeStr = fd.f0.time.replace("T", " ").replace(/\..*/, "");
    footnoteEl.textContent =
      "GFS analysis · " + timeStr + " UTC · dynamical.org";
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
  var lastFrameUpdate = 0;

  function render(time) {
    if (!globe) {
      requestAnimationFrame(render);
      return;
    }

    var t = time * 0.001;
    frameTime = t;
    var data = imageData.data;

    for (var k = 0; k < data.length; k++) data[k] = 0;

    var cosA = Math.cos(angle);
    var sinA = Math.sin(angle);
    var radius = SIZE * 0.39;
    var cx = SIZE / 2;
    var cy = SIZE / 2;

    var fd = getFrameData();

    // Update footnote every ~1 second
    if (t - lastFrameUpdate > 1) {
      updateFootnote(fd);
      lastFrameUpdate = t;
    }

    // --- Sphere points ---
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var tr = transform(p.x, p.y, p.z, cosA, sinA);

      if (tr.rz < 0) continue;

      var lighting = tr.rx * lightX + tr.ry * lightY + tr.rz * lightZ;
      var flicker = Math.sin(t * p.fs + p.fp) * 0.06;

      var landBoost = p.land * 0.3;
      var value =
        lighting * 0.55 + landBoost + tr.rz * 0.05 + p.noise * 0.08 + flicker;

      if (p.land > 0.5) {
        var bright = Math.max(0.15, Math.min(1.0, value * 1.2));

        // Sample temperature for color tint
        var temp = lerpGridSample(
          fd.f0.temperature,
          fd.f1.temperature,
          fd.frac,
          p.lat,
          p.lon
        );
        var col = tempColor(temp, bright);
      } else {
        if (value < 0.6) continue;
        var col = {
          r: (dotR * 0.35) | 0,
          g: (dotG * 0.35) | 0,
          b: (dotB * 0.35) | 0,
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
      var cR = Math.min(255, dotR);
      var cG = Math.min(255, dotG);
      var cB = Math.min(255, dotB);

      for (var ci = 0; ci < cloudPoints.length; ci++) {
        var cp = cloudPoints[ci];
        var ctr = transform(cp.x, cp.y, cp.z, cosA, sinA);

        if (ctr.rz < 0.02) continue;

        // Sample cloud cover (0-100) interpolated between frames
        var cc =
          lerpGridSample(
            fd.f0.cloud_cover,
            fd.f1.cloud_cover,
            fd.frac,
            cp.lat,
            cp.lon
          ) / 100;

        // Bayer threshold dither: show dot if cloud cover exceeds the
        // ordered threshold at this point's position
        if (cc < cp.bt) continue;

        // Lighting — clouds catch light too
        var clight = ctr.rx * lightX + ctr.ry * lightY + ctr.rz * lightZ;
        var cbright = Math.max(0.25, Math.min(0.8, clight * 0.6 + 0.3));

        var csx = Math.round(ctr.rx * radius + cx);
        var csy = Math.round(-ctr.ry * radius + cy);

        if (csx < 0 || csx + 1 >= SIZE || csy < 0 || csy + 1 >= SIZE) continue;

        var cidx = (csy * SIZE + csx) * 4;
        data[cidx] = (cR * cbright) | 0;
        data[cidx + 1] = (cG * cbright) | 0;
        data[cidx + 2] = (cB * cbright) | 0;
        data[cidx + 3] = 255;
      }
    }

    // --- Wind layers ---
    for (var wli = 0; wli < windLayers.length; wli++) {
      var wl = windLayers[wli];
      updateWindLayer(wl, fd);

      // Wind dots — subtle ghost traces
      var brightness = 0.35 - wli * 0.1;
      var wR = (dotR * brightness) | 0;
      var wG = (dotG * brightness) | 0;
      var wB = (dotB * brightness) | 0;

      for (var wi = 0; wi < wl.tracers.length; wi++) {
        var wt = wl.tracers[wi];
        for (var wj = 0; wj < wt.trail.length; wj++) {
          var tp = wt.trail[wj];
          var ttr = transform(tp.x, tp.y, tp.z, cosA, sinA);

          if (ttr.rz < 0.05) continue;

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

    angle += 0.0008;
    requestAnimationFrame(render);
  }

  // --- Load data and start ---
  // Try inline data first (legacy), then fetch from static file
  if (window.__windData) {
    // Convert old format to new
    var wd = window.__windData;
    if (wd.frames) {
      initGlobe(wd);
    } else {
      // Old single-frame format — wrap in frames array
      var frame = { time: wd.time || "", temperature: null, cloud_cover: null };
      if (wd.layers) {
        frame.wind_10m = { u: wd.layers[0].u, v: wd.layers[0].v };
        frame.wind_100m = { u: wd.layers[1].u, v: wd.layers[1].v };
      } else {
        frame.wind_10m = { u: wd.u, v: wd.v };
        frame.wind_100m = { u: wd.u, v: wd.v };
      }
      // Generate dummy temp grid if missing
      if (!frame.temperature) {
        frame.temperature = wd.land.map(function (row) {
          return row.map(function () {
            return 10;
          });
        });
      }
      initGlobe({
        lats: wd.lats,
        lons: wd.lons,
        land: wd.land,
        frames: [frame, frame],
      });
    }
  }

  // Fetch the static data file
  fetch("/globe-data.json")
    .then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    })
    .then(function (data) {
      initGlobe(data);
    })
    .catch(function () {
      // Fall back to inline data if fetch fails (already loaded above)
    });

  requestAnimationFrame(render);
})();
