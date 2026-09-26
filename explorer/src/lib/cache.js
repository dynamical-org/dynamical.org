// Promise caches that forget failures. Pure.

/**
 * `map.get(key)`, else `make()` stored under `key`. A rejected promise is removed, so the
 * next call (e.g. after the user presses Retry) makes a fresh attempt instead of replaying
 * the old failure. A later success stored under the same key is left alone.
 * @template T
 * @param {Map<string, Promise<T>>} map
 * @param {string} key
 * @param {() => Promise<T>} make
 * @returns {Promise<T>}
 */
export function cachedPromise(map, key, make) {
  const hit = map.get(key);
  if (hit) return hit;
  const p = make();
  map.set(key, p);
  p.catch(() => {
    if (map.get(key) === p) map.delete(key);
  });
  return p;
}
