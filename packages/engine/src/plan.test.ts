import assert from "node:assert/strict";
import { test } from "node:test";
import { exitPlanModeTool } from "./control-tools";
import type { TurnEvent } from "./events";
import { createPipeline } from "./pipeline";
import type { PermissionMode, ToolContext } from "./tool";
import {
  applyPlanDecision,
  isPlanDecision,
  PLAN_DECISIONS,
  PLAN_REFINE_MESSAGE,
  type PlanDecision,
} from "./plan";

// --- the decision mapping (the old CLI PLAN_CHOICES flow) ---------------------

test("plan-refine denies with the old flow's exact steer message", () => {
  let auto = false;
  const answer = applyPlanDecision("plan-refine", { setAutoAccept: () => (auto = true) });
  assert.deepEqual(answer, { behavior: "deny", message: PLAN_REFINE_MESSAGE });
  assert.equal(auto, false, "keep planning must not touch auto-accept");
});

test("plan-auto allows and turns auto-accept on", () => {
  const calls: boolean[] = [];
  const answer = applyPlanDecision("plan-auto", { setAutoAccept: (on) => calls.push(on) });
  assert.deepEqual(answer, { behavior: "allow" });
  assert.deepEqual(calls, [true]);
});

test("plan-manual allows without touching auto-accept", () => {
  let touched = false;
  const answer = applyPlanDecision("plan-manual", { setAutoAccept: () => (touched = true) });
  assert.deepEqual(answer, { behavior: "allow" });
  assert.equal(touched, false);
});

test("isPlanDecision recognises exactly the three menu choices", () => {
  for (const d of PLAN_DECISIONS) assert.equal(isPlanDecision(d), true);
  assert.equal(isPlanDecision("yes"), false);
  assert.equal(isPlanDecision("always"), false);
});

// --- end to end: the decision drives exit_plan_mode through the pipeline ------

async function runExitPlanMode(decision: PlanDecision, setAutoAccept: (on: boolean) => void) {
  let mode: PermissionMode = "plan";
  const events: TurnEvent[] = [];
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    conversationId: "test",
    emit: (e) => events.push(e),
    mode: () => mode,
    setMode: (m) => (mode = m),
  };
  const pipeline = createPipeline({
    tools: [exitPlanModeTool],
    canUseTool: async () => applyPlanDecision(decision, { setAutoAccept }),
  });
  const output = await pipeline.execute(
    { id: "plan-1", name: "exit_plan_mode", input: { plan: "1. do the thing" } },
    ctx,
  );
  return { output, events, mode: () => mode };
}

test("an approved plan flips the mode to default and proposes the plan", async () => {
  let auto = false;
  const { output, events, mode } = await runExitPlanMode("plan-auto", (on) => (auto = on));
  assert.equal(output.isError, undefined);
  assert.equal(mode(), "default", "approval must leave plan mode");
  assert.equal(auto, true, "plan-auto must switch auto-accept on");
  const proposed = events.find((e) => e.type === "plan-proposed");
  assert.equal(proposed && "plan" in proposed ? proposed.plan : undefined, "1. do the thing");
});

test("a refined plan keeps the turn in plan mode and returns the steer as an error", async () => {
  let auto = false;
  const { output, events, mode } = await runExitPlanMode("plan-refine", (on) => (auto = on));
  assert.equal(output.isError, true);
  assert.equal(output.content, PLAN_REFINE_MESSAGE);
  assert.equal(mode(), "plan", "a deny must never leave plan mode");
  assert.equal(auto, false);
  assert.ok(!events.some((e) => e.type === "plan-proposed"));
});

test("plan-manual leaves plan mode without enabling auto-accept", async () => {
  let auto = false;
  const { output, mode } = await runExitPlanMode("plan-manual", (on) => (auto = on));
  assert.equal(output.isError, undefined);
  assert.equal(mode(), "default");
  assert.equal(auto, false);
});
