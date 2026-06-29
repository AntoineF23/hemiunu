// In-memory registry of currently-streaming turns. This is the ONLY mutable
// cross-request state the worker holds; all durable state stays in the engine's
// SQLite + disk. A turn lives here only while its SSE stream is open, so the
// `/permission` and `/abort` routes can find the right turn to act on.
import { setToolPolicy } from "@hemiunu/agent-core";
import type { PermissionUpdate } from "@hemiunu/agent-core";
import type { PermissionDecision, ServerEvent } from "../shared/protocol";

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
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
  /** Parked ask_user questions, keyed by requestId, awaiting a /question POST. */
  askPending: Map<string, (answer: string) => void>;
  /** Serializes permission prompts so two tool calls never race the one UI. */
  permChain: Promise<unknown>;
  /** Push an event onto this turn's SSE stream (set by the turn handler). */
  emit: (e: ServerEvent) => void;
  /** Auto-accept mode: approve every gated tool without prompting. Seeded from
   *  the turn request and flipped on when a plan is approved with "auto". */
  autoAccept: boolean;
}

const sessions = new Map<string, TurnSession>();

// "Always allow this tool" for one local user. Trust boundary: the OS user who
// launched the worker. It is scoped to the current conversation — starting a
// fresh (non-resumed) conversation clears it via resetAlwaysAllow(), so a grant
// can't silently outlive the chat it was made in or leak into the next one.
export const alwaysAllow = new Set<string>();

/** Forget all "always allow" grants — called when a brand-new conversation starts. */
export function resetAlwaysAllow(): void {
  alwaysAllow.clear();
}

export function createSession(turnId: string): TurnSession {
  const s: TurnSession = {
    ac: new AbortController(),
    pending: new Map(),
    askPending: new Map(),
    permChain: Promise.resolve(),
    emit: () => {},
    autoAccept: false,
  };
  sessions.set(turnId, s);
  return s;
}

export function getSession(turnId: string): TurnSession | undefined {
  return sessions.get(turnId);
}

/** The currently-streaming turn (single-user / local-first → at most one). Used
 *  by the boot-time control handler to reach the live stream for `ask_user`. */
export function activeSession(): TurnSession | undefined {
  let last: TurnSession | undefined;
  for (const s of sessions.values()) last = s;
  return last;
}

/** Resolve a parked ask_user question from a /question POST. False if unknown. */
export function resolveQuestion(turnId: string, requestId: string, answer: string): boolean {
  const s = sessions.get(turnId);
  const resolve = s?.askPending.get(requestId);
  if (!s || !resolve) return false;
  s.askPending.delete(requestId);
  resolve(answer);
  return true;
}

/** Resolve a parked permission from a /permission POST. Returns false if unknown. */
export function resolvePermission(
  turnId: string,
  requestId: string,
  decision: PermissionDecision,
): boolean {
  const s = sessions.get(turnId);
  const p = s?.pending.get(requestId);
  if (!s || !p) return false;
  s.pending.delete(requestId);
  if (decision === "always") {
    alwaysAllow.add(p.toolName); // immediate, this session
    // PERSIST it too — "always allow" should stick across conversations and
    // restarts (otherwise a new chat re-asks). Recorded as an allow in the
    // tool-policy, the same store the MCP panel edits; revocable there.
    setToolPolicy(p.toolName, "allow");
  }
  // Approving a plan with "auto" turns on auto-accept for the rest of this turn
  // (and seeds the next via the client echoing it back in the request body).
  if (decision === "plan-auto") s.autoAccept = true;
  // Accepting a plan switches the session OUT of plan mode (the approved plan
  // then executes this turn): "plan-auto" → auto-accept edits, "plan-manual" →
  // approve each step. "plan-refine" and "no" deny so the agent keeps planning.
  const mode: "acceptEdits" | "default" | null =
    decision === "plan-auto" ? "acceptEdits" : decision === "plan-manual" ? "default" : null;
  const allow: PermissionResult = mode
    ? {
        behavior: "allow",
        updatedInput: p.input,
        updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
      }
    : { behavior: "allow", updatedInput: p.input };
  const denied = decision === "no" || decision === "plan-refine";
  p.resolve(
    denied
      ? {
          behavior: "deny",
          message:
            decision === "plan-refine"
              ? "The user wants to keep refining the plan before any execution. Discuss and revise the plan with them; do not start building yet."
              : "Denied by user.",
        }
      : allow,
  );
  return true;
}

/** Release every parked resolver so the SDK unblocks and the generator can
 *  finish/throw rather than hang forever. Used on both abort and end-of-turn. */
function drainPending(s: TurnSession, reason: string): void {
  // Reject any still-parked permission as a deny.
  for (const p of s.pending.values()) p.resolve({ behavior: "deny", message: reason });
  s.pending.clear();
  // Unblock any parked ask_user question so its tool call returns.
  for (const resolve of s.askPending.values()) resolve(`(no answer — ${reason})`);
  s.askPending.clear();
}

/** Stop a live turn: abort its SDK query AND release any parked permission /
 *  question prompt. Without the drain, a turn waiting on a prompt would stay
 *  blocked on that promise (abort alone never rejects it), so the generator
 *  never finishes, `done` is never emitted, and the stream never closes — the
 *  stop button appears dead. The session is left for the turn's own finally to
 *  endSession(); we only unblock it here. */
export function abortSession(turnId: string): boolean {
  const s = sessions.get(turnId);
  if (!s) return false;
  s.ac.abort();
  drainPending(s, "the turn was stopped");
  return true;
}

export function endSession(turnId: string): void {
  const s = sessions.get(turnId);
  if (!s) return;
  drainPending(s, "the turn ended");
  sessions.delete(turnId);
}
