# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "xarray",
#     "zarr>=3",
#     "fsspec",
#     "aiohttp",
#     "global-land-mask",
#     "numpy",
# ]
# ///
"""Fetch GFS analysis data for the globe visualization.

Outputs multi-timestep wind (10m + 100m), temperature, and cloud cover
at ~5° resolution over the last 24 hours.

Run via: uv run scripts/fetch_wind.py
"""

import json
import sys
from pathlib import Path

import numpy as np
import xarray as xr
from global_land_mask import globe

OUTPUT_PATH = Path(__file__).parent.parent / "public" / "globe-data.json"
COARSEN_FACTOR = 20  # 0.25° × 20 = 5°
TIME_STEPS = 8  # 24 hours at 3-hour intervals


def round_grid(arr, decimals=1):
    """Round a 2D array for compact JSON output."""
    return [[round(float(v), decimals) for v in row] for row in arr]


def fetch():
    ds = xr.open_zarr(
        "https://data.dynamical.org/noaa/gfs/analysis/latest.zarr",
        chunks=None,
    )

    # Last 24 hours at 3-hour intervals — load as a single slice
    time_indices = list(range(-TIME_STEPS * 3, 0, 3))

    # Load all variables for all timesteps at once (single network fetch per var)
    subset = ds.isel(time=time_indices)
    vars_needed = [
        "wind_u_10m", "wind_v_10m",
        "wind_u_100m", "wind_v_100m",
        "temperature_2m", "total_cloud_cover_atmosphere",
    ]
    loaded = {v: subset[v].load() for v in vars_needed}
    times = subset.time.values

    # Coarsen grid
    def coarsen_all(da):
        return da.coarsen(
            latitude=COARSEN_FACTOR, longitude=COARSEN_FACTOR, boundary="trim"
        ).mean()

    coarsened = {v: coarsen_all(loaded[v]) for v in vars_needed}

    lats = coarsened["wind_u_10m"].latitude.values
    lons = coarsened["wind_u_10m"].longitude.values

    # Land mask
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    land_mask = globe.is_land(lat_grid, lon_grid)

    # Build frames
    frames = []
    for fi in range(len(time_indices)):
        frames.append({
            "time": str(times[fi]),
            "wind_10m": {
                "u": round_grid(coarsened["wind_u_10m"].isel(time=fi).values),
                "v": round_grid(coarsened["wind_v_10m"].isel(time=fi).values),
            },
            "wind_100m": {
                "u": round_grid(coarsened["wind_u_100m"].isel(time=fi).values),
                "v": round_grid(coarsened["wind_v_100m"].isel(time=fi).values),
            },
            "temperature": round_grid(coarsened["temperature_2m"].isel(time=fi).values),
            "cloud_cover": round_grid(
                coarsened["total_cloud_cover_atmosphere"].isel(time=fi).values, 0
            ),
        })

    return {
        "lats": [round(float(v), 2) for v in lats],
        "lons": [round(float(v), 2) for v in lons],
        "land": land_mask.astype(int).tolist(),
        "frames": frames,
    }


def main():
    data = fetch()
    output = json.dumps(data)

    if "--stdout" in sys.argv:
        sys.stdout.write(output)
    else:
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_PATH.write_text(output)
        size_kb = len(output) / 1024
        t0 = data["frames"][0]["time"]
        t1 = data["frames"][-1]["time"]
        print(f"Wrote {OUTPUT_PATH} ({size_kb:.0f}KB)")
        print(f"  {len(data['frames'])} frames: {t0} → {t1}")


if __name__ == "__main__":
    main()
