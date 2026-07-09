// The tool-execution seam between the loop (P1) and the permission pipeline
// (P2). The loop never runs a tool directly: it hands every model-requested
// call to a ToolExecutor and streams the result. P2's pipeline.ts implements
// this same structural interface (permission gating, input rewriting,
// workspace-guard confinement) so the loop doesn't change when it lands.

import type { ToolOutput } from "./events";
import { validateToolInput, type HemiTool, type ToolContext } from "./tool";

/** One tool call as the model requested it (input already parsed). */
export interface ToolCall {
  /** Provider-assigned call id — pairs tool-start / tool-result events. */
  id: string;
  name: string;
  /** Parsed input as produced by the model (the pipeline may rewrite it). */
  input: unknown;
}

/** The seam: P1's loop consumes it, P2's permission pipeline implements it. */
export interface ToolExecutor {
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolOutput>;
}

/** What the permission callback decided (P2 consumes this in the pipeline). */
export type PermissionDecision =
  { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message?: string };

/** Interactive permission callback (yes / always / no), carried in options. */
export type CanUseTool = (
  toolName: string,
  input: unknown,
  ctx: { signal: AbortSignal },
) => Promise<PermissionDecision>;

/**
 * P1's default executor: validate the input against the tool's schema and run
 * it. NO permission gating — that is P2's pipeline. Failures become error
 * outputs (never throws) so the model can read and recover from them.
 */
export class DirectExecutor implements ToolExecutor {
  private tools: Map<string, HemiTool>;

  constructor(tools: HemiTool[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolOutput> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { content: `Unknown tool: ${call.name}`, isError: true };
    }
    const parsed = validateToolInput(tool.inputSchema, call.input);
    if (!parsed.ok) {
      return { content: `Invalid input for ${call.name}: ${parsed.issues}`, isError: true };
    }
    try {
      // The tool sees its own call id (parent stamp for subagent events).
      return await tool.execute(parsed.data, { ...ctx, toolCallId: call.id });
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  }
}
