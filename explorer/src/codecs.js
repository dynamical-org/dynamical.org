// The one place zarrita codecs are registered. zarrita's default registry
// already covers our materialized stores (sharding_indexed, bytes, blosc, zstd,
// crc32c, scale_offset). The virtual stores add a GRIB decoder ("gribberish",
// src/grib/). zarrita calls a codec's factory only when it builds the pipeline of
// an array that declares that codec, so the GRIB module and its wasm load on the
// first read of a virtual variable and never on a materialized page.
import { registry } from "zarrita";

let registered = false;

export function registerCodecs() {
  if (registered) return;
  registered = true;
  registry.set("gribberish", async () => {
    const { GribberishCodec, initGrib } = await import("./grib/codec.js");
    await initGrib();
    return GribberishCodec;
  });
}

/** Codec names the explorer can decode; used to disable variables up front. */
export function canDecode(name) {
  registerCodecs();
  return name === "sharding_indexed" || registry.has(name);
}
