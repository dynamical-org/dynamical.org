"""Write test/fixtures/explorer-store/, a tiny Icechunk repo shaped like GFS forecast.

The explorer e2e spec (test/e2e/explorer.spec.mjs) serves this directory in place of
the real S3 store, so it copies the real store's layout: the same array names,
dimension names, attributes, codecs (sharding + blosc zstd, crc32c index at the end)
and CF spatial_ref. Only the sizes shrink, to 2 init × 6 lead × 16 lat × 32 lon with
inner chunks (1, 3, 8, 16), so a lead block is 3 steps and lead 3 starts the second.

The grid keeps GFS's shape at 12° × 11.25°: latitude 90 → -90 (cell centres, poles
included), longitude -180 → 168.75.

temperature_2m is uniform per (init, lead) so a sampled pixel says which step drew:
the latest init (index 1) is LATEST_INIT_C[lead] and the older one 7.5 °C warmer.
One cell, KNOWN_CELL (lat 42, lon -101.25, inside the CONUS view), is -40 °C at every
step, the cold end of the -40..50 °C scale, so it stands out against every lead.

The other arrays each exercise one thing the explorer must handle:
- relative_humidity_2m: a second forecast variable to switch to, in percent (so
  its colour range is sampled, not the fixed Celsius one). It rises 5 % per
  latitude row plus 1 % per lead.
- temperature_isobaric: an extra pressure_level dim (500, 850 hPa), for the level
  select. It is -30 °C at 500 hPa and 10 °C at 850 hPa everywhere.
- total_cloud_cover_atmosphere: int16 with a finite fill_value (-1) sentinel, 0..100
  across longitude, and -1 (missing) at KNOWN_CELL.
- temperature_2m_analysis: a time-only analysis array on its own `time` dim, 300
  hourly steps in one chunk, larger than a 128-step texture window. Step t is
  -40 + 90 * t / 299 °C, so the latest step is 50 °C and every step differs.
- temperature_2m_analysis_partial: the same, but written only through step
  PARTIAL_LAST (150); later steps are NaN inside the same written chunk. Its
  newest data is more than a 128-step texture window before the last time, so
  an explorer that trusts "the chunk exists" opens on a blank step.

Icechunk writes random object ids, so rerunning rewrites every file. Run from the
repo root:

    uv run --with icechunk==2.2.2 --with zarr==3.4.0 --with numpy test/fixtures/make-explorer-store.py
"""

import shutil
from pathlib import Path

import icechunk
import numpy as np
import zarr
from zarr.codecs import BloscCodec, ZstdCodec

OUT = Path(__file__).parent / "explorer-store"

INIT_TIMES = np.array(["2026-09-25T06:00", "2026-09-25T12:00"], dtype="datetime64[s]")
LEAD_HOURS = np.arange(6)
LATITUDE = 90.0 - 12.0 * np.arange(16)
LONGITUDE = -180.0 + 11.25 * np.arange(32)

LATEST_INIT_C = [-25.0, -10.0, 5.0, 20.0, 35.0, 50.0]
OLDER_INIT_OFFSET_C = 7.5
KNOWN_CELL = (4, 7)  # (latitude index, longitude index)
KNOWN_CELL_C = -40.0

PRESSURE_LEVELS = np.array([500.0, 850.0], dtype="float32")
ISOBARIC_C = [-30.0, 10.0]
CLOUD_FILL = -1
ANALYSIS_TIMES = np.datetime64("2026-09-13T00:00", "s") + np.arange(
    300
) * np.timedelta64(1, "h")

FORECAST_DIMS = ["init_time", "lead_time", "latitude", "longitude"]

NAN_FILL = "AAAAAAAA+H8="
SPHERE_WKT = (
    'GEOGCS["unknown",DATUM["unknown",SPHEROID["unknown",6371229,0]],'
    'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
    'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
    'AXIS["Longitude",EAST],AXIS["Latitude",NORTH]]'
)
PARTIAL_LAST = 150


def blosc(typesize: int) -> BloscCodec:
    return BloscCodec(
        typesize=typesize, cname="zstd", clevel=3, shuffle="shuffle", blocksize=0
    )


def coordinate(
    group: zarr.Group, name: str, data: np.ndarray, dims: list[str], attributes: dict
) -> None:
    fill_value = np.nan if data.dtype.kind == "f" else 0
    group.create_array(
        name,
        data=data,
        chunks=data.shape,
        compressors=[blosc(data.dtype.itemsize)],
        fill_value=fill_value,
        dimension_names=dims,
        attributes=attributes,
    )


def temperature() -> np.ndarray:
    field = np.empty(
        (len(INIT_TIMES), len(LEAD_HOURS), len(LATITUDE), len(LONGITUDE)),
        dtype="float32",
    )
    for lead, value in enumerate(LATEST_INIT_C):
        field[1, lead] = value
        field[0, lead] = value + OLDER_INIT_OFFSET_C
    field[:, :, KNOWN_CELL[0], KNOWN_CELL[1]] = KNOWN_CELL_C
    return field


def forecast_shape() -> tuple[int, int, int, int]:
    return (len(INIT_TIMES), len(LEAD_HOURS), len(LATITUDE), len(LONGITUDE))


def relative_humidity() -> np.ndarray:
    rows = 5.0 * np.arange(len(LATITUDE))[:, None] + np.zeros(len(LONGITUDE))
    leads = np.arange(len(LEAD_HOURS))[:, None, None]
    return np.broadcast_to(rows + leads, forecast_shape()).astype("float32")


def temperature_isobaric() -> np.ndarray:
    shape = (
        len(INIT_TIMES),
        len(LEAD_HOURS),
        len(PRESSURE_LEVELS),
        len(LATITUDE),
        len(LONGITUDE),
    )
    field = np.empty(shape, dtype="float32")
    for level, value in enumerate(ISOBARIC_C):
        field[:, :, level] = value
    return field


def cloud_cover() -> np.ndarray:
    columns = np.round(np.linspace(0, 100, len(LONGITUDE))).astype("int16")
    field = np.broadcast_to(columns, forecast_shape()).copy()
    field[:, :, KNOWN_CELL[0], KNOWN_CELL[1]] = CLOUD_FILL
    return field


def temperature_analysis() -> np.ndarray:
    steps = -40.0 + 90.0 * np.arange(len(ANALYSIS_TIMES)) / (len(ANALYSIS_TIMES) - 1)
    field = np.empty(
        (len(ANALYSIS_TIMES), len(LATITUDE), len(LONGITUDE)), dtype="float32"
    )
    field[:] = steps[:, None, None]
    return field


def temperature_analysis_partial() -> np.ndarray:
    field = temperature_analysis()
    field[PARTIAL_LAST + 1 :] = np.nan
    return field


def data_array(
    group: zarr.Group,
    name: str,
    data: np.ndarray,
    dims: list[str],
    chunks: tuple[int, ...],
    shards: tuple[int, ...],
    attributes: dict,
    fill_value: float = np.nan,
) -> None:
    group.create_array(
        name,
        data=data,
        chunks=chunks,
        shards=shards,
        compressors=[blosc(data.dtype.itemsize)],
        fill_value=fill_value,
        dimension_names=dims,
        attributes=attributes,
    )


def main() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    # Store every chunk as its own object, as the real repo does for data this
    # size; the default would inline these tiny shards into the manifest and the
    # e2e would never see a range read.
    config = icechunk.RepositoryConfig.default()
    config.inline_chunk_threshold_bytes = 0
    repo = icechunk.Repository.create(
        icechunk.local_filesystem_storage(str(OUT)), config=config
    )
    session = repo.writable_session("main")
    root = zarr.group(store=session.store, zarr_format=3)
    root.attrs.update(
        {
            "dataset_id": "noaa-gfs-forecast",
            "name": "Explorer e2e fixture shaped like NOAA GFS forecast",
        }
    )

    coordinate(
        root,
        "init_time",
        INIT_TIMES.astype("int64"),
        ["init_time"],
        {
            "long_name": "Forecast initialization time",
            "standard_name": "forecast_reference_time",
            "units": "seconds since 1970-01-01",
            "calendar": "proleptic_gregorian",
        },
    )
    coordinate(
        root,
        "lead_time",
        (LEAD_HOURS * 3600).astype("float64"),
        ["lead_time"],
        {
            "long_name": "Forecast lead time",
            "standard_name": "forecast_period",
            "dtype": "timedelta64[us]",
            "units": "seconds",
            "_FillValue": NAN_FILL,
        },
    )
    coordinate(
        root,
        "latitude",
        LATITUDE,
        ["latitude"],
        {
            "long_name": "Latitude",
            "standard_name": "latitude",
            "axis": "Y",
            "units": "degree_north",
            "_FillValue": NAN_FILL,
        },
    )
    coordinate(
        root,
        "longitude",
        LONGITUDE,
        ["longitude"],
        {
            "long_name": "Longitude",
            "standard_name": "longitude",
            "axis": "X",
            "units": "degree_east",
            "_FillValue": NAN_FILL,
        },
    )
    valid = INIT_TIMES.astype("int64")[:, None] + LEAD_HOURS[None, :] * 3600
    coordinate(
        root,
        "valid_time",
        valid,
        ["init_time", "lead_time"],
        {
            "long_name": "Valid time",
            "standard_name": "time",
            "units": "seconds since 1970-01-01",
            "calendar": "proleptic_gregorian",
        },
    )
    root.create_array(
        "spatial_ref",
        data=np.array(0, dtype="int64"),
        compressors=[ZstdCodec(level=0, checksum=False)],
        fill_value=0,
        attributes={
            "crs_wkt": SPHERE_WKT,
            "semi_major_axis": 6371229.0,
            "semi_minor_axis": 6371229.0,
            "inverse_flattening": 0.0,
            "reference_ellipsoid_name": "unknown",
            "longitude_of_prime_meridian": 0.0,
            "prime_meridian_name": "Greenwich",
            "geographic_crs_name": "unknown",
            "horizontal_datum_name": "unknown",
            "grid_mapping_name": "latitude_longitude",
            "spatial_ref": SPHERE_WKT,
        },
    )
    coordinate(
        root,
        "pressure_level",
        PRESSURE_LEVELS,
        ["pressure_level"],
        {"long_name": "Pressure level", "units": "hPa", "_FillValue": NAN_FILL},
    )
    coordinate(
        root,
        "time",
        ANALYSIS_TIMES.astype("int64"),
        ["time"],
        {
            "long_name": "Time",
            "standard_name": "time",
            "units": "seconds since 1970-01-01",
            "calendar": "proleptic_gregorian",
        },
    )
    data_array(
        root,
        "temperature_2m",
        temperature(),
        FORECAST_DIMS,
        chunks=(1, 3, 8, 16),
        shards=(1, 6, 16, 32),
        attributes={
            "long_name": "2 metre temperature",
            "short_name": "2t",
            "standard_name": "air_temperature",
            "units": "degree_Celsius",
            "step_type": "instant",
            "coordinates": "spatial_ref valid_time",
            "_FillValue": NAN_FILL,
        },
    )
    data_array(
        root,
        "relative_humidity_2m",
        relative_humidity(),
        FORECAST_DIMS,
        chunks=(1, 3, 8, 16),
        shards=(1, 6, 16, 32),
        attributes={
            "long_name": "2 metre relative humidity",
            "short_name": "2r",
            "units": "percent",
            "step_type": "instant",
            "coordinates": "spatial_ref valid_time",
            "_FillValue": NAN_FILL,
        },
    )
    data_array(
        root,
        "temperature_isobaric",
        temperature_isobaric(),
        ["init_time", "lead_time", "pressure_level", "latitude", "longitude"],
        chunks=(1, 3, 1, 8, 16),
        shards=(1, 6, 2, 16, 32),
        attributes={
            "long_name": "Temperature",
            "short_name": "t",
            "units": "degree_Celsius",
            "step_type": "instant",
            "coordinates": "spatial_ref valid_time",
            "_FillValue": NAN_FILL,
        },
    )
    data_array(
        root,
        "total_cloud_cover_atmosphere",
        cloud_cover(),
        FORECAST_DIMS,
        chunks=(1, 3, 8, 16),
        shards=(1, 6, 16, 32),
        fill_value=CLOUD_FILL,
        attributes={
            "long_name": "Total cloud cover",
            "short_name": "tcc",
            "units": "percent",
            "step_type": "avg",
            "coordinates": "spatial_ref valid_time",
        },
    )
    data_array(
        root,
        "temperature_2m_analysis",
        temperature_analysis(),
        ["time", "latitude", "longitude"],
        chunks=(300, 8, 16),
        shards=(300, 16, 32),
        attributes={
            "long_name": "2 metre temperature (analysis)",
            "short_name": "2t",
            "units": "degree_Celsius",
            "step_type": "instant",
            "coordinates": "spatial_ref",
            "_FillValue": NAN_FILL,
        },
    )

    data_array(
        root,
        "temperature_2m_analysis_partial",
        temperature_analysis_partial(),
        ["time", "latitude", "longitude"],
        chunks=(300, 8, 16),
        shards=(300, 16, 32),
        attributes={
            "long_name": "2 metre temperature (analysis, partly written)",
            "short_name": "2t",
            "units": "degree_Celsius",
            "step_type": "instant",
            "coordinates": "spatial_ref",
            "_FillValue": NAN_FILL,
        },
    )

    session.commit("explorer e2e fixture")
    # Icechunk's local backend keeps a copy of each replaced repo file; the
    # browser never reads it.
    shutil.rmtree(OUT / "overwritten", ignore_errors=True)


if __name__ == "__main__":
    main()
