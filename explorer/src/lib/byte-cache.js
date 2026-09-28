// Successful store reads kept in memory up to a byte budget, least recently used
// first out. Every array is read through it (store.js), so a layer that needs a
// chunk it already fetched decodes it again from memory. That is what an ensemble
// member switch does: the stores keep every member in one chunk, and the new
// member's layer reads the same chunks as the old one. A session is pinned to one
// snapshot, so a key's bytes never change. Pure.

/**
 * @template {{ get: Function, getRange: Function }} S
 * @param {S} store
 * @param {{ maxBytes: number }} opts
 */
export function cachingStore(store, { maxBytes }) {
  /** @type {Map<string, Uint8Array>} */
  const entries = new Map();
  let bytes = 0;

  // A copy each time, so a decoder that works in place can't change the cached bytes.
  const recall = (id) => {
    const hit = entries.get(id);
    if (!hit) return undefined;
    entries.delete(id);
    entries.set(id, hit);
    return hit.slice();
  };
  const remember = (id, value) => {
    if (!value || value.byteLength > maxBytes) return value;
    entries.set(id, value.slice());
    bytes += value.byteLength;
    for (const [old, kept] of entries) {
      if (bytes <= maxBytes) break;
      entries.delete(old);
      bytes -= kept.byteLength;
    }
    return value;
  };
  const rangeId = (key, r) => `${key}|${r?.offset ?? ""}|${r?.length ?? ""}|${r?.suffixLength ?? ""}`;

  return {
    get: async (key, opts) => recall(key) ?? remember(key, await store.get(key, opts)),
    getRange: async (key, range, opts) => {
      const id = rangeId(key, range);
      return recall(id) ?? remember(id, await store.getRange(key, range, opts));
    },
  };
}
