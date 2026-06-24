// In-memory registry of currently-streaming turns. This is the ONLY mutable
// cross-request state the worker holds; all durable state stays in the engine's
// SQLite + disk. A turn lives here only while its SSE stream is open, so the
// `/permission` and `/abort` routes can find the right turn to act on.
import type { ServerEvent } from "../shared/protocol";

export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  input: Record<string, unknown>;
}

export interface TurnSession {
  ac: AbortController;
  /** Parked canUseTool promises, keyed by requestId, awaiting a /permission POST. */
  pending: Map<string, PendingPermission>;
  /** Serializes permission prompts so two tool calls never race the one UI. */
  permChain: Promise<unknown>;
  /** Push an event onto this turn's SSE stream (set by the turn handler). */
  emit: (e: ServerEvent) => void;
}

const sessions = new Map<string, TurnSession>();

// "Always allow this tool" persists for the life of the worker process (one
// local user), mirroring the CLI's session-scoped alwaysAllow ref.
export const alwaysAllow = new Set<string>();

export function createSession(turnId: string): TurnSession {
  const s: TurnSession = {
    ac: new AbortController(),
    pending: new Map(),
    permChain: Promise.resolve(),
    emit: () => {},
  };
  sessions.set(turnId, s);
  return s;
}

export function getSession(turnId: string): TurnSession | undefined {
  return sessions.get(turnId);
}

/** Resolve a parked permission from a /permission POST. Returns false if unknown. */
export function resolvePermission(
  turnId: string,
  requestId: string,
  decision: "yes" | "always" | "no",
): boolean {
  const s = sessions.get(turnId);
  const p = s?.pending.get(requestId);
  if (!s || !p) return false;
  s.pending.delete(requestId);
  if (decision === "always") alwaysAllow.add(p.toolName);
  p.resolve(
    decision === "no"
      ? { behavior: "deny", message: "Denied by user." }
      : { behavior: "allow", updatedInput: p.input },
  );
  return true;
}

export function endSession(turnId: string): void {
  const s = sessions.get(turnId);
  if (!s) return;
  // Reject any still-parked permission as a deny so the SDK unblocks and the
  // generator can finish/throw rather than hang forever.
  for (const p of s.pending.values()) {
    p.resolve({ behavior: "deny", message: "Turn ended." });
  }
  s.pending.clear();
  sessions.delete(turnId);
}
