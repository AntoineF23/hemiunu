// HemiTool port of the hemiunu-orchestrator server (orchestrator.ts
// createOrchestratorServer), wired to the ENGINE loop (P4): the deterministic
// fan-out keeps the same pool + validateParallelTasks + one-retry shape, but
// each task now runs runEngineSubagent — a recursive runTurn with auto-approved
// permissions, an ephemeral transcript, the task's own write scope enforced by
// the pipeline, and events stamped `parent` = the task id.

import { randomUUID } from "node:crypto";
import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { runEngineSubagent, type EngineSubagentContext } from "../engine-subagents";
import { pool, validateParallelTasks } from "../orchestrator";
import { defineTool, ok } from "./helpers";

const MAX_CONCURRENCY = 5;

export function createOrchestratorTools(ctx: EngineSubagentContext): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-orchestrator__parallel",
      description:
        "Run several INDEPENDENT subtasks concurrently — each in its own isolated context — and get all their results back together. Use when a task splits into parts that don't depend on each other (e.g. research several topics at once, or research one thing while drafting another). Each task names a subagent and gives it a self-contained instruction. Do NOT use this for steps where a later step needs an earlier step's output — chain those normally instead.",
      inputSchema: z.object({
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
      }),
      permission: "ask",
      readOnly: false,
      async execute({ tasks }, toolCtx) {
        const invalid = validateParallelTasks(tasks);
        if (invalid) return ok(invalid);
        const callId = toolCtx.toolCallId ?? randomUUID();
        const results = await pool(tasks, MAX_CONCURRENCY, async (t, i) => {
          const label = t.label ?? t.agent;
          // Task ids derive from the delegating tool-call id; nested events
          // carry `parent` = the task id so streams stay attributable.
          const taskId = `${callId}:${i}`;
          toolCtx.emit({ type: "task-start", id: taskId, agent: t.agent, label });
          const run = () =>
            runEngineSubagent(t.agent, t.prompt, ctx, {
              taskId,
              writeScope: t.writes,
              signal: toolCtx.signal,
              emit: toolCtx.emit,
              workspace: toolCtx.workspace,
            });
          try {
            let text: string;
            try {
              text = await run();
            } catch (e) {
              // One retry for transient failures (network blip, 5xx) — without
              // it a single flake silently degrades the combined result to a
              // "(failed: …)" line. Never retry a user abort.
              if (toolCtx.signal.aborted) throw e;
              text = await run();
            }
            toolCtx.emit({ type: "task-done", id: taskId, agent: t.agent, label, ok: true });
            return { label, agent: t.agent, text };
          } catch (e) {
            toolCtx.emit({ type: "task-done", id: taskId, agent: t.agent, label, ok: false });
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
        return ok(combined);
      },
    }),
  ];
}
