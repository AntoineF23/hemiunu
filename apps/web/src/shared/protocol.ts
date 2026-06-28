// The wire protocol between the Hono worker (SSE down) and the browser (POST up).
// Kept in one place so both sides agree. SSE frames are JSON objects with a
// discriminating `type`; the client switches on it.

export type PermissionDecision =
  | "yes"
  | "always"
  | "no"
  // ExitPlanMode plan-approval choices (Claude-Code style): accept and auto-run,
  // accept but approve each step, or keep planning to refine.
  | "plan-auto"
  | "plan-manual"
  | "plan-refine";

/** Server → client, streamed as SSE `data:` frames during a turn. */
export type ServerEvent =
  | { type: "turn"; turnId: string }
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; preview: string; sub?: boolean; delegate?: boolean }
  | { type: "result"; text: string; sub?: boolean }
  | { type: "note"; text: string }
  | { type: "permission"; requestId: string; name: string; preview: string }
  | { type: "subagent"; label: string; detail: string; sub: true }
  // A live preview (wireframe / prototype) to embed inline in the thread.
  | { type: "artifact"; url: string; title: string }
  // The active team/workspace changed mid-turn (the agent created/switched one),
  // so the UI can update the workspace indicator without waiting for turn end.
  | { type: "team"; repo: string | null }
  | { type: "cost"; costUsd: number | null; outTokens: number; ctxTokens: number }
  | { type: "interrupted" }
  | { type: "error"; message: string }
  | { type: "done" };

/** Body of POST /api/turn — start a turn. */
export interface TurnRequest {
  prompt: string;
  /** Resume a prior SDK session (the client echoes back the last `session` id). */
  resume?: string;
  /** Plan-first mode: start the turn read-only — the agent proposes a plan and
   *  executes nothing until the user approves it. */
  planMode?: boolean;
  /** Auto-accept mode: approve every gated tool without prompting. */
  autoAccept?: boolean;
}

/** Body of POST /api/turn/:turnId/permission — answer a permission prompt. */
export interface PermissionReply {
  requestId: string;
  decision: PermissionDecision;
}
