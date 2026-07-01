import assert from "node:assert/strict";
import { test } from "node:test";
// Pin HOME before importing: shortPath (used by toolPreview) reads it at load.
process.env.HOME = "/Users/x";
const { isSpilledResultPath, toolPreview } = await import("./index");

const SPILLED = "/Users/x/.hemiunu/agent/projects/-Users-x/session/tool-results/mcp-dive.txt";
const WORKSPACE = "/Users/x/.hemiunu/tmp/local/default/index.html";

test("isSpilledResultPath: true for an SDK tool-result overflow file", () => {
  assert.equal(isSpilledResultPath(SPILLED), true);
});

test("isSpilledResultPath: false for a normal prototype workspace path", () => {
  assert.equal(isSpilledResultPath(WORKSPACE), false);
});

test("toolPreview: hides a spilled tool-result path", () => {
  assert.equal(toolPreview({ path: SPILLED }), "");
});

test("toolPreview: still shows a normal workspace path (shortened)", () => {
  assert.equal(toolPreview({ path: WORKSPACE }), "~/.hemiunu/tmp/local/default/index.html");
});
