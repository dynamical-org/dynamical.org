import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { makeExplorerBuilder, installFingerprint, MARKER } = require("../lib/explorer-build.js");

// A throwaway explorer/ with npm files; `npm ci` is faked by creating the
// Vite binary, so the builder's install check sees a real installation.
function fakeExplorer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-build-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"explorer"}');
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}');
  return root;
}

function fakeExec(root, { failOn } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    const call = [cmd, ...args].join(" ");
    calls.push(call);
    if (call === failOn) throw new Error(`${call} failed`);
    if (call === "npm ci") {
      fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", ".bin", "vite"), "");
    }
  };
  return { exec, calls };
}

test("installs, then builds, once per process", () => {
  const root = fakeExplorer();
  const { exec, calls } = fakeExec(root);
  const build = makeExplorerBuilder(root, exec);
  build();
  build();
  assert.deepEqual(calls, ["npm ci", "npm run build"]);
  assert.equal(fs.readFileSync(path.join(root, "node_modules", MARKER), "utf8"), installFingerprint(root));
});

test("a new process with an unchanged install only builds", () => {
  const root = fakeExplorer();
  makeExplorerBuilder(root, fakeExec(root).exec)();
  const { exec, calls } = fakeExec(root);
  makeExplorerBuilder(root, exec)();
  assert.deepEqual(calls, ["npm run build"]);
});

test("a changed lockfile or package.json reinstalls", () => {
  for (const file of ["package-lock.json", "package.json"]) {
    const root = fakeExplorer();
    makeExplorerBuilder(root, fakeExec(root).exec)();
    fs.appendFileSync(path.join(root, file), " ");
    const { exec, calls } = fakeExec(root);
    makeExplorerBuilder(root, exec)();
    assert.deepEqual(calls, ["npm ci", "npm run build"], file);
  }
});

test("a missing Vite binary reinstalls even when the marker matches", () => {
  const root = fakeExplorer();
  makeExplorerBuilder(root, fakeExec(root).exec)();
  fs.rmSync(path.join(root, "node_modules", ".bin", "vite"));
  const { exec, calls } = fakeExec(root);
  makeExplorerBuilder(root, exec)();
  assert.deepEqual(calls, ["npm ci", "npm run build"]);
});

test("a failed install throws and writes no marker", () => {
  const root = fakeExplorer();
  const { exec } = fakeExec(root, { failOn: "npm ci" });
  assert.throws(makeExplorerBuilder(root, exec), /npm ci failed/);
  assert.equal(fs.existsSync(path.join(root, "node_modules", MARKER)), false);
});

test("a failed build throws, and the next call in the process tries again", () => {
  const root = fakeExplorer();
  let fail = true;
  const calls = [];
  const exec = (cmd, args) => {
    const call = [cmd, ...args].join(" ");
    calls.push(call);
    if (call === "npm ci") {
      fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", ".bin", "vite"), "");
    }
    if (call === "npm run build" && fail) throw new Error("build failed");
  };
  const build = makeExplorerBuilder(root, exec);
  assert.throws(build, /build failed/);
  fail = false;
  build();
  assert.deepEqual(calls, ["npm ci", "npm run build", "npm run build"]);
});
