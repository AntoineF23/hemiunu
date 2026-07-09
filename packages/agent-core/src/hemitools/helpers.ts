// Shared bits for the HemiTool ports of the in-process tool servers. Every
// port keeps its old `mcp__<server>__<tool>` id — the toolpolicy store, the
// front-ends' allowlists, and the evals all pattern-match those names.

import type { HemiTool, ToolOutput } from "@hemiunu/engine";

/** Wrap plain text as a ToolOutput (the old `{ content: [{type:"text"}] }`). */
export const ok = (text: string): ToolOutput => ({ content: text });

/**
 * Identity with inference: lets a tool literal infer its input type from the
 * zod schema while the result is the erased HemiTool the pipeline consumes.
 */
export function defineTool<I>(t: HemiTool<I>): HemiTool {
  return t as HemiTool;
}
