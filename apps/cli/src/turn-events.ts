// TurnEvent → UI mapping for the CLI (the P6-1a cutover). The engine runtime
// streams TurnEvents (packages/engine/src/events.ts); this renderer folds them
// into the CLI's scrollback items, live text region, activity groups, and
// status line. It is PURE — all UI effects go through the injected TurnSinks —
// so the whole mapping is unit-testable against a scripted event stream.
//
// StreamMessage → TurnEvent correspondence (what each old branch became):
//   system/init.session_id      → turn-start.conversationId  (onConversation)
//   assistant text block        → text-delta                 (true streaming)
//   (hidden by the SDK)         → reasoning-delta            (live thinking)
//   assistant tool_use          → tool-start                 (activity groups)
//   user tool_result            → tool-result                (answers / folds)
//   parent_tool_use_id / onSubagentEvent → the `parent` stamp + task-start/done
//   canUseTool TodoWrite note   → todo                       (◷ plan note)
//   canUseTool ExitPlanMode     → plan-proposed              (gate still asks)
//   silent CLI auto-compact     → compaction                 (engine-driven)
//   result.total_cost_usd/usage → turn-finish.costUsd/usage  (engine-priced)
//   (none)                      → step-finish, permission-note

import {
  DELEGATE_TOOL_NAME,
  explainError,
  PARALLEL_TOOL_ID,
  REMEMBER_TOOL_ID,
  SAVE_SOURCE_MAP_TOOL_ID,
} from "@hemiunu/agent-core";
import type { StopReason, TurnEvent, TurnUsage } from "@hemiunu/engine";
import {
  clip,
  prettyTool,
  toolPreview,
  cleanResultPreview,
  type ActivityEvent,
} from "@hemiunu/format";
import type { Item } from "./types";

/** The terminal event's payload, handed to the App when the turn ends. */
export interface TurnFinish {
  text: string;
  usage: TurnUsage;
  costUsd: number;
  stopReason: StopReason;
}

/** Every UI effect the renderer can cause — the App wires these to React
 *  state; tests wire them to recorders. */
export interface TurnSinks {
  /** Commit one item to scrollback. */
  push(item: Item): void;
  /** Stream one chunk of the assistant's answer into the live region. */
  appendText(text: string): void;
  /** Stream one chunk of model reasoning (shown live, never committed). */
  appendThinking(text: string): void;
  /** Commit the live answer to scrollback (a tool call interrupts prose). */
  flushText(): void;
  /** Fold one normalized activity event into the open group. */
  feedActivity(e: ActivityEvent): void;
  /** Commit the open activity group to scrollback. */
  flushGroup(): void;
  /** Fold a clean top-level tool-result summary into the open group. */
  foldResult(summary: string): void;
  /** Update the spinner's status word. */
  setStatus(label: string): void;
  /** The engine assigned/kept this conversation id (the session id). */
  onConversation(id: string): void;
  /** The agent's plan was approved (exit_plan_mode ran). */
  onPlan(plan: string): void;
  /** One model round-trip finished; usage covers that step. */
  onStep(usage: TurnUsage): void;
  /** The turn ended (usage, engine-computed cost, stop reason). */
  onFinish(finish: TurnFinish): void;
}

// Display labels + spinner words per subagent (ported from the old CLI).
const AGENT_LABELS: Record<string, string> = {
  researcher: "Researcher",
  prototyper: "Prototyper",
  designer: "Designer",
  parallel: "Working in parallel",
};
const AGENT_STATUS: Record<string, string> = {
  prototyper: "prototyping",
  designer: "designing",
  parallel: "parallel",
};

const statusFor = (agent: string): string => AGENT_STATUS[agent] ?? "researching";
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const field = (input: unknown, key: string): string =>
  typeof input === "object" && input !== null ? str((input as Record<string, unknown>)[key]) : "";

// The engine's plan-entry control tool (packages/engine/src/control-tools.ts).
const ENTER_PLAN_TOOL = "enter_plan_mode";

/**
 * Create the per-turn renderer. One instance per turn — it tracks the turn's
 * delegations (tool-call id → agent) so a delegate/parallel result prints as
 * the subagent's full answer, and buffers each subagent's streamed narration
 * (`parent`-stamped text-deltas) into readable step lines.
 */
export function createTurnRenderer(sinks: TurnSinks): { handle(e: TurnEvent): void } {
  /** Delegation tool-call ids → the agent that ran (for `answer` blocks). */
  const delegates = new Map<string, string>();
  /** Task id → display label / agent (for nested subtool activity lines). */
  const taskLabels = new Map<string, string>();
  const taskAgents = new Map<string, string>();
  /** Buffered narration per subagent task (text-deltas with `parent`). */
  const subText = new Map<string, string>();

  // A subagent's step narration ("Building the Header", …) buffers until its
  // next tool call or the task's end, then lands as one indented, readable
  // line under the delegation — the delta stream has no block boundaries.
  const flushSubText = (parent: string) => {
    const text = subText.get(parent)?.trim();
    subText.delete(parent);
    if (text) sinks.push({ kind: "text", text: clip(text, 200), sub: true });
  };

  const onToolStart = (e: Extract<TurnEvent, { type: "tool-start" }>) => {
    if (e.parent) {
      // A nested tool from a subagent — fold into the delegation group.
      flushSubText(e.parent);
      sinks.feedActivity({
        type: "subtool",
        taskLabel: taskLabels.get(e.parent) ?? "subagent",
        toolLabel: prettyTool(e.name),
        preview: toolPreview(e.input) || undefined,
      });
      sinks.setStatus(statusFor(taskAgents.get(e.parent) ?? "researcher"));
      return;
    }
    // Top-level: prose ends here — commit the streamed text above the tool line.
    sinks.flushText();
    if (e.name === DELEGATE_TOOL_NAME) {
      const agent = field(e.input, "agent") || "subagent";
      delegates.set(e.id, agent);
      sinks.feedActivity({ type: "delegate", agent, label: AGENT_LABELS[agent] ?? cap(agent) });
      sinks.setStatus(statusFor(agent));
      return;
    }
    if (e.name === PARALLEL_TOOL_ID) {
      delegates.set(e.id, "parallel");
      sinks.feedActivity({ type: "delegate", agent: "parallel", label: AGENT_LABELS.parallel });
      sinks.setStatus("parallel");
      return;
    }
    // Auto-approved tools that used to narrate from canUseTool now narrate
    // here (the engine pipeline never consults the gate for them).
    if (e.name === REMEMBER_TOOL_ID) {
      const note = field(e.input, "note");
      sinks.push({ kind: "note", text: `✎ remembered: ${clip(note, 80)}` });
    } else if (e.name === SAVE_SOURCE_MAP_TOOL_ID) {
      const mcp = field(e.input, "mcp");
      sinks.push({ kind: "note", text: `✎ source map updated${mcp ? `: ${mcp}` : ""}` });
    } else if (e.name === ENTER_PLAN_TOOL) {
      sinks.push({ kind: "note", text: "◷ planning — researching before proposing an approach…" });
    }
    sinks.feedActivity({
      type: "tool",
      label: prettyTool(e.name),
      preview: toolPreview(e.input) || undefined,
    });
    sinks.setStatus("running");
  };

  const onToolResult = (e: Extract<TurnEvent, { type: "tool-result" }>) => {
    if (e.parent) {
      // Sub results stay inside the delegation (only the final answer shows).
      flushSubText(e.parent);
      return;
    }
    sinks.setStatus("thinking");
    const agent = delegates.get(e.id);
    if (agent) {
      // A delegation's result is the subagent's final answer — print it in
      // full as an `answer` block; a failure surfaces as an error line.
      const text = e.output.content.trim();
      if (!text) return;
      sinks.flushGroup();
      if (e.output.isError) sinks.push({ kind: "error", text });
      else sinks.push({ kind: "answer", agent, text });
      return;
    }
    // Only a CLEAN structured summary is worth showing; raw dumps, oversized
    // output and errors are dropped so they never flood the activity stream.
    const summary = cleanResultPreview(e.output.content);
    if (summary) sinks.foldResult(summary);
  };

  const handle = (e: TurnEvent) => {
    switch (e.type) {
      case "turn-start":
        sinks.onConversation(e.conversationId);
        break;
      case "text-delta":
        if (e.parent) subText.set(e.parent, (subText.get(e.parent) ?? "") + e.text);
        else sinks.appendText(e.text);
        break;
      case "reasoning-delta":
        // Subagent reasoning stays internal; the main model's thinking streams
        // into the live region (dim) and is discarded when real output starts.
        if (!e.parent) sinks.appendThinking(e.text);
        break;
      case "tool-start":
        onToolStart(e);
        break;
      case "tool-result":
        onToolResult(e);
        break;
      case "permission-note":
        // The interactive gate already narrates user decisions; auto/policy
        // allows were silent in the old CLI too — keep them silent.
        break;
      case "task-start":
        taskLabels.set(e.id, e.label);
        taskAgents.set(e.id, e.agent);
        // The delegate/parallel tool-start already opened the delegation group
        // with its display label; a parallel subtask's start just marks
        // continued delegation activity (same as the old onSubagentEvent).
        if (!delegates.has(e.id)) {
          sinks.feedActivity({ type: "delegate", agent: e.agent, label: AGENT_LABELS.parallel });
          sinks.setStatus("parallel");
        }
        break;
      case "task-done":
        flushSubText(e.id);
        sinks.feedActivity({ type: "subdone", taskLabel: e.label, ok: e.ok });
        break;
      case "todo": {
        const done = e.todos.filter((t) => t.status === "completed").length;
        const active = e.todos.find((t) => t.status === "in_progress");
        sinks.push({
          kind: "note",
          text: `◷ plan · ${done}/${e.todos.length}${active ? ` — ${clip(active.text, 60)}` : ""}`,
        });
        break;
      }
      case "plan-proposed":
        sinks.onPlan(e.plan);
        break;
      case "compaction":
        sinks.push({
          kind: "note",
          text: "✦ context compacted — earlier conversation folded into a summary",
        });
        break;
      case "step-finish":
        sinks.onStep(e.usage);
        break;
      case "error":
        // Provider/API failures arrive as raw messages — translate the ones we
        // recognise into one actionable line (explainError falls back verbatim).
        sinks.push({ kind: "error", text: explainError(e.message) });
        break;
      case "turn-finish":
        sinks.onFinish({
          text: e.text,
          usage: e.usage,
          costUsd: e.costUsd,
          stopReason: e.stopReason,
        });
        break;
    }
  };

  return { handle };
}
