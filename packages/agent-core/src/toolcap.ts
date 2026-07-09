/**
 * Generic tool-output budget, the way Claude Code does it: oversized tool
 * results are truncated BEFORE they're sent to the model, with a notice telling
 * the model it was truncated and how to get more. The enforcement now lives in
 * the engine pipeline (`resultBudgetTokens` on PipelineConfig — see
 * pipeline-wiring.ts); this module owns the budget resolution.
 */

/** Default per-result budget in TOKENS before a tool result is capped. With a
 *  1M-token context window the old 6k cap was far too aggressive — it truncated
 *  legitimately useful results. This is now just a backstop against a pathological
 *  dump; MCP results (the important retrievals) are exempt entirely (see
 *  pipeline-wiring.ts `exemptFromTruncation`). */
export const DEFAULT_RESULT_BUDGET_TOKENS = 60000;

/** Budget from env (HEMIUNU_TOOL_RESULT_BUDGET, in tokens) or the default. */
export function resultBudgetTokens(): number {
  const n = Number(process.env.HEMIUNU_TOOL_RESULT_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESULT_BUDGET_TOKENS;
}
