import assert from "node:assert/strict";
import { test } from "node:test";
import { validateParallelTasks } from "./orchestrator";

test("validateParallelTasks: a single designer may run unscoped (SETUP/WIRE)", () => {
  assert.equal(validateParallelTasks([{ agent: "designer" }]), null);
  assert.equal(validateParallelTasks([{ agent: "designer" }, { agent: "researcher" }]), null);
});

test("validateParallelTasks: concurrent designers must all declare a write scope", () => {
  const err = validateParallelTasks([
    { agent: "designer", label: "header", writes: ["src/components/Header.tsx"] },
    { agent: "designer", label: "sidebar" },
  ]);
  assert.ok(err, "unscoped concurrent designer should be refused");
  assert.match(err ?? "", /sidebar/);
  assert.match(err ?? "", /writes/);
});

test("validateParallelTasks: scoped, disjoint concurrent designers pass", () => {
  assert.equal(
    validateParallelTasks([
      { agent: "designer", label: "header", writes: ["src/components/Header.tsx"] },
      { agent: "designer", label: "sidebar", writes: ["src/components/Sidebar.tsx"] },
      { agent: "researcher", label: "copy" },
    ]),
    null,
  );
});

test("validateParallelTasks: overlapping designer scopes are refused", () => {
  const err = validateParallelTasks([
    { agent: "designer", label: "header", writes: ["src/components/Shared.tsx"] },
    { agent: "designer", label: "sidebar", writes: ["./src/components/Shared.tsx"] },
  ]);
  assert.ok(err, "two designers claiming the same file should be refused");
  assert.match(err ?? "", /disjoint/i);
});
