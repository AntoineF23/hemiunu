// The wire protocol between the Hono worker (SSE down) and the browser (POST up).
// Kept in one place so both sides agree. SSE frames are JSON objects with a
// discriminating `type`; the client switches on it.

// The valid permission decisions, as a runtime array so both the type and a
// request-validation guard derive from one source (add a value in one place).
// ExitPlanMode plan-approval choices (Claude-Code style): accept and auto-run,
// accept but approve each step, or keep planning to refine.
export const PERMISSION_DECISIONS = [
  "yes",
  "always",
  "no",
  "plan-auto",
  "plan-manual",
  "plan-refine",
] as const;

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/** Runtime guard: is `v` a valid permission decision from an untrusted body? */
export function isPermissionDecision(v: unknown): v is PermissionDecision {
  return typeof v === "string" && (PERMISSION_DECISIONS as readonly string[]).includes(v);
}

/** Server → client, streamed as SSE `data:` frames during a turn. */
export type ServerEvent =
  | { type: "turn"; turnId: string }
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; preview: string; sub?: boolean; delegate?: boolean }
  | { type: "result"; text: string; sub?: boolean }
  // A subagent's full final answer — the handoff it returned to the coordinator.
  // Surfaced as an expandable block under the delegation so you can see exactly
  // what each specialist produced, not just the main agent's summary of it.
  | { type: "answer"; agent: string; text: string }
  | { type: "note"; text: string }
  | { type: "permission"; requestId: string; name: string; preview: string }
  // The agent's `ask_user` tool: one multiple-choice question awaiting an answer.
  | {
      type: "question";
      requestId: string;
      header: string;
      question: string;
      options: { label: string; description?: string }[];
    }
  | { type: "subagent"; label: string; detail: string; sub: true }
  // A live preview (wireframe / prototype) to embed inline in the thread.
  | { type: "artifact"; url: string; title: string }
  // A monument earned by publishing to main — rendered as a celebratory card
  // with a button that opens the Atlas focused on it.
  | { type: "atlas"; line: string; monumentId: string; name: string; tier: string }
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
  /** Resume a prior conversation on the engine transcript (the client echoes
   *  back the last `session` id — the engine conversation id). */
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

/** Body of POST /api/turn/:turnId/question — answer an ask_user question. */
export interface QuestionReply {
  requestId: string;
  /** The chosen option's label (or the user's free text for "Other"). */
  answer: string;
}
