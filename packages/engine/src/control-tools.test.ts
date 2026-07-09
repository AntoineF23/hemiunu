import assert from "node:assert/strict";
import { test } from "node:test";
import { enterPlanModeTool, exitPlanModeTool, todoWriteTool } from "./control-tools";
import type { PermissionMode, ToolContext } from "./tool";
import type { TurnEvent } from "./events";

function ctx(): ToolContext & { events: TurnEvent[]; modes: PermissionMode[] } {
  const events: TurnEvent[] = [];
  const modes: PermissionMode[] = [];
  return {
    events,
    modes,
    signal: new AbortController().signal,
    conversationId: "test",
    emit: (e) => events.push(e),
    mode: () => modes[modes.length - 1] ?? "default",
    setMode: (m) => modes.push(m),
  };
}

test("todo_write: emits the todo snapshot event and confirms", async () => {
  const c = ctx();
  const todos = [
    { text: "research", status: "completed" as const },
    { text: "build", status: "in_progress" as const },
  ];
  const out = await todoWriteTool.execute({ todos }, c);
  assert.deepEqual(c.events, [{ type: "todo", todos }]);
  assert.match(out.content, /1\/2/);
  assert.equal(todoWriteTool.permission, "auto");
  assert.equal(todoWriteTool.readOnly, true);
});

test("enter_plan_mode: switches the turn into plan mode, auto-approved", async () => {
  const c = ctx();
  await enterPlanModeTool.execute({}, c);
  assert.deepEqual(c.modes, ["plan"]);
  assert.equal(enterPlanModeTool.permission, "auto");
});

test("exit_plan_mode: gated, and approval (execution) flips the mode back", async () => {
  const c = ctx();
  const out = await exitPlanModeTool.execute({ plan: "# The plan" }, c);
  assert.deepEqual(c.modes, ["default"]);
  assert.deepEqual(c.events, [{ type: "plan-proposed", plan: "# The plan" }]);
  assert.match(out.content, /approved/i);
  // Must go through the NORMAL gate (the user approves the plan there) …
  assert.equal(exitPlanModeTool.permission, "ask");
  // … and must stay callable in plan mode (only read-only tools survive it).
  assert.equal(exitPlanModeTool.readOnly, true);
});
