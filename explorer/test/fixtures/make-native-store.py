"""Write the small, sharded UGRID store used by explorer-native.spec.mjs.

uv run --with icechunk==2.2.2 --with zarr==3.4.0 --with numpy explorer/test/fixtures/make-native-store.py
"""

import shutil
from pathlib import Path

import icechunk
import numpy as np
import zarr
from zarr.codecs import BloscCodec

OUT = Path(__file__).parent / "native-store"
DIMS = ["init_time", "lead_time", "cell"]


def coordinate(
    group: zarr.Group, name: str, data: np.ndarray, dims: list[str], attrs: dict
) -> None:
    group.create_array(
        name, data=data, chunks=data.shape, dimension_names=dims, attributes=attrs
    )


def main() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    config = icechunk.RepositoryConfig.default()
    config.inline_chunk_threshold_bytes = 0
    repo = icechunk.Repository.create(
        icechunk.local_filesystem_storage(str(OUT)), config=config
    )
    session = repo.writable_session("main")
    root = zarr.group(store=session.store, zarr_format=3)

    coordinate(
        root,
        "init_time",
        np.array([1_790_000_000, 1_790_021_600], dtype="int64"),
        ["init_time"],
        {"units": "seconds since 1970-01-01"},
    )
    coordinate(
        root,
        "lead_time",
        np.array([0, 3600, 7200], dtype="int32"),
        ["lead_time"],
        {"units": "seconds"},
    )

    # Two triangles per patch. The outer chunks straddle the central one in
    # longitude, so their chunk boxes include the opening view but their faces don't.
    patches = [
        (10.56, 50.89),
        (10.90, 50.89),
        (11.24, 50.89),
        (11.58, 50.89),
        (5.0, 50.89),
        (5.34, 50.89),
        (17.0, 50.89),
        (17.34, 50.89),
        (2.0, 50.89),
        (2.34, 50.89),
        (20.0, 50.89),
        (20.34, 50.89),
    ]
    nodes = []
    faces = []
    for x, y in patches:
        i = len(nodes)
        nodes.extend([(x, y), (x + 0.28, y), (x, y + 0.24), (x + 0.28, y + 0.24)])
        faces.extend([(i, i + 1, i + 2), (i + 3, i + 2, i + 1)])

    mesh = root.create_group("geometry")
    mesh.create_array(
        "triangles",
        data=np.array(0, dtype="int32"),
        attributes={
            "cf_role": "mesh_topology",
            "topology_dimension": 2,
            "node_coordinates": "east north",
            "face_node_connectivity": "corners",
            "face_dimension": "cell",
        },
    )
    lon, lat = np.array(nodes, dtype="float32").T.copy()
    coordinate(mesh, "east", lon, ["node"], {"standard_name": "longitude"})
    coordinate(mesh, "north", lat, ["node"], {"standard_name": "latitude"})
    coordinate(
        mesh,
        "corners",
        # Exercise the UGRID start_index attribute as well as relative references.
        np.array(faces, dtype="int32") + 1,
        ["cell", "corner"],
        {"start_index": 1, "cf_role": "face_node_connectivity"},
    )

    for name, delta in [("temperature_2m", 0), ("dew_point_2m", 15)]:
        field = np.empty((2, 3, len(faces)), dtype="float32")
        for run in range(2):
            for lead in range(3):
                field[run, lead] = (
                    delta
                    + 15 * lead
                    - 5 * (1 - run)
                    + np.tile([-30, 0], len(faces) // 2)
                )
        attrs = {
            "units": "degree_Celsius",
            "mesh": "/geometry/triangles",
            "location": "face",
        }
        fill_value = np.nan
        if name == "dew_point_2m":
            scale, offset = 0.25, 10
            missing, fill_value = -15, -9999
            field = ((field - offset) / scale).astype("int16")
            # The first visible patch has two missing faces. Another face
            # legitimately decodes to -15, the raw missing_value sentinel.
            field[..., 0] = missing
            field[..., 1] = fill_value
            attrs.update(scale_factor=scale, add_offset=offset, missing_value=missing)
        root.create_array(
            name,
            data=field,
            chunks=(1, 3, 8),
            shards=(1, 3, 24),
            compressors=[BloscCodec(cname="zstd", typesize=field.dtype.itemsize)],
            fill_value=fill_value,
            dimension_names=DIMS,
            attributes=attrs,
        )

    session.commit("Synthetic native triangles")
    shutil.rmtree(OUT / "overwritten", ignore_errors=True)


if __name__ == "__main__":
    main()
