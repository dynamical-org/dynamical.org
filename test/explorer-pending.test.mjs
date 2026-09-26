// Offline tests of explorer/src/lib/pending.js: changes made while unloaded compose onto one
// pending selection (review pass 2, finding 1).
import assert from "node:assert/strict";
import test from "node:test";
import { composePending } from "../explorer/src/lib/pending.js";

const loaded = { path: "/temperature_isobaric", pinnedIdx: [0, 0] };

test("variable, then its own level and step: all compose", () => {
  let p = composePending(loaded, null, { type: "variable", path: "/rh_isobaric" });
  assert.deepEqual(p, { path: "/rh_isobaric", pinnedIdx: null, stepIndex: null });
  p = composePending(loaded, p, { type: "pinned", path: "/rh_isobaric", i: 0, j: 1, count: 1 });
  p = composePending(loaded, p, { type: "step", path: "/rh_isobaric", index: 2 });
  assert.deepEqual(p, { path: "/rh_isobaric", pinnedIdx: [1], stepIndex: 2 });
});

test("the old variable's level select can't revert the pending variable", () => {
  let p = composePending(loaded, null, { type: "variable", path: "/relative_humidity_2m" });
  p = composePending(loaded, p, { type: "pinned", path: "/temperature_isobaric", i: 0, j: 1, count: 2 });
  assert.deepEqual(p, { path: "/relative_humidity_2m", pinnedIdx: null, stepIndex: null });
  p = composePending(loaded, p, { type: "step", path: "/temperature_isobaric", index: 5 });
  assert.equal(p.stepIndex, null);
});

test("several level changes compose; returning to the loaded variable keeps its levels", () => {
  let p = composePending(loaded, null, { type: "pinned", path: "/temperature_isobaric", i: 0, j: 1, count: 2 });
  p = composePending(loaded, p, { type: "pinned", path: "/temperature_isobaric", i: 1, j: 3, count: 2 });
  assert.deepEqual(p, { path: "/temperature_isobaric", pinnedIdx: [1, 3], stepIndex: null });
  p = composePending(loaded, p, { type: "variable", path: "/relative_humidity_2m" });
  p = composePending(loaded, p, { type: "variable", path: "/temperature_isobaric" });
  assert.deepEqual(p, { path: "/temperature_isobaric", pinnedIdx: [0, 0], stepIndex: null }, "back to what is loaded");
});

test("nothing loaded (e.g. after a failure): a variable choice is pending", () => {
  const p = composePending(null, null, { type: "variable", path: "/a" });
  assert.deepEqual(p, { path: "/a", pinnedIdx: null, stepIndex: null });
  assert.equal(composePending(null, null, { type: "pinned", path: "/a", i: 0, j: 1, count: 1 }), null);
});
