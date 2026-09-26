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

/**
 * While loaded: a level change from a control of `path`, applied to the selection being
 * loaded (`requested`, if a switch or level change is in flight) or else to what is
 * loaded. Null when the control belongs to neither, e.g. the old variable's level select
 * during a switch to another variable: it must not undo the switch.
 * @param {Selection | null} requested
 * @param {Selection | null} committed
 * @param {{ path: string, i: number, j: number }} change
 * @returns {Selection | null}
 */
export function loadedPinned(requested, committed, { path, i, j }) {
  const target = requested ?? committed;
  if (!target || target.path !== path) return null;
  const idx = (target.pinnedIdx ?? committed?.pinnedIdx ?? []).slice();
  idx[i] = j;
  return { path, pinnedIdx: idx };
}

/**
 * Whether the slider may change the step: not while another variable is being loaded
 * (its slider isn't built yet; the old one belongs to the variable being replaced).
 * @param {Selection | null} requested
 * @param {Selection | null} committed
 */
export function stepAccepted(requested, committed) {
  return !requested || (committed !== null && requested.path === committed.path);
}
