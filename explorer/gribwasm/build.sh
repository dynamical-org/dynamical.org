#!/usr/bin/env bash
# Rebuild the explorer's GRIB2 decoder: explorer/src/grib/gribwasm_bg.wasm + gribwasm.js.
#
# Needs rustup (rust-toolchain.toml pins Rust 1.97.0 + wasm32-unknown-unknown; rustup
# installs them on first use) and wasm-bindgen-cli 0.2.129, which must match the
# wasm-bindgen crate version in Cargo.toml exactly:
#   cargo install wasm-bindgen-cli --version 0.2.129 --locked
# Set WASM_BINDGEN to use a wasm-bindgen binary that isn't on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../src/grib"
wasm_bindgen="${WASM_BINDGEN:-wasm-bindgen}"
# Keep build products out of the repo.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/dynamical-gribwasm-target}"
# Strip machine-specific paths from panic/location strings so rebuilds are byte-identical.
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$here=/gribwasm"

want="wasm-bindgen 0.2.129"
have="$("$wasm_bindgen" --version)"
if [ "$have" != "$want" ]; then
  echo "need $want, found: $have" >&2
  exit 1
fi

cd "$here"
cargo build --locked --release --target wasm32-unknown-unknown
"$wasm_bindgen" --target web --no-typescript --out-dir "$out" \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/gribwasm.wasm"
cd "$out"
sha256sum gribwasm_bg.wasm gribwasm.js > SHA256SUMS
cat SHA256SUMS
