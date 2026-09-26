# gribwasm

The explorer's GRIB2 decoder. The virtual Icechunk stores (`*-virtual`) keep each chunk as one GRIB2 message inside NOAA's or ECMWF's own files, behind the zarr codec `gribberish`. This crate compiles [gribberish](https://github.com/mpiannucci/gribberish) (Rust, MIT) to `wasm32-unknown-unknown` with wasm-bindgen. It is a single thread with no SharedArrayBuffer, so the site needs no COOP/COEP headers.

The built output is committed in `explorer/src/grib/`. The explorer's normal `npm` build does not run Rust, so you only need this README to change the decoder:

| File | What |
|---|---|
| `explorer/src/grib/gribwasm_bg.wasm`, `gribwasm.js` | wasm-bindgen output (`--target web`); checksums in `SHA256SUMS`, verified by `npm test` |
| `explorer/src/grib/codec.js` | the zarrita codec that calls it |

## Rebuild

Pinned: Rust **1.97.0** (`rust-toolchain.toml`, with the `wasm32-unknown-unknown` target), **wasm-bindgen-cli 0.2.129** (it must equal the `wasm-bindgen` crate pin), and gribberish **1.8.0 at commit `746e986ed5ac46c58d5137e458dc8ba715abd5d7`** with `default-features = false, features = ["png"]`. `Cargo.lock` pins everything else.

```sh
cargo install wasm-bindgen-cli --version 0.2.129 --locked
explorer/gribwasm/build.sh
```

`build.sh` runs:

```sh
cargo build --locked --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir explorer/src/grib <target>/wasm32-unknown-unknown/release/gribwasm.wasm
```

It then rewrites `SHA256SUMS`. It keeps `target/` outside the repo (in `$CARGO_TARGET_DIR`, default `$TMPDIR/dynamical-gribwasm-target`). It also remaps the Cargo home and crate paths out of the binary, so a rebuild with the same toolchain gives byte-identical files. That was checked by rebuilding into a fresh target directory. Set `WASM_BINDGEN=/path/to/wasm-bindgen` if the binary isn't on `PATH`.

After a rebuild, run `npm test`. `test/explorer-grib.test.mjs` checks the checksums and decodes the fixtures in `test/fixtures/grib/` against values from gribberish's Python codec. If you move the gribberish pin, regenerate those fixtures and expectations with `uv run test/fixtures/grib/make_fixtures.py`.

## Template coverage

| GRIB2 data representation template | Built in | Used by |
|---|---|---|
| 5.0 simple packing | yes | NOAA stores: constant fields and some HRRR bitmap fields |
| 5.2 / 5.3 complex packing (+ spatial differencing) | yes | nearly every NOAA field (GFS, GEFS, HRRR) |
| 5.41 PNG | yes (`png` crate, pure Rust) | none today |
| 5.42 CCSDS / AEC | yes (gribberish's pure-Rust decoder, used because `libaec` is off) | ECMWF AIFS |
| 5.40 JPEG 2000 | **no**: needs OpenJPEG (C) | none today |

The template census covered the first and last time of all 1,682 GRIB arrays in the 10 virtual stores on 2026-09-25.

## Licenses

- gribberish is MIT; its notice is in [`LICENSE-gribberish`](LICENSE-gribberish). The MIT terms ask for that notice to travel with copies, and the wasm is served from `/explorer/`, so keep a copy of the notice with the published bundle.
- The other crates compiled into the wasm (listed by `cargo metadata` for `wasm32-unknown-unknown`) are all permissive. Most are MIT or MIT/Apache-2.0. `mappers` is Apache-2.0 only. Zlib covers `zlib-rs` and `miniz_oxide` (dual-licensed). `memchr` is Unlicense/MIT, and `unicode-ident` adds Unicode-3.0 (it's a build-time proc-macro dependency).
