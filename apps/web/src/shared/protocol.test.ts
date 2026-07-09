import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION_DECISIONS, isPermissionDecision } from "./protocol";

test("isPermissionDecision: accepts every declared decision", () => {
  for (const d of PERMISSION_DECISIONS) assert.equal(isPermissionDecision(d), true);
});

test("isPermissionDecision: rejects unknown strings and non-strings", () => {
  assert.equal(isPermissionDecision("maybe"), false);
  assert.equal(isPermissionDecision(""), false);
  assert.equal(isPermissionDecision(undefined), false);
  assert.equal(isPermissionDecision(null), false);
  assert.equal(isPermissionDecision(1), false);
  assert.equal(isPermissionDecision({ decision: "yes" }), false);
});
