// The selection being loaded (`requested`) versus what is drawn (`committed`): a control
// change applies to the one being loaded, and a control of another variable can't undo a
// switch. Pure.

/**
 * One selection: the variable, its init_time index (null: the probed latest usable run),
 * the index of each selected dim (null: their defaults), the slider step (null: open on a
 * step with data), and whether the init was chosen by the user.
 * @typedef {{ path: string, initIndex: number | null, pinnedIdx: number[] | null, stepIndex: number | null, explicitInit?: boolean }} Selection
 */
/**
 * @typedef {{ type: "pinned", path: string, i: number, j: number }
 *   | { type: "init", path: string, index: number }} Change
 *   `path` is the variable whose control sent the change.
 */

/**
 * A level, member or init change from a control of `path`, applied to the selection being
 * loaded (`requested`, if a switch or another change is in flight) or else to what is
 * loaded. Everything else in that selection (init, other dims, step) stays. Null when the
 * control belongs to neither, e.g. the old variable's level select during a switch to
 * another variable: it must not undo the switch.
 * @param {Selection | null} requested
 * @param {Selection | null} committed
 * @param {Change} change
 * @returns {Selection | null}
 */
export function changeSelection(requested, committed, change) {
  const target = requested ?? committed;
  if (!target || target.path !== change.path) return null;
  const next = {
    ...target,
    pinnedIdx: target.pinnedIdx ?? committed?.pinnedIdx ?? null,
    stepIndex: target.stepIndex ?? committed?.stepIndex ?? null,
  };
  if (change.type === "init") return { ...next, initIndex: change.index, explicitInit: true };
  const idx = (next.pinnedIdx ?? []).slice();
  idx[change.i] = change.j;
  return { ...next, pinnedIdx: idx };
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
