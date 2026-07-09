// Owned control tools — the engine's replacements for the SDK's built-in
// TodoWrite / EnterPlanMode / ExitPlanMode. They are plain HemiTools with no
// side effects beyond the ToolContext (emit / setMode), so they live in the
// engine and every front-end gets them for free.

import { z } from "zod";
import type { TodoItem } from "./events";
import type { HemiTool } from "./tool";

const todoItemSchema = z.object({
  text: z.string().describe("The task, in a short imperative line."),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Where this task stands."),
});

/**
 * `todo_write` — replace the agent's todo list with a new snapshot. The UI
 * renders the `todo` event; the tool result just confirms. Auto-approved: it
 * only narrates progress, it never touches anything.
 */
export const todoWriteTool: HemiTool<{ todos: TodoItem[] }> = {
  name: "todo_write",
  description:
    "Replace your todo list with a new snapshot (the FULL list every time, not a diff). Use it to plan multi-step work and mark progress: set exactly one item to in_progress while you work on it, and mark items completed as soon as they're done.",
  inputSchema: z.object({
    todos: z.array(todoItemSchema).describe("The complete todo list, in order."),
  }),
  permission: "auto",
  readOnly: true,
  async execute({ todos }, ctx) {
    ctx.emit({ type: "todo", todos });
    const done = todos.filter((t) => t.status === "completed").length;
    return { content: `Todo list updated (${done}/${todos.length} done).` };
  },
};

/**
 * `enter_plan_mode` — switch the turn into plan mode: only read-only tools stay
 * available until the plan is approved via exit_plan_mode. Auto-approved (it
 * strictly REDUCES what the agent may do).
 */
export const enterPlanModeTool: HemiTool<Record<string, never>> = {
  name: "enter_plan_mode",
  description:
    "Enter plan mode for non-trivial work: research with read-only tools and design an approach BEFORE changing anything. While planning you cannot write or execute — propose the plan with exit_plan_mode when it's ready.",
  inputSchema: z.object({}),
  permission: "auto",
  readOnly: true,
  async execute(_input, ctx) {
    ctx.setMode("plan");
    return {
      content:
        "Plan mode on — research with read-only tools, then propose the plan with exit_plan_mode.",
    };
  },
};

/**
 * `exit_plan_mode` — propose the plan and ask to leave plan mode. This goes
 * through the NORMAL permission gate: the front-end's canUseTool renders
 * `input.plan` and asks the user. Approval lets execute() run, which is what
 * flips the mode back — a deny leaves the agent planning. Marked readOnly so
 * plan mode itself doesn't filter it out.
 */
export const exitPlanModeTool: HemiTool<{ plan: string }> = {
  name: "exit_plan_mode",
  description:
    "Propose your plan to the user and ask to leave plan mode. Pass the full plan in Markdown. If approved, plan mode ends and you carry the plan out; if denied, stay in plan mode and refine it with the user.",
  inputSchema: z.object({
    plan: z.string().describe("The complete plan, in Markdown, ready for user review."),
  }),
  permission: "ask",
  readOnly: true,
  async execute({ plan }, ctx) {
    // Reaching execute() means the gate approved — leave plan mode now.
    ctx.setMode("default");
    ctx.emit({ type: "plan-proposed", plan });
    return { content: "Plan approved — plan mode off. Carry out the plan now." };
  },
};

/** The engine's built-in control tools, ready to append to a tool set. */
export function controlTools(): HemiTool[] {
  return [todoWriteTool, enterPlanModeTool, exitPlanModeTool];
}
