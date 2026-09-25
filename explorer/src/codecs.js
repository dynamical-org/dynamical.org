// The one place zarrita codecs are registered. zarrita's default registry
// already covers our materialized stores (sharding_indexed, bytes, blosc, zstd,
// crc32c, scale_offset). The virtual stores add a GRIB decoder ("gribberish");
// register it here with `registry.set(name, () => CodecClass)` when it lands.
import { registry } from "zarrita";

let registered = false;

export function registerCodecs() {
  if (registered) return;
  registered = true;
}

/** Codec names the explorer can decode; used to disable variables up front. */
export function canDecode(name) {
  return name === "sharding_indexed" || registry.has(name);
}
