# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "eccodes==2.48.0",
#   "eccodeslib==2.49.0.30",
#   "gribberish==1.8.4",
#   "numpy==2.5.3",
#   "zarr==3.4.0",
# ]
# ///
"""Regenerate the GRIB2 fixtures and expected values for explorer/test/explorer-grib.test.mjs.

    uv run explorer/test/fixtures/grib/make_fixtures.py

The global fixtures start from real messages that virtual stores reference, subsampled
to a 4° global grid (46 x 90) and re-encoded with eccodes in one data representation
template. The tiny RRFS/REFS regressions come unchanged from the pinned upstream release:
two complete REFS zero-group constant messages and a reduced PEVAP message retaining its
original packed data. The expected values come from gribberish's own
Python zarr codec (the one that wrote the stores' metadata), run through zarr on the fixture
bytes with the codec configuration the stores use. That makes the JS test a check against
the reference implementation, not against itself.

The AIFS source lives on ECMWF's open-data bucket, which only keeps recent runs. Once it
has aged out, point AIFS_T2M at a newer message; the committed fixtures stay valid. Before
refreshing sources, use --check to compare existing expectations with the pinned codec.
"""

import argparse
import hashlib
import json
from importlib.metadata import version
import urllib.request
from pathlib import Path

import eccodes
import numpy as np
import zarr
from gribberish.zarr import GribberishCodec
from zarr.core.buffer import cpu
from zarr.core.sync import sync

HERE = Path(__file__).resolve().parent
STEP = 16  # 0.25° -> 4°

# (url, offset, length) of real messages referenced by the virtual stores on 2026-09-25.
GFS = "https://noaa-gfs-bdp-pds.s3.us-east-1.amazonaws.com/gfs.20260925/12/atmos/gfs.t12z.pgrb2.0p25.f006"
# noaa-gfs-forecast-virtual temperature_2m, DRS 5.3
GFS_T2M = (GFS, 405594234, 515011)
# liquid_volumetric_soil_moisture_10_40cm, DRS 5.3 + bitmap
GFS_SOILL = (GFS, 400895742, 360722)
AIFS_T2M = (
    "https://storage.googleapis.com/ecmwf-open-data/20260925/12z/aifs-single/0p25/oper/20260925120000-36h-oper-fc.grib2",
    80825337,
    538304,
)  # ecmwf-aifs-single-forecast-virtual temperature_2m, DRS 5.42

# Immutable copies of public NOAA messages; see upstream constant_fields.rs and
# complex_group_descriptors.rs for their original provenance and independent checks.
UPSTREAM = "https://raw.githubusercontent.com/mpiannucci/gribberish/5e039e1f87b9cf6586c4fc060bb52b563ed3ef36/test-data/"
UPSTREAM_FIXTURES = {
    "refs-zero-group-nonzero.grib2": (
        "20260915-12-prob-f01-22.grib2", 229,
        "b9d40a689f5ab0a99c2db48109da198d9ead1f50d8bf1c735955f369b8d25b1f",
    ),
    "refs-zero-group-zero.grib2": (
        "20260915-12-sprd-f01-63.grib2", 218,
        "ba807b00bda3cf0abe60223ddfc4476a3b764dcefa07bdbefb86adcc8384cfc4",
    ),
    "rrfs-implicit-descriptors-bitmap.grib2": (
        "rrfs.t12z.f084-PEVAP-complex-descriptors-tiny.grib2", 242,
        "b14f56617a85e7f6124d42922dd75062769c2376cc6ab0ce59fd214c06a5f383",
    ),
}
# Verified byte-for-byte against these NOAA REFS messages. The immutable upstream
# copies above keep regeneration possible after NOAA's rolling retention expires.
REFS = "https://noaa-rrfs-ops-pds.s3.amazonaws.com/refs.20260915/12/ensprod/"
ORIGINAL_SOURCES = {
    # Index row 22: CIN, 90–0 mb above ground, probability <0, f01.
    "refs-zero-group-nonzero.grib2": (REFS + "refs.t12z.prob.f01.conus.grib2", 4204057, 229),
    # Index row 63: CRAIN, surface, ensemble spread, f01.
    "refs-zero-group-zero.grib2": (REFS + "refs.t12z.sprd.f01.conus.grib2", 61047683, 218),
}

STORE_CONFIG = {"adjust_longitude_range": True, "north_up": True}
RAW_CONFIG = {"adjust_longitude_range": False, "north_up": False}
MISSING = 9999.0


def fetch(ref: tuple[str, int, int]) -> bytes:
    url, offset, length = ref
    req = urllib.request.Request(
        url, headers={"Range": f"bytes={offset}-{offset + length - 1}"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if len(data) != length:
        raise RuntimeError(f"{url}: expected {length} bytes, got {len(data)}")
    if data[:4] != b"GRIB" or int.from_bytes(data[8:16], "big") != length or data[-4:] != b"7777":
        raise RuntimeError(f"{url}: range is not one complete GRIB2 message")
    return data


def derive(source: bytes, packing: str, *, south_first: bool = False) -> bytes:
    """Subsample a global 0.25° regular_ll message to 4° and re-encode it with `packing`."""
    h = eccodes.codes_new_from_message(source)
    try:
        nj, ni = eccodes.codes_get(h, "Nj"), eccodes.codes_get(h, "Ni")
        if (nj, ni) != (721, 1440) or eccodes.codes_get(h, "jScansPositively") != 0:
            raise RuntimeError("expected a north-first global 0.25° grid")
        lat0 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees")
        lon0 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
        values = eccodes.codes_get_values(h).reshape(nj, ni)
        if eccodes.codes_get(h, "bitmapPresent"):
            values = np.where(
                values == eccodes.codes_get(h, "missingValue"), np.nan, values
            )
        sub = values[::STEP, ::STEP]
        rows, cols = sub.shape
        lat_last = lat0 - (rows - 1) * 0.25 * STEP
        lon_last = lon0 + (cols - 1) * 0.25 * STEP
        c = eccodes.codes_clone(h)
    finally:
        eccodes.codes_release(h)
    try:
        eccodes.codes_set(c, "Ni", cols)
        eccodes.codes_set(c, "Nj", rows)
        eccodes.codes_set(c, "iDirectionIncrementInDegrees", 0.25 * STEP)
        eccodes.codes_set(c, "jDirectionIncrementInDegrees", 0.25 * STEP)
        eccodes.codes_set(c, "longitudeOfFirstGridPointInDegrees", lon0)
        eccodes.codes_set(c, "longitudeOfLastGridPointInDegrees", lon_last)
        if south_first:
            sub = sub[::-1]
            eccodes.codes_set(c, "jScansPositively", 1)
            eccodes.codes_set(c, "latitudeOfFirstGridPointInDegrees", lat_last)
            eccodes.codes_set(c, "latitudeOfLastGridPointInDegrees", lat0)
        else:
            eccodes.codes_set(c, "latitudeOfFirstGridPointInDegrees", lat0)
            eccodes.codes_set(c, "latitudeOfLastGridPointInDegrees", lat_last)
        eccodes.codes_set(c, "packingType", packing)
        has_missing = bool(np.isnan(sub).any())
        eccodes.codes_set(c, "bitmapPresent", 1 if has_missing else 0)
        if has_missing:
            eccodes.codes_set(c, "missingValue", MISSING)
        eccodes.codes_set_values(c, np.where(np.isnan(sub), MISSING, sub).ravel())
        return eccodes.codes_get_message(c)
    finally:
        eccodes.codes_release(c)


def reference_decode(message: bytes, shape: list[int], config: dict) -> np.ndarray:
    """Decode through gribberish's zarr codec, exactly as zarr-python reads a virtual chunk."""
    store = zarr.storage.MemoryStore()
    arr = zarr.create_array(
        store,
        shape=shape,
        chunks=shape,
        dtype="float64",
        fill_value=np.nan,
        serializer=GribberishCodec(var="fixture", **config),
        compressors=None,
    )
    sync(store.set("c/0/0", cpu.Buffer.from_bytes(message)))
    return np.asarray(arr[...], dtype="<f8")


def describe(message: bytes) -> dict:
    h = eccodes.codes_new_from_message(message)
    try:
        return {
            "drs": eccodes.codes_get(h, "dataRepresentationTemplateNumber"),
            "grid": eccodes.codes_get(h, "gridDefinitionTemplateNumber"),
            "bitmap": bool(eccodes.codes_get(h, "bitmapPresent")),
            "shape": [eccodes.codes_get(h, "Nj"), eccodes.codes_get(h, "Ni")],
            "southFirst": bool(eccodes.codes_get(h, "jScansPositively")),
            "shortName": eccodes.codes_get(h, "shortName"),
        }
    finally:
        eccodes.codes_release(h)


def expected_case(message: bytes, shape: list[int], config: dict) -> dict:
    v = reference_decode(message, shape, config)
    finite = v[~np.isnan(v)]
    # A few fixed cells (corners, centre, and one each side of the longitude roll seam) as
    # readable spot checks; NaN written as null.
    probes = [
        (0, 0),
        (0, shape[1] - 1),
        (shape[0] // 2, 0),
        (shape[0] // 2, shape[1] // 2 - 1),
        (shape[0] // 2, shape[1] // 2),
        (shape[0] - 1, shape[1] - 1),
        (10, 17),
        (33, 71),
    ]
    probes = [(r, c) for r, c in probes if r < shape[0] and c < shape[1]]
    return {
        "config": config,
        "sha256": hashlib.sha256(v.tobytes()).hexdigest(),
        "nanCount": int(np.isnan(v).sum()),
        "min": float(finite.min()) if finite.size else None,
        "max": float(finite.max()) if finite.size else None,
        "samples": [
            {"row": r, "col": c, "value": None if np.isnan(v[r, c]) else float(v[r, c])}
            for r, c in probes
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check committed fixtures against Python without fetching or writing")
    args = parser.parse_args()
    assert version("gribberish") == "1.8.4"
    if args.check:
        expected = json.loads((HERE / "expected.json").read_text())["fixtures"]
        for name, info in expected.items():
            message = (HERE / name).read_bytes()
            assert hashlib.sha256(message).hexdigest() == info["fileSha256"], name
            for case in info["cases"]:
                actual = expected_case(message, info["shape"], case["config"])
                assert actual == case, f"{name}: {case['config']}\nexpected: {case}\nactual: {actual}"
            print(name, "unchanged under gribberish", version("gribberish"))
        return
    gfs_t2m, gfs_soill, aifs_t2m = fetch(GFS_T2M), fetch(GFS_SOILL), fetch(AIFS_T2M)
    fixtures = {
        "simple.grib2": (derive(gfs_t2m, "grid_simple"), GFS_T2M, [STORE_CONFIG]),
        "simple-bitmap.grib2": (
            derive(gfs_soill, "grid_simple"),
            GFS_SOILL,
            [STORE_CONFIG],
        ),
        "complex-spatial.grib2": (
            derive(gfs_t2m, "grid_complex_spatial_differencing"),
            GFS_T2M,
            [STORE_CONFIG, RAW_CONFIG],
        ),
        "complex-spatial-bitmap.grib2": (
            derive(gfs_soill, "grid_complex_spatial_differencing"),
            GFS_SOILL,
            [STORE_CONFIG],
        ),
        "ccsds-south-first.grib2": (
            derive(aifs_t2m, "grid_ccsds", south_first=True),
            AIFS_T2M,
            [STORE_CONFIG, RAW_CONFIG],
        ),
    }
    for name, (path, length, checksum) in UPSTREAM_FIXTURES.items():
        source = (UPSTREAM + path, 0, length)
        message = fetch(source)
        assert hashlib.sha256(message).hexdigest() == checksum, name
        fixtures[name] = (message, source, [STORE_CONFIG, RAW_CONFIG])
    expected = {}
    for name, (message, source, configs) in fixtures.items():
        (HERE / name).write_bytes(message)
        info = describe(message)
        expected[name] = {
            "fileSha256": hashlib.sha256(message).hexdigest(),
            "bytes": len(message),
            "source": {"url": source[0], "offset": source[1], "length": source[2]},
            **info,
            "cases": [expected_case(message, info["shape"], cfg) for cfg in configs],
        }
        if name in ORIGINAL_SOURCES:
            url, offset, length = ORIGINAL_SOURCES[name]
            expected[name]["originalSource"] = {"url": url, "offset": offset, "length": length}
        print(name, len(message), "B", info)
    versions = {
        "eccodes": eccodes.__version__,
        "eccodes_api": eccodes.codes_get_api_version(),
        "gribberish": version("gribberish"),
        "zarr": zarr.__version__,
    }
    (HERE / "expected.json").write_text(
        json.dumps({"generatedWith": versions, "fixtures": expected}, indent=1) + "\n"
    )


if __name__ == "__main__":
    main()
