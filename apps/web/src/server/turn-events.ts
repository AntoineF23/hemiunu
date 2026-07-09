// TurnEvent → ServerEvent: the one place the engine's turn stream is mapped
// onto the web wire protocol. The mapper is a small state machine fed one
// TurnEvent at a time (turn.ts drives it from runtime.runTurn and forwards the
// produced ServerEvents as SSE frames); it also accumulates the turn-level
// state the route needs afterwards — conversation id (the resume token), the
// full assistant text (persisted to history), whether the prototype was
// touched, and the finish record (usage / cost / stop reason).
import type { StopReason, TurnEvent, TurnUsage } from "@hemiunu/engine";
import { emptyUsage } from "@hemiunu/engine";
import {
  ASK_USER_TOOL_ID,
  DELEGATE_TOOL_NAME,
  PARALLEL_TOOL_ID,
  REMEMBER_TOOL_ID,
  SAVE_SOURCE_MAP_TOOL_ID,
} from "@hemiunu/agent-core";
import { cleanResultPreview, clip, isSpilledResultPath, prettyTool, toolPreview } from "./format";
import type { ServerEvent } from "../shared/protocol";

/** Tools whose call means the prototype changed this turn (also when a
 *  subagent calls them — parallel component builds write via subagents). */
const PROTOTYPE_TOOL = /save_prototype|write_workspace_file|iterate_prototype/;

/** How the turn ended, straight off the engine's turn-finish event. */
export interface TurnFinish {
  usage: TurnUsage;
  costUsd: number;
  stopReason: StopReason;
}

export interface TurnMapper {
  /** Map one engine event to zero or more wire events (in order). */
  map(e: TurnEvent): ServerEvent[];
  /** The plan text already surfaced by the permission gate, so the engine's
   *  post-approval `plan-proposed` event isn't shown twice. */
  planNoted(plan: string): void;
  /** Engine conversation id — doubles as the client's `resume` token. */
  readonly conversationId: string | undefined;
  /** The main agent's full streamed text (subagent narration excluded). */
  readonly fullText: string;
  /** True once any prototype-writing tool ran (main agent or subagent). */
  readonly touchedPrototype: boolean;
  /** Set by turn-finish. */
  readonly finish: TurnFinish | undefined;
  /** The LAST step's usage — its input side is the real context size (the
   *  cumulative turn-finish usage re-counts the prefix on every step). */
  readonly lastStepUsage: TurnUsage;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function createTurnMapper(): TurnMapper {
  let conversationId: string | undefined;
  let fullText = "";
  let touchedPrototype = false;
  let finish: TurnFinish | undefined;
  let lastStepUsage = emptyUsage();
  let notedPlan: string | undefined;
  // Delegation tool-call ids → the subagent that ran them: their results are
  // surfaced as expandable `answer` events, not raw inline result blobs.
  const delegates = new Map<string, string>();
  // Task id → display label (for nested tool lines under a delegation).
  const taskLabels = new Map<string, string>();
  // Subagent narration arrives as text DELTAS with `parent` = task id. Buffer
  // per task and flush complete lines, so the thread shows readable step
  // narration ("Building the Header…") instead of a spray of fragments.
  const subText = new Map<string, string>();

  const subLine = (line: string): ServerEvent | null => {
    const t = line.trim();
    return t ? { type: "subagent", label: "", detail: clip(t, 240), sub: true } : null;
  };

  /** Append a delta to a task's narration buffer; emit any complete lines. */
  const bufferSubText = (parent: string, delta: string): ServerEvent[] => {
    const parts = ((subText.get(parent) ?? "") + delta).split("\n");
    const rest = parts.pop() ?? "";
    subText.set(parent, rest);
    return parts.map(subLine).filter((e): e is ServerEvent => e !== null);
  };

  /** Flush a finished task's remaining (newline-less) narration. */
  const flushSubText = (parent: string): ServerEvent[] => {
    const rest = subText.get(parent);
    subText.delete(parent);
    const e = rest ? subLine(rest) : null;
    return e ? [e] : [];
  };

  const toolStart = (e: Extract<TurnEvent, { type: "tool-start" }>): ServerEvent[] => {
    if (PROTOTYPE_TOOL.test(e.name)) touchedPrototype = true;
    // A subagent's tool call → one activity line under its delegation.
    if (e.parent) {
      return [
        {
          type: "subagent",
          label: taskLabels.get(e.parent) ?? "subagent",
          detail: prettyTool(e.name),
          sub: true,
        },
      ];
    }
    const input = (e.input ?? {}) as Record<string, unknown>;
    if (e.name === PARALLEL_TOOL_ID) {
      delegates.set(e.id, "parallel");
      const tasks = Array.isArray(input.tasks) ? (input.tasks as Record<string, unknown>[]) : [];
      const summary = tasks.map((t) => String(t.label ?? t.agent ?? "task")).join(", ");
      return [
        {
          type: "tool",
          name: "parallel",
          preview: `${tasks.length} task${tasks.length === 1 ? "" : "s"}${
            summary ? ` · ${clip(summary, 60)}` : ""
          }`,
          delegate: true,
        },
      ];
    }
    if (e.name === DELEGATE_TOOL_NAME) {
      const who = str(input.agent) || "subagent";
      delegates.set(e.id, who);
      const desc = clip(str(input.label) || str(input.prompt), 56);
      return [{ type: "tool", name: who, preview: desc, delegate: true }];
    }
    // Asking IS the action — the question card renders it directly, so don't
    // also show a redundant "ask_user" activity line.
    if (e.name === ASK_USER_TOOL_ID) return [];
    // todo_write surfaces through the dedicated `todo` event; the plan-exit
    // proposal through the permission gate (and `plan-proposed`).
    if (e.name === "todo_write" || e.name === "exit_plan_mode") return [];
    if (e.name === "enter_plan_mode") {
      return [{ type: "note", text: "◷ planning — researching before proposing an approach…" }];
    }
    // Transparent auto-approved locals: keep their little confirmations (they
    // came from the old permission gate, which no longer sees auto tools).
    if (e.name === REMEMBER_TOOL_ID) {
      return [{ type: "note", text: `✎ remembered: ${clip(str(input.note), 80)}` }];
    }
    if (e.name === SAVE_SOURCE_MAP_TOOL_ID) {
      const mcp = str(input.mcp);
      return [
        { type: "note", text: `✎ source map updated${mcp ? `: ${mcp}` : ""}` },
        { type: "tool", name: e.name, preview: toolPreview(e.input) },
      ];
    }
    // A read_workspace_file that targets a tool-result overflow file is
    // internal bookkeeping, not prototype work — relabel it so it doesn't read
    // as "Working on the prototype" in an internal dir.
    const name =
      /read_workspace_file/.test(e.name) && isSpilledResultPath(str(input.path))
        ? "read_saved_result"
        : e.name;
    return [{ type: "tool", name, preview: toolPreview(e.input) }];
  };

  const toolResult = (e: Extract<TurnEvent, { type: "tool-result" }>): ServerEvent[] => {
    // A delegation's result is the subagent's final answer — surface it in
    // full as its own expandable `answer` block keyed to the subagent.
    const agent = delegates.get(e.id);
    if (agent) {
      const answer = e.output.content.trim();
      return answer ? [{ type: "answer", agent, text: answer }] : [];
    }
    if (e.output.isError) return [];
    // Only emit a CLEAN structured summary; raw dumps and oversized output are
    // dropped so they never leak into the activity feed.
    const preview = cleanResultPreview(e.output.content);
    if (!preview) return [];
    return [{ type: "result", text: preview, ...(e.parent ? { sub: true } : {}) }];
  };

  const map = (e: TurnEvent): ServerEvent[] => {
    switch (e.type) {
      case "turn-start":
        conversationId = e.conversationId;
        // The engine conversation id IS the resume token the client echoes.
        return [{ type: "session", sessionId: e.conversationId }];
      case "text-delta":
        if (e.parent) return bufferSubText(e.parent, e.text);
        fullText += e.text;
        return [{ type: "text", delta: e.text }];
      case "reasoning-delta":
        return []; // thinking stays internal — the web thread shows actions
      case "tool-start":
        return toolStart(e);
      case "tool-result":
        return toolResult(e);
      case "permission-note":
        return []; // the /permission route already echoes the decision
      case "task-start":
        taskLabels.set(e.id, e.label);
        return [{ type: "subagent", label: e.label, detail: `${e.agent} · running`, sub: true }];
      case "task-done":
        return [
          ...flushSubText(e.id),
          { type: "subagent", label: e.label, detail: e.ok ? "done" : "failed", sub: true },
        ];
      case "todo": {
        const done = e.todos.filter((t) => t.status === "completed").length;
        const active = e.todos.find((t) => t.status === "in_progress");
        const label = active ? ` — ${clip(active.text, 60)}` : "";
        return [{ type: "note", text: `◷ plan · ${done}/${e.todos.length}${label}` }];
      }
      case "plan-proposed":
        // Normally already surfaced by the permission gate (pre-approval) —
        // only show it here when it wasn't (e.g. an auto-accepted plan).
        if (e.plan === notedPlan) return [];
        return [{ type: "note", text: `Proposed plan:\n${e.plan}` }];
      case "compaction":
        return [
          { type: "note", text: "⇣ context compacted — earlier history folded into a summary" },
        ];
      case "step-finish":
        lastStepUsage = e.usage;
        return [];
      case "error":
        return [{ type: "error", message: e.message }];
      case "turn-finish":
        finish = { usage: e.usage, costUsd: e.costUsd, stopReason: e.stopReason };
        return [];
    }
  };

  return {
    map,
    planNoted: (plan) => {
      notedPlan = plan;
    },
    get conversationId() {
      return conversationId;
    },
    get fullText() {
      return fullText;
    },
    get touchedPrototype() {
      return touchedPrototype;
    },
    get finish() {
      return finish;
    },
    get lastStepUsage() {
      return lastStepUsage;
    },
  };
}
