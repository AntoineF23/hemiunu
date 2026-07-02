import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runSubagent, type SubagentName, type SubagentRunContext } from "./subagents";

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

const MAX_CONCURRENCY = 5;

/**
 * Validate a parallel fan-out before running it. Returns a message the
 * coordinator can act on, or null when the tasks are safe to run. The
 * write-scope guard (createWriteScopeGuardHook) only engages when a task
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

/**
 * In-process MCP server exposing `parallel` — runs several INDEPENDENT subtasks
 * concurrently, each as an isolated subagent run, and returns their results
 * together. This is how Hemiunu actually parallelises work: the fan-out is
 * deterministic code (the model won't batch subagent calls itself), so genuinely
 * independent tasks run at the same time without polluting each other's context.
 */
export function createOrchestratorServer(ctx: SubagentRunContext) {
  const parallelTool = tool(
    "parallel",
    "Run several INDEPENDENT subtasks concurrently — each in its own isolated context — and get all their results back together. Use when a task splits into parts that don't depend on each other (e.g. research several topics at once, or research one thing while drafting another). Each task names a subagent and gives it a self-contained instruction. Do NOT use this for steps where a later step needs an earlier step's output — chain those normally instead.",
    {
      tasks: z
        .array(
          z.object({
            agent: z
              .enum(["researcher", "prototyper", "designer"])
              .describe("Which subagent runs this task."),
            prompt: z
              .string()
              .describe(
                "Self-contained instruction for that subagent (it shares none of the others' context).",
              ),
            label: z
              .string()
              .optional()
              .describe("Short label for this task in the combined results."),
            writes: z
              .array(z.string())
              .optional()
              .describe(
                "Files/dirs (workspace-relative, e.g. ['src/components/Header.tsx']) this task is allowed to create or modify. When set, the subagent may write ONLY these paths plus brand-new files that don't exist yet — it cannot overwrite any other existing file, and can't scaffold. REQUIRED (with disjoint paths) on every designer task when more than one designer runs in the same call — the call is refused otherwise. Leave unset for a single designer or the SETUP/WIRE passes, which own the shared files.",
              ),
          }),
        )
        .min(1)
        .describe("Independent tasks to run concurrently."),
    },
    async ({ tasks }) => {
      const invalid = validateParallelTasks(tasks);
      if (invalid) return { content: [{ type: "text", text: invalid }] };
      const results = await pool(tasks, MAX_CONCURRENCY, async (t) => {
        const label = t.label ?? t.agent;
        const agent = t.agent as SubagentName;
        ctx.onEvent?.({ type: "task-start", label, agent });
        const run = () =>
          runSubagent(
            agent,
            t.prompt,
            ctx,
            (tool) => ctx.onEvent?.({ type: "task-tool", label, tool }),
            { writeScope: t.writes },
          );
        try {
          let text: string;
          try {
            text = await run();
          } catch (e) {
            // One retry for transient failures (network blip, 5xx) — without
            // it a single flake silently degrades the combined result to a
            // "(failed: …)" line. Never retry a user abort.
            if (ctx.abortController?.signal.aborted) throw e;
            text = await run();
          }
          ctx.onEvent?.({ type: "task-done", label, agent, ok: true });
          return { label, agent: t.agent, text };
        } catch (e) {
          ctx.onEvent?.({ type: "task-done", label, agent, ok: false });
          return {
            label,
            agent: t.agent,
            text: `(failed: ${e instanceof Error ? e.message : String(e)})`,
          };
        }
      });
      const combined = results
        .map((r) => `## ${r.label} — ${r.agent}\n${r.text}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text: combined }] };
    },
    { annotations: { title: "Parallel tasks", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-orchestrator",
    version: "0.0.0",
    tools: [parallelTool],
  });
}

/** Tool id the SDK exposes for the parallel tool. */
export const PARALLEL_TOOL_ID = "mcp__hemiunu-orchestrator__parallel";
