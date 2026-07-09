// A UI-agnostic reducer that coalesces the firehose of tool/subagent events into
// a small set of live, updating "activity groups", so neither front-end renders
// one line per tool call. Both the Ink CLI and the web client feed it the same
// normalized events and render the resulting group their own way (the CLI commits
// one summary line to its immutable <Static> scrollback; the web mutates React
// state and offers an expand/collapse disclosure). Pure — no UI, no I/O.

export interface ActivityChild {
  label: string;
  preview?: string;
}

/** A run of same-label top-level tool calls, or one collapsed delegation. */
export type ActivityGroup =
  | {
      kind: "tool-run";
      /** Friendly label the run coalesces on, e.g. "Reading your files". */
      label: string;
      count: number;
      /** Most-recent preview (page title / query), shown inline. */
      preview?: string;
      children: ActivityChild[];
    }
  | {
      kind: "delegation";
      /** Raw agent id ("researcher" | "prototyper" | "parallel" | …). */
      agent: string;
      /** Display label, e.g. "Researcher" or "Working in parallel". */
      label: string;
      /** Total nested steps (tool calls) across all subtasks. */
      total: number;
      /** Per-subtask tallies, keyed by subtask label (parallel fan-out). */
      subtasks: Map<string, { tools: number; lastTool?: string }>;
      /** Completed subtasks (for parallel). */
      done: number;
      children: ActivityChild[];
    };

/** Normalized events — each UI classifies delegate/sub/tool before feeding these. */
export type ActivityEvent =
  | { type: "tool"; label: string; preview?: string }
  | { type: "delegate"; agent: string; label?: string }
  | { type: "subtool"; taskLabel: string; toolLabel: string; preview?: string }
  | { type: "subdone"; taskLabel: string; ok: boolean };

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Stable coalescing key: tool runs split by label; all delegation events share one. */
export function groupKey(e: ActivityEvent): string {
  return e.type === "tool" ? `tool:${e.label}` : "delegation";
}

/** Does this event extend the currently-open group, or start a fresh one? */
function eventJoinsGroup(active: ActivityGroup, e: ActivityEvent): boolean {
  if (active.kind === "tool-run") return e.type === "tool" && e.label === active.label;
  return e.type !== "tool"; // delegation absorbs delegate/subtool/subdone
}

function openGroup(e: ActivityEvent): ActivityGroup {
  if (e.type === "tool")
    return {
      kind: "tool-run",
      label: e.label,
      count: 1,
      preview: e.preview,
      children: [{ label: e.label, preview: e.preview }],
    };
  const agent = e.type === "delegate" ? e.agent : "subagent";
  const base: ActivityGroup = {
    kind: "delegation",
    agent,
    label: (e.type === "delegate" && e.label) || cap(agent),
    total: 0,
    subtasks: new Map(),
    done: 0,
    children: [],
  };
  return e.type === "delegate" ? base : applyEvent(base, e);
}

function applyEvent(g: ActivityGroup, e: ActivityEvent): ActivityGroup {
  if (g.kind === "tool-run" && e.type === "tool")
    return {
      ...g,
      count: g.count + 1,
      preview: e.preview ?? g.preview,
      children: [...g.children, { label: e.label, preview: e.preview }],
    };
  if (g.kind !== "delegation") return g;
  const subtasks = new Map(g.subtasks);
  if (e.type === "delegate") {
    return { ...g, label: e.label || g.label };
  }
  if (e.type === "subtool") {
    const prev = subtasks.get(e.taskLabel) ?? { tools: 0 };
    subtasks.set(e.taskLabel, { tools: prev.tools + 1, lastTool: e.toolLabel });
    return {
      ...g,
      total: g.total + 1,
      subtasks,
      children: [...g.children, { label: e.toolLabel, preview: e.preview }],
    };
  }
  if (e.type === "subdone") {
    if (!subtasks.has(e.taskLabel)) subtasks.set(e.taskLabel, { tools: 0 });
    return { ...g, subtasks, done: g.done + 1 };
  }
  return g;
}

/**
 * Fold one event into the active group. Returns the new active `group`, plus a
 * `flushed` group to commit when the event starts a different group.
 */
export function reduceActivity(
  active: ActivityGroup | null,
  e: ActivityEvent,
): { group: ActivityGroup; flushed?: ActivityGroup } {
  if (active && eventJoinsGroup(active, e)) return { group: applyEvent(active, e) };
  return { group: openGroup(e), flushed: active ?? undefined };
}

/** One-line human summary of a group — what both UIs show when collapsed. */
export function summarizeGroup(g: ActivityGroup): string {
  if (g.kind === "tool-run") {
    const head = g.count > 1 ? `${g.label} · ${g.count}` : g.label;
    return g.preview ? `${head} — ${g.preview}` : head;
  }
  if (g.total === 0) return `${g.label} · running`;
  const noun = g.agent === "researcher" ? "source" : "step";
  const steps = `${g.total} ${noun}${g.total === 1 ? "" : "s"}`;
  return g.subtasks.size > 1
    ? `${g.label} · ${g.subtasks.size} tasks · ${steps}`
    : `${g.label} · ${steps}`;
}
