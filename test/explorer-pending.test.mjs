// Offline tests of explorer/src/lib/pending.js: a control change applies to the selection
// being loaded, never undoes a variable switch in flight, and keeps the rest of the
// selection (review pass 2, finding 1; the init and member controls).
import assert from "node:assert/strict";
import test from "node:test";
import { changeSelection, stepAccepted } from "../explorer/src/lib/pending.js";

const sel = (path, pinnedIdx, extra = {}) => ({ path, initIndex: 7, pinnedIdx, stepIndex: 4, ...extra });

test("loaded switch: the old variable's level select can't undo a switch in flight", () => {
  const loaded = sel("/temperature_isobaric", [0]);
  const switching = { path: "/relative_humidity_2m", initIndex: null, pinnedIdx: null, stepIndex: null };
  assert.equal(changeSelection(switching, loaded, { type: "pinned", path: "/temperature_isobaric", i: 0, j: 1 }), null, "old control rejected");
  assert.equal(changeSelection(switching, loaded, { type: "init", path: "/temperature_isobaric", index: 3 }), null, "old init select rejected");
  assert.equal(stepAccepted(switching, loaded), false, "old slider rejected");
  // No switch in flight: level changes apply to what is loaded, keeping init and step.
  assert.deepEqual(changeSelection(null, loaded, { type: "pinned", path: "/temperature_isobaric", i: 0, j: 1 }), sel("/temperature_isobaric", [1]));
  assert.equal(stepAccepted(null, loaded), true);
  // A level change in flight for the same variable: a second one composes onto it.
  const levelInFlight = sel("/temperature_isobaric", [1, 0]);
  const two = sel("/temperature_isobaric", [0, 0]);
  assert.deepEqual(changeSelection(levelInFlight, two, { type: "pinned", path: "/temperature_isobaric", i: 1, j: 2 }).pinnedIdx, [1, 2]);
  assert.equal(stepAccepted(levelInFlight, two), true);
  // Nothing loaded yet (first load or after a failure): no control applies.
  assert.equal(changeSelection(null, null, { type: "pinned", path: "/a", i: 0, j: 1 }), null);
});

test("an init choice keeps the variable, its member and levels and the step, and is marked explicit", () => {
  const loaded = sel("/temperature_2m", [3]);
  assert.deepEqual(changeSelection(null, loaded, { type: "init", path: "/temperature_2m", index: 2 }), {
    path: "/temperature_2m",
    initIndex: 2,
    pinnedIdx: [3],
    stepIndex: 4,
    explicitInit: true,
  });
  // A member change while that init loads keeps the requested init, not the drawn one.
  const initInFlight = changeSelection(null, loaded, { type: "init", path: "/temperature_2m", index: 2 });
  const next = changeSelection(initInFlight, loaded, { type: "pinned", path: "/temperature_2m", i: 0, j: 5 });
  assert.equal(next.initIndex, 2);
  assert.equal(next.explicitInit, true);
  assert.deepEqual(next.pinnedIdx, [5]);
});

test("a slider move while an init change loads becomes that selection's step", () => {
  const loaded = sel("/temperature_2m", [0], { stepIndex: 0 });
  const initInFlight = changeSelection(null, loaded, { type: "init", path: "/temperature_2m", index: 2 });
  const next = changeSelection(initInFlight, loaded, { type: "step", path: "/temperature_2m", index: 4 });
  assert.deepEqual(next, { path: "/temperature_2m", initIndex: 2, pinnedIdx: [0], stepIndex: 4, explicitInit: true });
  // and a later member change keeps that step
  assert.equal(changeSelection(next, loaded, { type: "pinned", path: "/temperature_2m", i: 0, j: 3 }).stepIndex, 4);
  // a slider of another variable than the one being loaded changes nothing
  assert.equal(changeSelection(next, loaded, { type: "step", path: "/other", index: 1 }), null);
});
