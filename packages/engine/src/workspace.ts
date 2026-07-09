// Per-turn workspace binding, ported from agent-core/src/workspace-context.ts.
// A turn (one runTurn() stream) is pinned to ONE workspace for its whole life —
// so tool executions write to that turn's repo, never a global "current team"
// that another concurrent turn might have switched.
//
// Implemented with AsyncLocalStorage so the binding propagates automatically
// through every await and tool callback inside the turn — no plumbing through
// tool signatures. Outside any turn (CLI commands, startup) there's no store
// and currentWorkspace() returns undefined.

import { AsyncLocalStorage } from "node:async_hooks";

/** The workspace a turn is bound to — matches ToolContext["workspace"]. */
export interface WorkspaceContext {
  /** The repo this turn is bound to ("owner/name"). */
  repo: string;
  /** The no-team local session folder id for this turn, if any. */
  localSessionId?: string;
}

const als = new AsyncLocalStorage<WorkspaceContext>();

/** Run `fn` with a bound workspace context (propagates through all awaits). */
export function withWorkspace<T>(ctx: WorkspaceContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** The workspace context bound to the current async call chain, if any. */
export function currentWorkspace(): WorkspaceContext | undefined {
  return als.getStore();
}
