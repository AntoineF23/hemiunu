// Plan-mode decision flow. A turn started with permissionMode "plan" is
// read-only until the model proposes its plan via exit_plan_mode; that call
// goes through the NORMAL permission gate, where the front-end shows the
// three-way plan menu (the old runtime's PLAN_CHOICES, matching Claude Code).
// This module maps the user's choice to the gate answer:
//
//   plan-auto   → allow + turn on auto-accept — exit_plan_mode.execute() runs,
//                 flips the mode back to "default" (the old flow's
//                 `updatedPermissions: setMode "default"`), and every following
//                 gated tool passes without a prompt.
//   plan-manual → allow — same mode flip, but each following step still asks.
//   plan-refine → deny with a steer message — execute() never runs, so the
//                 turn STAYS in plan mode and the agent keeps refining.

import type { CanUseToolResult } from "./pipeline";

/** The three plan-menu choices (accept & auto-run / accept / keep planning). */
export type PlanDecision = "plan-auto" | "plan-manual" | "plan-refine";

export const PLAN_DECISIONS: readonly PlanDecision[] = ["plan-auto", "plan-manual", "plan-refine"];

/** True when `v` is one of the plan-menu choices (front-end gate plumbing). */
export function isPlanDecision(v: string): v is PlanDecision {
  return (PLAN_DECISIONS as readonly string[]).includes(v);
}

/** The deny message for "keep planning" — verbatim from the old runtime's CLI
 *  flow, so the model reacts the same way (discuss and revise, don't build). */
export const PLAN_REFINE_MESSAGE =
  "The user wants to keep refining the plan before any execution. Discuss and revise the plan with them; do not start building yet.";

export interface PlanDecisionEffects {
  /** Turn auto-accept on for the rest of the turn (the "plan-auto" choice —
   *  the caller flips its pipeline's autoAccept / its own auto flag). */
  setAutoAccept?: (on: boolean) => void;
}

/**
 * Map a plan-menu choice to the exit_plan_mode gate answer, applying side
 * effects exactly as the old flow did. The mode flip itself is NOT done here:
 * an allow lets exit_plan_mode.execute() run, which calls setMode("default");
 * a deny leaves execute() unreached, so the turn stays in plan mode.
 */
export function applyPlanDecision(
  decision: PlanDecision,
  effects: PlanDecisionEffects = {},
): CanUseToolResult {
  if (decision === "plan-refine") return { behavior: "deny", message: PLAN_REFINE_MESSAGE };
  if (decision === "plan-auto") effects.setAutoAccept?.(true);
  return { behavior: "allow" };
}
