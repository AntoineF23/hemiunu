import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  runSubagent,
  type SubagentName,
  type SubagentRunContext,
} from "./subagents";

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
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const MAX_CONCURRENCY = 5;

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
              .enum(["researcher", "prototyper"])
              .describe("Which subagent runs this task."),
            prompt: z
              .string()
              .describe("Self-contained instruction for that subagent (it shares none of the others' context)."),
            label: z
              .string()
              .optional()
              .describe("Short label for this task in the combined results."),
          }),
        )
        .min(1)
        .describe("Independent tasks to run concurrently."),
    },
    async ({ tasks }) => {
      const results = await pool(tasks, MAX_CONCURRENCY, async (t) => {
        const label = t.label ?? t.agent;
        const agent = t.agent as SubagentName;
        ctx.onEvent?.({ type: "task-start", label, agent });
        try {
          const text = await runSubagent(agent, t.prompt, ctx, (tool) =>
            ctx.onEvent?.({ type: "task-tool", label, tool }),
          );
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
