// The runtime event protocol. Every observable moment of a turn — streamed
// text, tool calls, subagent lifecycle, usage — is one of these events. UIs
// (CLI, web) render TurnEvent streams and never see provider SDK shapes.

/** Token accounting for a step or a whole turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Number of model round-trips (steps) consumed. */
  steps: number;
}

/** One entry of the agent's todo list. */
export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** What a tool execution returned (or the error it raised). */
export interface ToolOutput {
  content: string;
  isError?: boolean;
}

/** Why the turn stopped. */
export type StopReason = "end" | "max-steps" | "aborted" | "error";

export type TurnEvent =
  /** A turn began for a conversation on a given model. */
  | { type: "turn-start"; conversationId: string; model: string }
  /** A chunk of assistant text (parent = subagent task id, if nested). */
  | { type: "text-delta"; text: string; parent?: string }
  /** A chunk of model reasoning/thinking text. */
  | { type: "reasoning-delta"; text: string; parent?: string }
  /** The model requested a tool call (input already parsed). */
  | { type: "tool-start"; id: string; name: string; input: unknown; parent?: string }
  /** A tool call finished; output pairs with the tool-start of the same id. */
  | { type: "tool-result"; id: string; name: string; output: ToolOutput; parent?: string }
  /** How a tool call was allowed: auto (tool policy), policy rule, or the user. */
  | { type: "permission-note"; id: string; name: string; decision: "auto" | "policy" | "user" }
  /** A subagent task was spawned. */
  | { type: "task-start"; id: string; agent: string; label: string }
  /** A subagent task ended (ok = completed without error). */
  | { type: "task-done"; id: string; agent: string; label: string; ok: boolean }
  /** The agent's todo list was replaced with a new snapshot. */
  | { type: "todo"; todos: TodoItem[] }
  /** The agent proposed a plan (plan mode) awaiting user approval. */
  | { type: "plan-proposed"; plan: string }
  /** The transcript was compacted; summary replaces the folded history. */
  | { type: "compaction"; summary: string }
  /** One model round-trip finished; usage covers that step. */
  | { type: "step-finish"; usage: TurnUsage }
  /** A non-fatal or fatal runtime error surfaced to the UI. */
  | { type: "error"; message: string }
  /** The turn ended: final text, cumulative usage, cost, and why it stopped. */
  | {
      type: "turn-finish";
      text: string;
      usage: TurnUsage;
      costUsd: number;
      stopReason: StopReason;
    };

/** True for events that carry streamed delta text (text or reasoning). */
export function isDeltaEvent(
  e: TurnEvent,
): e is Extract<TurnEvent, { type: "text-delta" | "reasoning-delta" }> {
  return e.type === "text-delta" || e.type === "reasoning-delta";
}

/** True for the terminal event of a turn. */
export function isTurnFinish(e: TurnEvent): e is Extract<TurnEvent, { type: "turn-finish" }> {
  return e.type === "turn-finish";
}

/** True for tool lifecycle events (start/result). */
export function isToolEvent(
  e: TurnEvent,
): e is Extract<TurnEvent, { type: "tool-start" | "tool-result" }> {
  return e.type === "tool-start" || e.type === "tool-result";
}

/** A zeroed usage record — the identity for addUsage. */
export function emptyUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 0 };
}

/** Sum two usage records (used to fold step-finish into the turn total). */
export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    steps: a.steps + b.steps,
  };
}
