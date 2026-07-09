import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-turn workspace binding. A turn (one runTurn() stream) is pinned to ONE
 * team/repo for its whole life — so the agent's file/GitHub tools write to that
 * turn's repo, never a global "current team" that another concurrent turn might
 * have switched. This is what lets several teams run at once safely: each is its
 * own isolated session ("like another terminal instance"), and resolveRepo() /
 * activeProtoDir() / localWorkspaceDir() resolve against THIS turn's binding.
 *
 * Implemented with AsyncLocalStorage so the binding propagates automatically
 * through every await and tool callback inside the turn — no plumbing through
 * tool signatures. Outside any turn (CLI commands, startup) there's no store and
 * the accessors fall back to the persisted global selection, as before.
 */
export interface WorkspaceContext {
  /** The repo this turn is bound to ("owner/name"), or null for no-team/local. */
  repo: string | null;
  /** The no-team local session folder id for this turn (when repo is null). */
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
