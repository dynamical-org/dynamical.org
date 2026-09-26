// The selection a user builds while the map is unloaded: nothing is read until Load, and
// every change composes onto the one pending selection. Pure.

/** @typedef {{ path: string, pinnedIdx: number[] | null, stepIndex?: number | null }} Selection */
/**
 * @typedef {{ type: "variable", path: string }
 *   | { type: "pinned", path: string, i: number, j: number, count: number }
 *   | { type: "step", path: string, index: number }} Change
 *   `path` on a level or step change is the variable whose control sent it.
 */

/**
 * @param {Selection | null} committed what is loaded (null if nothing is)
 * @param {Selection | null} pending
 * @param {Change} change
 * @returns {Selection | null}
 */
export function composePending(committed, pending, change) {
  const base = pending ?? committed;
  if (change.type === "variable") {
    // Back to the loaded variable keeps its levels; any other variable opens at its defaults.
    if (committed && change.path === committed.path) return { path: committed.path, pinnedIdx: committed.pinnedIdx, stepIndex: null };
    return { path: change.path, pinnedIdx: null, stepIndex: null };
  }
  // A control that belongs to another variable than the pending one (e.g. the old
  // variable's level select, still on screen for a moment) must not change it.
  if (!base || change.path !== base.path) return pending;
  if (change.type === "pinned") {
    const idx = base.pinnedIdx ? base.pinnedIdx.slice() : new Array(change.count).fill(0);
    idx[change.i] = change.j;
    return { path: base.path, pinnedIdx: idx, stepIndex: base.stepIndex ?? null };
  }
  return { path: base.path, pinnedIdx: base.pinnedIdx, stepIndex: change.index };
}
