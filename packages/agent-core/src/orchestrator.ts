/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the results. Deterministic — the unit of real parallelism.
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Validate a parallel fan-out before running it. Returns a message the
 * coordinator can act on, or null when the tasks are safe to run. The
 * write-scope guard (createWriteScopeCheck, pipeline-wiring.ts) only engages when a task
 * declares `writes` — so when SEVERAL designers build concurrently, every one
 * of them must declare a scope, and the scopes must be disjoint; otherwise two
 * designers can silently clobber each other's files (the workspace has no
 * locking). A single designer (or the SETUP/WIRE passes) may run unscoped.
 * Exported for tests.
 */
export function validateParallelTasks(
  tasks: { agent: string; label?: string; writes?: string[] }[],
): string | null {
  const designers = tasks.filter((t) => t.agent === "designer");
  if (designers.length <= 1) return null;
  const unscoped = designers.filter((t) => !t.writes?.length);
  if (unscoped.length) {
    const who = unscoped.map((t) => `"${t.label ?? "designer"}"`).join(", ");
    return `Refused: ${designers.length} designer tasks would run concurrently but ${who} declare(s) no \`writes\` scope. Set writes: ['src/components/<Name>.tsx', …] on EVERY parallel designer task (each owning only its component file(s)) so concurrent designers can never overwrite each other, then call parallel again.`;
  }
  const claimed = new Map<string, string>();
  for (const t of designers) {
    const label = t.label ?? "designer";
    for (const w of t.writes ?? []) {
      const norm = w.replace(/^\.\//, "").replace(/\/+$/, "");
      const prev = claimed.get(norm);
      if (prev && prev !== label) {
        return `Refused: tasks "${prev}" and "${label}" both claim write access to '${norm}'. Parallel designer write scopes must be disjoint — give each file to exactly one task, then call parallel again.`;
      }
      claimed.set(norm, label);
    }
  }
  return null;
}

/** Resolved id of the parallel tool. */
export const PARALLEL_TOOL_ID = "mcp__hemiunu-orchestrator__parallel";
