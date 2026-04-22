const fetch = require("@11ty/eleventy-fetch");

const CC_BY_4 = `
        <p>
        Dataset licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
        </p>
`

// Pixel art glyph helper — converts a string pattern to an inline SVG.
// Glyph vocabulary:
//   Outer shape:  circle = global coverage, lens = regional (CONUS)
//   Repetition:   single = deterministic, cascade = ensemble
//   Fill/accent:  reserved for AI models (future)
function pixelArt(pattern, displaySize = 20) {
  const rows = pattern.trim().split('\n').map(r => r.trim());
  const h = rows.length;
  const w = Math.max(...rows.map(r => r.length));
  let rects = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x] !== '.') {
        rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${displaySize}" height="${displaySize}" fill="currentColor" style="shape-rendering:crispEdges">${rects}</svg>`;
}

// Global, deterministic — single circle
const GLYPH_GLOBE = pixelArt(`
..XXX..
.X...X.
X.....X
X.....X
X.....X
.X...X.
..XXX..
`);

// Global, ensemble (fewer members) — two overlapping circles
const GLYPH_GLOBE_DUO = pixelArt(`
..XXX....
.X..XXX..
X..X..XX.
X.X...X.X
X.X...X.X
.XX..X..X
..XXX..X.
....XXX..
`);

// Global, ensemble (more members) — three circles cascading diagonally
const GLYPH_GLOBE_CASCADE = pixelArt(`
.XXX.....
X...X....
X..XXX...
X.X.X.X..
.XXX.XXX.
..X.X.X.X
...XXX..X
....X...X
.....XXX.
`);

// Regional (CONUS) — tilted Lambert conformal grid outline
const GLYPH_CONUS = pixelArt(`
...XXXXXXXX
..X.......X
.X........X
X.........X
X........X.
X.......X..
XXXXXXXX...
`);

// Regional (Europe) — tilted grid outline, mirrored from CONUS
const GLYPH_EUROPE = pixelArt(`
XXXXXXXX...
X.......X..
X........X.
X.........X
.X........X
..X.......X
...XXXXXXXX
`);

// Global, deterministic, AI — sparkle (4-pointed star)
const GLYPH_AI = pixelArt(`
...X...
...X...
..X.X..
XX...XX
..X.X..
...X...
...X...
`);

// Global, ensemble (fewer members), AI — two overlapping sparkles
const GLYPH_AI_DUO = pixelArt(`
...X.......
...X...X...
..X.X..X...
XX...XX.X..
..X.XX...XX
...X..X.X..
...X...X...
.......X...
`);

// Global, ensemble (more members), AI — three sparkles cascading diagonally
const GLYPH_AI_CASCADE = pixelArt(`
...X...........
...X...X.......
..X.X..X...X...
XX...XX.X..X...
..X.XX...XX..X.
...X..X.XX...XX
...X...X..X.X..
.......X...X...
...........X...
`);

// Radar / multi-sensor — concentric rings (radar scope)
const GLYPH_RADAR = pixelArt(`
...XXX...
..X...X..
.X.XXX.X.
X.X...X.X
X.X.X.X.X
X.X...X.X
.X.XXX.X.
..X...X..
...XXX...
`);

// Model definitions for grouping datasets
const models = {
  "noaa-gfs": {
    name: "NOAA GFS",
    shortName: "GFS",
    glyph: GLYPH_GLOBE,
    description: `
      <p>
      The Global Forecast System (GFS) is a National Oceanic and Atmospheric
      Administration (NOAA) National Centers for Environmental Prediction
      (NCEP) weather forecast model that generates data for dozens of
      atmospheric and land-soil variables, including temperatures, winds,
      precipitation, soil moisture, and atmospheric ozone concentration. The
      system couples four separate models (atmosphere, ocean model, land/soil
      model, and sea ice) that work together to depict weather conditions.
      </p>
    `,
    agency: "NOAA",
    type: "Global Weather Model",
  },
  "noaa-gefs": {
    name: "NOAA GEFS",
    shortName: "GEFS",
    glyph: GLYPH_GLOBE_DUO,
    description: `
      <p>
      The Global Ensemble Forecast System (GEFS) is a National Oceanic and
      Atmospheric Administration (NOAA) National Centers for Environmental
      Prediction (NCEP) weather forecast model. GEFS creates 31 separate
      forecasts (ensemble members) to describe the range of forecast uncertainty.
      </p>
    `,
    agency: "NOAA",
    type: "Global Ensemble Weather Model",
  },
  "noaa-hrrr": {
    name: "NOAA HRRR",
    shortName: "HRRR",
    glyph: GLYPH_CONUS,
    description: `
      <p>
      The High-Resolution Rapid Refresh (HRRR) is a NOAA real-time 3-km resolution,
      hourly updated, cloud-resolving, convection-allowing atmospheric model,
      initialized by 3km grids with 3km radar assimilation. Radar data is
      assimilated in the HRRR every 15 min over a 1-h period adding further
      detail to that provided by the hourly data assimilation from the 13km
      radar-enhanced Rapid Refresh.
      </p>
    `,
    agency: "NOAA",
    type: "Regional Weather Model",
  },
  "noaa-mrms": {
    name: "NOAA MRMS",
    shortName: "MRMS",
    glyph: GLYPH_RADAR,
    description: `
      <p>
      The NOAA Multi-Radar/Multi-Sensor System (MRMS) integrates data from
      multiple radars and radar networks, surface observations, numerical
      weather prediction (NWP) models, and climatology to generate seamless,
      high spatio-temporal resolution mosaics at low latency focused on hail,
      wind, tornado, quantitative precipitation estimations, convection, icing,
      and turbulence.
      </p>
    `,
    agency: "NOAA",
    type: "Regional Weather Analysis",
  },
  "dwd-icon-eu": {
    name: "DWD ICON-EU",
    shortName: "ICON-EU",
    glyph: GLYPH_EUROPE,
    description: `
      <p>
      ICON-EU is a regional weather forecast model operated by
      Deutscher Wetterdienst (DWD), Germany's national meteorological service.
      ICON-EU is a nested configuration of DWD's global ICON (Icosahedral
      Non-hydrostatic) model that provides high-resolution forecasts over Europe.
      </p>
    `,
    agency: "DWD",
    type: "Regional Weather Model",
  },
  "ecmwf-aifs-single": {
    name: "ECMWF AIFS Single",
    shortName: "AIFS Single",
    glyph: GLYPH_AI,
    description: `
      <p>
      The Artificial Intelligence Forecasting System (AIFS) is a data driven forecast
      model developed by the European Centre for Medium-Range Weather Forecasts (ECMWF).
      This is the non-ensemble configuration of AIFS that produces a single forecast trace.
      AIFS is trained on ECMWF's ERA5 re-analysis and ECMWF's operational numerical
      weather prediction (NWP) analyses.
      </p>
    `,
    agency: "ECMWF",
    type: "Global AI Weather Model",
  },
  "ecmwf-ifs-ens": {
    name: "ECMWF IFS ENS",
    shortName: "IFS ENS",
    glyph: GLYPH_GLOBE_CASCADE,
    description: `
      <p>
       The Integrated Forecasting System (IFS) is a global forecast model developed 
       by ECMWF. ENS is an ensemble configuration of IFS, containing 51 ensemble members.
       IFS consists of a numerical model of the Earth system, which includes
       an atmospheric model at its heart, coupled with models of other Earth system 
       components such as the ocean. The data assimilation system combines 
       the latest weather observations with a recent forecast to obtain the best 
       possible estimate of the current state of the Earth system.
      </p>
    `,
    agency: "ECMWF",
    type: "Global Weather Model",
  },
};

let entries = [
  // noaa-gfs-analysis
  {
    modelId: "noaa-gfs",
    descriptionSummary: `
        <p>
        This analysis dataset is an archive of the model's best estimate of past weather.
        It is created by concatenating the first few hours of each historical forecast to
        provide a dataset with dimensions time, latitude, and longitude.
        </p>
      `,
    descriptionDetails: `
        <h3>Construction</h3>
        <p>
        GFS starts a new model run every 6 hours and
        dynamical.org has created this analysis by concatenating the first 6
        hours of each forecast along the time dimension.
        </p>

        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-gfs-bdp-pds/">AWS Open Data Registry</a>.
        Operational data is additionally accessed from <a href="https://nomads.ncep.noaa.gov/">NOAA NOMADS</a>.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gfs/analysis/template_config.py">reformatting code</a>.
        </p>

        <h3>Related dataset</h3>
        <p>
        <a href="/catalog/noaa-gefs-analysis/">NOAA GEFS analysis</a> provides a much longer historical record.
        </p>
      `,
    url: "https://data.dynamical.org/noaa/gfs/analysis/latest.zarr",
    status: "live",
    license: CC_BY_4,
    examples: [
      {
        title: "Temperature at a specific place and time",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/gfs/analysis/latest.zarr")
ds["temperature_2m"].sel(time="2026-01-01T00", latitude=0, longitude=0).compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-analysis.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-analysis-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gfs-analysis.ipynb",
  },

  // noaa-gfs-forecast
  {
    modelId: "noaa-gfs",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present GFS forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run. Each forecast steps forward in time along the
        <code>lead_time</code> dimension.
        </p>
      `,
    descriptionDetails: `
        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-gfs-bdp-pds/">AWS Open Data Registry</a>.
        Operational data is additionally accessed from <a href="https://nomads.ncep.noaa.gov/">NOAA NOMADS</a>.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gfs/forecast/template_config.py">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/noaa/gfs/forecast/latest.zarr",
    status: "live",
    license: CC_BY_4,
    examples: [
      {
        title: "Maximum temperature in a forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/gfs/forecast/latest.zarr")
ds["temperature_2m"].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-forecast.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gfs-forecast-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gfs-forecast.ipynb",
  },

  // noaa-gefs-forecast-35-day
  {
    modelId: "noaa-gefs",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present GEFS forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run as well as by the <code>ensemble_member</code>.
        Each forecast has a 3 hourly forecast step along the <code>lead_time</code>
        dimension. This dataset contains only the 00 hour UTC initialization times
        which produce the full length, 35 day forecast.
        </p>
      `,
    descriptionDetails: `
        <h3>Interpolation</h3>
        <p>
        Source data is available at both 0.25-degree and 0.5-degree resolutions.
        All variables except the 100m wind components are derived
        from a 0.25-degree grid for the first 240 hours of each forecast and from a
        0.5-degree grid for the remainder. 100m wind components are derived from
        a 0.5-degree grid for all lead times. Bilinear interpolation is used to convert
        0.5-degree data to a 0.25-degree grid. The original 0.5-degree values can be
        retrieved by selecting every other pixel starting from offset 0 in both the
        latitude and longitude dimensions (e.g. <code>array[::2, ::2]</code>).
        </p>

        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-gefs/">AWS Open Data Registry</a>.
        Operational data is additionally accessed from <a href="https://nomads.ncep.noaa.gov/">NOAA NOMADS</a>.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gefs/common_gefs_template_config.py">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr",
    status: "live",
    license: CC_BY_4,
    examples: [
      {
        title: "Maximum temperature in ensemble forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/gefs/forecast-35-day/latest.zarr")
ds["temperature_2m"].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-forecast-35-day.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-forecast-35-day-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gefs-forecast-35-day.ipynb",
  },

  // noaa-gefs-analysis
  {
    modelId: "noaa-gefs",
    descriptionSummary: `
        <p>
        This analysis dataset is an archive of the model's best estimate of past weather.
        It is created by concatenating the first few hours of each historical forecast to
        provide a dataset with dimensions time, latitude, and longitude.
        </p>
      `,
    descriptionDetails: `
        <h3>Sources</h3>
        <p>
        To provide the longest possible historical record, this dataset in constructed
        from three distinct GEFS forecast archives.
        </p>
        <ul>
          <li>From 2000-01-01 to 2019-12-31 we use the <a href="https://registry.opendata.aws/noaa-gefs-reforecast/">GEFS reforecast</a>.</li>
          <li>From 2020-01-01 to 2020-09-23 we use <a href="https://registry.opendata.aws/noaa-gefs/">GEFS forecast archive</a> data which has a lower spatial and temporal resolution.</li>
          <li>From 2020-09-23 to Present we use <a href="https://registry.opendata.aws/noaa-gefs/">GEFS operational forecast archives</a>.</li>
        </ul>

        <p>
        Source files are provided by <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-gefs/">AWS Open Data Registry</a>.
        Operational data is additionally accessed from <a href="https://nomads.ncep.noaa.gov/">NOAA NOMADS</a>.
        </p>

        <h3>Variable availability</h3>
        <p>
        Data is available for all variables at all times with the following exceptions.
        </p>
        <ul>
          <li>Unavailable before 2020-01-01:
            <code>relative_humidity_2m</code>,
            <code>percent_frozen_precipitation_surface</code>,
            <code>categorical_freezing_rain_surface</code>,
            <code>categorical_ice_pellets_surface</code>,
            <code>categorical_rain_surface</code>,
            <code>categorical_snow_surface</code>
          </li>
          <li>Unavailable 2020-01-01T00 to 2020-09-22T21:
            <code>geopotential_height_cloud_ceiling</code>
          </li>
        </ul>

        <h3>Construction</h3>
        <p>
        To create a single time dimension we concatenate the first few hours of each forecast.
        From 2000-01-01 to 2019-12-31 reforecasts are available once per day and this dataset
        uses the first 21 or 24 hours of each forecast. From 2020-01-01 to present forecasts
        are available every 6 hours and this dataset uses the first 3 or 6 hours of each forecast.
        Variables with an instantaneous <code>step_type</code> use the shortest possible lead times
        (e.g. 0 and 3 hours) while accumulated variables must use one additional forecast
        step (e.g. 3 and 6 hours) because they do not have an hour 0 forecast value.
        </p>

        <h3>Interpolation</h3>
        <p>
        For most of the time range of the archive the source data is available at 0.25-degree
        resolution and a 3 hourly time step and we perform no interpolation. There are two
        exceptions to this. 1) From 2020-01-01 to 2020-09-23 the source data has a 1.0-degree
        spatial resolution and a 6 hourly time step. 2) From 2020-09-23 to present the 100m
        wind components have a 0.5-degree spatial resolution in the source data.
        To provide a consistent archive in the above two cases we first perform bilinear
        interpolation in space to 0.25-degree resolution followed by linear interpolation in time
        to a 3-hourly timestep if necessary. The original, uninterpolated data can be obtained
        by selecting latitudes and longitudes evenly divisible by 1 and, in case 1), time steps
        whose hour is divisible by 6.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/noaa/gefs/common_gefs_template_config.py">reformatting code</a>.
        </p>

      `,
    url: "https://data.dynamical.org/noaa/gefs/analysis/latest.zarr",
    status: "live",
    license: CC_BY_4,
    examples: [
      {
        title: "Temperature at a specific place and time",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/gefs/analysis/latest.zarr")
ds["temperature_2m"].sel(time="2025-01-01T00", latitude=0, longitude=0).compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-analysis.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-gefs-analysis-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-gefs-analysis.ipynb",
  },

  // noaa-hrrr-forecast-48-hour
  {
    modelId: "noaa-hrrr",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present HRRR forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run.
        Each forecast has an hourly forecast step along the <code>lead_time</code>
        dimension. This dataset contains only the 00, 06, 12, and 18 hour UTC
        initialization times which produce the full length, 48 hour forecast.
        </p>

        <p>
        This dataset uses the native HRRR Lambert Conformal Conic projection,
        with spatial indexing along the <code>x</code> and <code>y</code> dimensions.
        The example notebook shows how to use the embedded spatial reference to
        select geographic areas of interest.
        </p>
      `,
    descriptionDetails: `
        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-hrrr-pds/">AWS Open Data Registry</a>.
        Operational data is additionally accessed from <a href="https://nomads.ncep.noaa.gov/">NOAA NOMADS</a>.
        </p>

        <h3>Data availability</h3>
        <p>
        Forecasts initialized through 2020-12-02T06 UTC include data
        only for the first 36 hours; steps 37–48 are filled with NaNs. Starting with
        the 2020-12-02T12 UTC initialization, forecasts cover the full 48 hours.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/">reformatting code</a>.
        </p>

      `,
    url: "https://data.dynamical.org/noaa/hrrr/forecast-48-hour/latest.zarr",
    status: "live",
    license: CC_BY_4,
    examples: [
      {
        title: "Maximum temperature in a forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/hrrr/forecast-48-hour/latest.zarr")
ds["temperature_2m"].sel(init_time="2025-01-01T00", x=0, y=0, method="nearest").max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-hrrr-forecast-48-hour.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-hrrr-forecast-48-hour-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-hrrr-forecast-48-hour.ipynb",
  },

  // noaa-hrrr-analysis
  {
    modelId: "noaa-hrrr",
    descriptionSummary: `
        <p>
        This analysis dataset is an archive of the model's best estimate of past weather.
        It is created by concatenating the first hour of each historical forecast to
        provide a dataset with dimensions time, x, and y.
        </p>

        <p>
        This dataset uses the native HRRR Lambert Conformal Conic projection,
        with spatial indexing along the <code>x</code> and <code>y</code> dimensions.
        The example notebook shows how to use the embedded spatial reference to
        select geographic areas of interest.
        </p>
      `,
    descriptionDetails: `
        <h3>Construction</h3>
        <p>
        HRRR starts a new model run every hour and
        dynamical.org has created this analysis by concatenating the first step
        of each forecast along the time dimension. Accumulated variables
        (e.g. precipitation) are read from the second step of the previous
        hour's forecast.
        </p>

        <h3>Data availability</h3>
        <p>
        There are a significant number of missing source files before August 2018 (HRRR v1 and v2 period),
        and a small number from August 2018 to December 2020 (HRRR v3 period).
        </p>

        <p>
        <code>downward_long_wave_radiation_flux_surface</code> and <code>relative_humidity_2m</code> are
        unavailable before August 2016 (HRRR v1 period).
        </p>

        <p>
        This dataset has NaN values where source data are unavailable.
        </p>

        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-hrrr-pds/">AWS Open Data Registry</a>.
        Operational data is additionally accessed from <a href="https://nomads.ncep.noaa.gov/">NOAA NOMADS</a>.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/">reformatting code</a>.
        </p>

      `,
    url: "https://data.dynamical.org/noaa/hrrr/analysis/latest.zarr",
    status: "live",
    license: CC_BY_4,
    examples: [
      {
        title: "Temperature at a specific place and time",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/hrrr/analysis/latest.zarr")
ds["temperature_2m"].sel(time="2025-01-01T00", x=0, y=0, method="nearest").compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-hrrr-analysis.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-hrrr-analysis-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-hrrr-analysis.ipynb",
  },

  // noaa-mrms-conus-analysis-hourly
  {
    modelId: "noaa-mrms",
    descriptionSummary: `
        <p>
        This analysis dataset is an archive of MRMS radar and multi-sensor
        precipitation and weather analyses over the contiguous United States (CONUS).
        </p>
      `,
    descriptionDetails: `
        <h3>Spatial coverage</h3>
        <p>
        Use this dataset over the land areas of the contiguous United States. Radar-only and
        precipitation type variables contain <code>NaN</code> values beyond the range of US radar.
        <code>precipitation_pass_1_surface</code> and <code>precipitation_pass_2_surface</code> extend further
        into the ocean, but still contain <code>NaN</code> values in the southeast corner of the domain
        over the Atlantic.
        </p>

        <h3>Temporal coverage</h3>
        <p>
        <code>precipitation_surface</code> combines multiple MRMS products to minimize missing values.
        Despite this, some hours (particularly early in the record) contain <code>NaN</code> values where
        data is unavailable.
        </p>

        <p>
        <code>precipitation_pass_2_surface</code> and <code>precipitation_pass_1_surface</code> are available
        starting 2020-10-15. For timestamps prior to this date, these variables are filled with <code>NaN</code>.
        </p>

        <h3>Source</h3>
        <p>
        The source files this archive is constructed from are provided by
        <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination (NODD)</a>
        and accessed from the <a href="https://registry.opendata.aws/noaa-mrms-pds/">AWS Open Data Registry</a>.
        Operational data is additionally accessed from <a href="https://mrms.ncep.noaa.gov/">NCEP</a>.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/noaa/mrms/conus-analysis-hourly/latest.zarr",
    status: "live",
    license: CC_BY_4,
    examples: [
      {
        title: "Precipitation at a place and time",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/noaa/mrms/conus-analysis-hourly/latest.zarr")
ds["precipitation_surface"].sel(time="2026-01-01T00", latitude=40, longitude=-90, method="nearest").compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-mrms-conus-analysis-hourly.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/noaa-mrms-conus-analysis-hourly-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/noaa-mrms-conus-analysis-hourly.ipynb",
  },

  // dwd-icon-eu-forecast-5-day
  {
    modelId: "dwd-icon-eu",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present ICON-EU forecasts. Forecasts
        are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run and step forward in time along the
        <code>lead_time</code> dimension. This dataset contains only the 00, 06, 12,
        and 18 hour UTC initialization times which produce the full length, 5 day
        forecast.
        </p>
      `,
    descriptionDetails: `
        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.dwd.de/EN/ourservices/opendata/opendata.html">DWD Open Data</a>
        and the <a href="https://source.coop/dynamical/dwd-icon-grib">dynamical.org DWD ICON grib archive</a>
        on <a href="https://source.coop/">Source Cooperative</a>.
        </p>

        <h3>Storage</h3>
        <p>
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        Storage for the dynamical.org DWD ICON-EU grib archive is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>, a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/dwd/icon_eu/forecast_5_day/template_config.py">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/dwd/icon-eu/forecast-5-day/latest.zarr",
    status: "coming soon",
    license: CC_BY_4,
    examples: [
      {
        title: "Maximum temperature in a forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/dwd/icon-eu/forecast-5-day/latest.zarr")
ds["temperature_2m"].sel(init_time="2026-04-01T00", latitude=50, longitude=10).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/dwd-icon-eu-forecast-5-day-icechunk.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/dwd-icon-eu-forecast-5-day-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/dwd-icon-eu-forecast-5-day-icechunk.ipynb",
  },

  // ecmwf-aifs-single-forecast
  {
    modelId: "ecmwf-aifs-single",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present ECMWF AIFS Single forecasts.
        Forecasts are identified by an initialization time (<code>init_time</code>) denoting the
        start time of the model run. Each forecast steps forward in time along the
        <code>lead_time</code> dimension, from 0 to 360 hours (15 days) at a 6 hourly step.
        </p>
      `,
    descriptionDetails: `
        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data">ECMWF Open Data</a>
        and accessed from the <a href="https://registry.opendata.aws/ecmwf-forecasts/">AWS Open Data Registry</a>.
        </p>
        <p>ECMWF does not provide user support for the free & open datasets. Users should refer to the public <a href='https://forum.ecmwf.int/'>User Forum</a> for any questions related to the source material.</p>

        <h3>Model updates</h3>
        <p>
        AIFS is updated regularly. Find details of recent and upcoming
        <a href="https://confluence.ecmwf.int/display/FCST/Changes+to+the+forecasting+system">changes to the forecasting system</a> on the ECMWF website.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/ecmwf/aifs_single/forecast/template_config.py">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/ecmwf/aifs-single/forecast/latest.zarr",
    status: "live",
    license: `
        <p>
        This data is based on data and products of the European Centre for
        Medium-Range Weather Forecasts (ECMWF). Use is governed by the
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> license
        and the ECMWF <a href="https://apps.ecmwf.int/datasets/licences/general/">Terms of Use</a>.
        </p>
    `,
    examples: [
      {
        title: "Maximum temperature in a forecast",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/ecmwf/aifs-single/forecast/latest.zarr")
ds["temperature_2m"].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/ecmwf-aifs-single-forecast.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/ecmwf-aifs-single-forecast-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/ecmwf-aifs-single-forecast.ipynb",
  },

  // ecmwf-ifs-ens-forecast-15-day-0-25-degree
  {
    modelId: "ecmwf-ifs-ens",
    descriptionSummary: `
        <p>
        This dataset is an archive of past and present ECMWF IFS ENS forecasts.
        Forecasts are identified by an initialization time (<code>init_time</code>) 
        denoting the start time of the model run, as well as by the 
        <code>ensemble_member</code>. Along the <code>lead_time</code> dimension, 
        each forecast begins at a 3 hourly forecast step (0-144 hours) and switches 
        to a 6 hourly step for days 6 through 15 of the forecast (hours 144-360).
        This dataset contains the 00 UTC initialization times only.
        </p>
      `,
    descriptionDetails: `
        <h3>Source</h3>
        <p>
        The source grib files this archive is constructed from are provided by
        <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data">ECMWF Open Data</a>
        and accessed from the <a href="https://registry.opendata.aws/ecmwf-forecasts/">AWS Open Data Registry</a>.
        </p>
        <p>ECMWF does not provide user support for the free & open datasets. Users should refer to the public <a href='https://forum.ecmwf.int/'>User Forum</a> for any questions related to the source meterial.</p>

        <h3>Data availability</h3>
        <p>
        This dataset contains only forecasts initialized on or after 2024-04-01, 
        which are available at the open data 0.25 degree (~20km) resolution.
        All variables are available for the full period, save for 
        <code>precipitation_surface</code>, which is filled with NaNs 
        before 2024-11-13 UTC.
        </p>

        <h3>Ensemble members</h3>
        <p>
        Each forecast contains 51 ensemble members, including a control member (0) 
        and 50 perturbed members (1-50). The control forecast is produced with 
        the best available data and unperturbed models. The other 50 members 
        are each produced with slight perturbations of initial conditions 
        and of the models. Taken together, ensemble of 51 forecasts shows 
        the range of possible outcomes and the likelihood of their occurrence.
        </p>

        <h3>Model updates</h3>
        <p>
        IFS is updated regularly. Find details of recent and upcoming
        <a href="https://confluence.ecmwf.int/display/FCST/Changes+to+the+forecasting+system">changes to the forecasting system</a> on the ECMWF website.
        </p>

        <h3>Storage</h3>
        <p>
        Storage for this dataset is generously provided by
        <a href="https://source.coop/">Source Cooperative</a>,
        a <a href="https://radiant.earth/">Radiant Earth</a> initiative.
        Icechunk storage generously provided by <a href="https://aws.amazon.com/opendata/">AWS Open Data</a>.
        </p>

        <h3>Compression</h3>
        <p>
        The data values in this dataset have been rounded in their binary
        floating point representation to improve compression. See
        <a href="https://www.nature.com/articles/s43588-021-00156-2">Klöwer et al. 2021</a>
        for more information on this approach. The exact number of rounded bits
        can be found in our
        <a href="https://github.com/dynamical-org/reformatters/blob/main/src/reformatters/ecmwf/ifs_ens/forecast_15_day_0_25_degree/template_config.py">reformatting code</a>.
        </p>
      `,
    url: "https://data.dynamical.org/ecmwf/ifs-ens/forecast-15-day-0-25-degree/latest.zarr",
    status: "live",
    license: `
        <p>
        This data is based on data and products of the European Centre for
        Medium-Range Weather Forecasts (ECMWF). Use is governed by the
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> license
        and the ECMWF <a href="https://apps.ecmwf.int/datasets/licences/general/">Terms of Use</a>.
        </p>
    `,
    examples: [
      {
        title: "Maximum temperature in ensemble",
        code: `
import xarray as xr  # xarray>=2025.1.2 and zarr>=3.0.8 for zarr v3 support

ds = xr.open_zarr("https://data.dynamical.org/ecmwf/ifs-ens/forecast-15-day-0-25-degree/latest.zarr")
ds["temperature_2m"].sel(init_time="2025-01-01T00", latitude=0, longitude=0).max().compute()
    `,
      },
    ],
    githubUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/ecmwf-ifs-ens-forecast-15-day-0-25-degree.ipynb",
    githubIcechunkUrl:
      "https://github.com/dynamical-org/notebooks/blob/main/ecmwf-ifs-ens-forecast-15-day-0-25-degree-icechunk.ipynb",
    colabUrl:
      "https://colab.research.google.com/github/dynamical-org/notebooks/blob/main/ecmwf-ifs-ens-forecast-15-day-0-25-degree.ipynb",
  },
].filter((entry) => !entry.hide);

/**
 * Convert HTML descriptionDetails to markdown
 * @param {string} html - HTML string to convert
 * @returns {string} - Markdown string
 */
function htmlToMarkdown(html) {
  if (!html) return "";

  let md = html;
  // Replace <a href="url">text</a> with [text](url)
  md = md.replace(/<a href=["']([^"']+)["']>(.*?)<\/a>/g, "[$2]($1)");
  // Replace <code>text</code> with `text`
  md = md.replace(/<code>(.*?)<\/code>/g, "`$1`");
  // Replace <h1>title</h1> with # title\n
  md = md.replace(/<h1>(.*?)<\/h1>/g, "# $1\n");
  // Replace <h2>title</h2> with ## title\n
  md = md.replace(/<h2>(.*?)<\/h2>/g, "## $1\n");
  // Replace <h3>title</h3> with ### title\n
  md = md.replace(/<h3>(.*?)<\/h3>/g, "### $1\n");
  // Replace <h4>title</h4> with #### title\n
  md = md.replace(/<h4>(.*?)<\/h4>/g, "#### $1\n");
  // Replace <p> with newline
  md = md.replace(/<p>/g, "\n");
  // Replace </p> with newline
  md = md.replace(/<\/p>/g, "\n");
  // Replace <ul> with newline
  md = md.replace(/<ul>/g, "\n");
  // Replace </ul> with newline
  md = md.replace(/<\/ul>/g, "\n");
  // Replace <li> with - (markdown list item)
  md = md.replace(/<li>/g, "* ");
  // Replace </li> with newline
  md = md.replace(/<\/li>/g, "\n");

  // Clean up whitespace: split into lines, trim each, remove excessive blank lines
  const lines = md.split("\n").map(line => line.trim());
  const cleanedLines = [];
  let prevWasEmpty = false;

  for (const line of lines) {
    const isEmpty = line === "";
    if (isEmpty && prevWasEmpty) {
      // Skip consecutive empty lines
      continue;
    }
    cleanedLines.push(line);
    prevWasEmpty = isEmpty;
  }

  return cleanedLines.join("\n").trim();
}

module.exports = async function () {
  // Convert descriptionDetails to markdown for each entry
  entries.forEach((entry) => {
    if (entry.descriptionDetails) {
      entry.descriptionDetailsMd = htmlToMarkdown(entry.descriptionDetails);
    }
    if (entry.license) {
      entry.licenseMd = htmlToMarkdown(entry.license);
    }
  });

  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].url) {
      continue;
    }

    const slug = stacSlugFromUrl(entries[i].url);
    let collection;
    try {
      collection = await fetchStacCollection(slug);
    } catch (e) {
      // Tolerate only 404 (dataset not yet ingested into STAC). Any other
      // failure — network, 5xx, malformed JSON — should fail the build
      // rather than silently publish a page missing its metadata tables.
      if (e.cause?.status !== 404) throw e;
      console.log(`No STAC collection for ${slug}: ${e.message}`);
      entries[i].dataset_id = entries[i].dataset_id || slug;
      entries[i].name = entries[i].name || slug;
      continue;
    }
    entries[i] = { ...entries[i], ...reshapeStacCollection(collection) };
  }

  // Group datasets by model
  const modelGroups = {};
  entries.forEach((dataset) => {
    if (dataset.modelId) {
      if (!modelGroups[dataset.modelId]) {
        modelGroups[dataset.modelId] = {
          ...models[dataset.modelId],
          id: dataset.modelId,
          datasets: [],
        };
      }
      modelGroups[dataset.modelId].datasets.push(dataset);
    }
  });

  // Add related datasets to each entry
  entries.forEach((dataset) => {
    if (dataset.modelId && modelGroups[dataset.modelId]) {
      dataset.relatedDatasets = modelGroups[dataset.modelId].datasets
        .filter((d) => d.dataset_id !== dataset.dataset_id)
        .map((d) => ({
          name: d.name,
          dataset_id: d.dataset_id,
          descriptionSummary: d.descriptionSummary,
        }));
      dataset.model = models[dataset.modelId];
    }
  });

  return {
    entries,
    models: Object.values(modelGroups),
  };
};

// e.g. https://data.dynamical.org/noaa/gfs/analysis/latest.zarr → noaa-gfs-analysis
function stacSlugFromUrl(url) {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
  return path.replace(/\/[^/]+\.zarr$/, "").split("/").join("-");
}

function fetchStacCollection(slug) {
  return fetch(`https://stac.dynamical.org/${slug}/collection.json`, { type: "json" });
}

// Reshape a STAC Collection into the object templates consume
// (dataset attributes + dimensions + variables).
function reshapeStacCollection(collection) {
  const cubeDims = collection["cube:dimensions"] || {};
  const cubeVars = collection["cube:variables"] || {};

  const dimensions = Object.entries(cubeDims).map(([name, d]) => {
    const [min, max] = d.extent ?? [null, null];
    return {
      name,
      units: d.unit,
      statistics_approximate: { min, max },
    };
  });

  const variables = Object.entries(cubeVars).map(([name, v]) => ({
    name,
    long_name: v.description,
    short_name: v.short_name,
    comment: v.comment,
    units: v.unit,
    dimension_names: v.dimensions,
  }));

  const summaryValue = (key) => {
    const value = (collection.summaries || {})[key];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    name: collection.title,
    dataset_id: collection.id,
    attribution: collection.attribution,
    spatial_domain: summaryValue("spatial_domain"),
    spatial_resolution: summaryValue("spatial_resolution"),
    time_domain: summaryValue("time_domain"),
    time_resolution: summaryValue("time_resolution"),
    forecast_domain: summaryValue("forecast_domain"),
    forecast_resolution: summaryValue("forecast_resolution"),
    dimensions,
    variables,
  };
}
