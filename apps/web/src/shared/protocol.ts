// The wire protocol between the Hono worker (SSE down) and the browser (POST up).
// Kept in one place so both sides agree. SSE frames are JSON objects with a
// discriminating `type`; the client switches on it.

export type PermissionDecision = "yes" | "always" | "no";

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
  | { type: "cost"; costUsd: number | null; outTokens: number; ctxTokens: number }
  | { type: "interrupted" }
  | { type: "error"; message: string }
  | { type: "done" };

/** Body of POST /api/turn — start a turn. */
export interface TurnRequest {
  prompt: string;
  /** Resume a prior SDK session (the client echoes back the last `session` id). */
  resume?: string;
}

/** Body of POST /api/turn/:turnId/permission — answer a permission prompt. */
export interface PermissionReply {
  requestId: string;
  decision: PermissionDecision;
}
