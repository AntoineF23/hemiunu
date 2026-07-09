// Engine-loop subagents: the P4 replacement for the SDK's Task delegation and
// the SDK-driven runSubagent. A subagent run is a RECURSIVE runTurn() with the
// subagent's spec from SUBAGENTS (prompts / knowledge packs verbatim), the tier
// model resolved via registry tags, an EPHEMERAL transcript (nothing persists
// to the conversation), and auto-approved permissions behind the wired pipeline
// — where a persistent policy "block" still wins. Every nested event is stamped
// with `parent` = the task id (the delegating tool-call id for `delegate`), so
// subagent progress flows through the SAME TurnEvent stream as the main turn.
//
// Recursion depth is 1: a subagent's tool set NEVER contains `delegate` or the
// orchestrator's `parallel` (they're filtered out even if a spec pattern would
// match), so a subagent cannot delegate further.

import { randomUUID } from "node:crypto";
import type {
  HemiTool,
  ModelEntry,
  ResolvedModel,
  RunTurnOptions,
  StopReason,
  TurnEvent,
  WorkspaceContext,
} from "@hemiunu/engine";
import {
  Compactor,
  TranscriptStore,
  createPipeline,
  loadModelRegistry,
  modelForTag,
  resolveModel,
  runTurn,
} from "@hemiunu/engine";
import { z } from "zod";
import { listCustomAgents, loadCustomAgent } from "./agents";
import { defineTool, ok } from "./hemitools/helpers";
import { attachmentsBlock } from "./overlay";
import { PARALLEL_TOOL_ID } from "./orchestrator";
import { createHemiPipelineConfig } from "./pipeline-wiring";
import { SUBAGENTS, SUBAGENT_GUARD, subagentPrompt, type SubagentName } from "./subagents";

/** The engine's delegation tool — the replacement for the SDK's `Task`. */
export const DELEGATE_TOOL_NAME = "delegate";

/**
 * Everything a turn resolves ONCE so subagents can run on the engine loop.
 * All fields are optional: defaults come from the registry and config dir.
 */
export interface EngineSubagentContext {
  /** The turn's full tool pool; each subagent gets the subset its spec names
   *  (delegate/parallel are always excluded — recursion depth 1). */
  tools?: HemiTool[];
  /** Connected source tool patterns (mcp__<name>__*) for the researcher. */
  sourceTools?: string[];
  /** Model registry override (default: loadModelRegistry()). */
  registry?: ModelEntry[];
  /** Registry id override for the synthesis tier (default: the tagged entry). */
  model?: string;
  /** Registry id override for the research tier (default: the tagged entry). */
  researchModel?: string;
  /** Per-user config root override — custom agents + attachments (tests). */
  userRoot?: string;
  /** toolpolicy root override (tests). */
  policyRoot?: string;
  /** Per-result truncation budget for sub-run tools. */
  budgetTokens?: number;
  /** Compaction trigger fraction for the sub-run's ephemeral compactor
   *  (default: the Compactor's env-derived threshold). Test/DI seam. */
  compactThreshold?: number;
  /** Hard cap on model round-trips per sub-run. */
  maxSteps?: number;
  /** Test seam: resolve a registry id without touching provider factories. */
  resolve?: (id: string) => ResolvedModel;
  /** Test seam: the engine loop implementation (default: runTurn). */
  runTurnImpl?: (opts: RunTurnOptions) => AsyncGenerator<TurnEvent>;
}

/** Per-run options for one subagent execution. */
export interface EngineSubagentRunOptions {
  /** Task id — `task-start`/`task-done` carry it and every nested event is
   *  stamped `parent` = this id. `delegate` passes its own tool-call id. */
  taskId: string;
  /** Assigned write scope (parallel scoped designers) — enforced by the
   *  pipeline's checkWriteScope on the sub-run. */
  writeScope?: string[];
  /** The delegating turn's abort signal; aborting it cancels the sub-run. */
  signal?: AbortSignal;
  /** Event sink (the delegating ToolContext's emit). */
  emit?: (e: TurnEvent) => void;
  /** Workspace the sub-run stays bound to (the delegating turn's). */
  workspace?: WorkspaceContext;
}

/** What an agent name resolves to before the sub-run starts. */
interface ResolvedAgent {
  name: string;
  systemPrompt: string;
  /** Registry id the run uses (tier-tagged entry, or a custom agent's pick). */
  modelId: string;
  tools: HemiTool[];
}

function isBuiltin(name: string): name is SubagentName {
  return Object.prototype.hasOwnProperty.call(SUBAGENTS, name);
}

/** `mcp__server__*` prefix patterns or exact names (the SubagentSpec grammar). */
function matchesPattern(name: string, pattern: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** Depth-1 guard: orchestration tools never reach a subagent's tool set. */
function isOrchestrationTool(name: string): boolean {
  return name === DELEGATE_TOOL_NAME || name === PARALLEL_TOOL_ID;
}

/**
 * The agents a turn can delegate to: built-ins (source-dependent ones only when
 * sources are connected) plus the user's custom agents (~/.hemiunu/agents/*.md;
 * a custom agent never shadows a built-in name).
 */
export function availableEngineAgents(
  ctx: EngineSubagentContext,
): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const [name, spec] of Object.entries(SUBAGENTS)) {
    if (spec.needsSources && !ctx.sourceTools?.length) continue;
    out.push({ name, description: spec.description });
  }
  for (const a of listCustomAgents(ctx.userRoot)) {
    if (isBuiltin(a.name)) continue;
    out.push({ name: a.name, description: a.description });
  }
  return out;
}

/** Resolve an agent name to its prompt, tier model id, and filtered tool set. */
function resolveAgent(
  agent: string,
  ctx: EngineSubagentContext,
  registry: ModelEntry[],
): ResolvedAgent {
  const synthesisId = ctx.model ?? modelForTag("synthesis", registry, registry[0].id).id;

  if (isBuiltin(agent)) {
    const spec = SUBAGENTS[agent];
    if (spec.needsSources && !ctx.sourceTools?.length) {
      throw new Error(`The '${agent}' subagent is only available when data sources are connected.`);
    }
    const patterns = spec.tools(ctx.sourceTools ?? []);
    return {
      name: agent,
      systemPrompt: subagentPrompt(agent),
      modelId:
        spec.tier === "research"
          ? (ctx.researchModel ?? modelForTag("research", registry, synthesisId).id)
          : synthesisId,
      tools: (ctx.tools ?? []).filter(
        (t) => !isOrchestrationTool(t.name) && patterns.some((p) => matchesPattern(t.name, p)),
      ),
    };
  }

  // Custom agents (~/.hemiunu/agents/*.md) — reasoning-only, and free to name
  // ANY registry model (resolveModel validates the id when the run starts).
  const custom = loadCustomAgent(agent, ctx.userRoot);
  if (!custom) {
    const known = availableEngineAgents(ctx)
      .map((a) => a.name)
      .join(", ");
    throw new Error(`Unknown agent '${agent}'. Available agents: ${known}.`);
  }
  return {
    name: custom.name,
    systemPrompt: custom.prompt + attachmentsBlock(custom.name, ctx.userRoot) + SUBAGENT_GUARD,
    modelId: custom.model || synthesisId,
    tools: [],
  };
}

/**
 * Run one subagent to completion on the ENGINE loop and return its final text.
 * The sub-run is ephemeral (no TranscriptStore), auto-approved (persistent
 * "block" still refuses via the pipeline's policy step), bound to the parent's
 * workspace and abort signal, and streams stamped events into `opts.emit`.
 * Throws on abort or a model-level error — callers own task-start/task-done.
 */
export async function runEngineSubagent(
  agent: string,
  prompt: string,
  ctx: EngineSubagentContext,
  opts: EngineSubagentRunOptions,
): Promise<string> {
  const registry = ctx.registry ?? loadModelRegistry();
  const resolved = resolveAgent(agent, ctx, registry);
  const resolvedModel = ctx.resolve
    ? ctx.resolve(resolved.modelId)
    : resolveModel(resolved.modelId, registry);

  // Auto-approve inside the sub-run (the gate was approving the delegating
  // call); the pipeline's policy step still enforces a user "block".
  const executor = createPipeline(
    createHemiPipelineConfig({
      tools: resolved.tools,
      autoAccept: true,
      writeScope: opts.writeScope,
      budgetTokens: ctx.budgetTokens,
      // A single retrieval must never overflow the sub-run model's window alone.
      contextWindow: resolvedModel.entry.contextWindow,
      policyRoot: ctx.policyRoot,
    }),
  );

  // The sub-run is ephemeral (no durable transcript), but a multi-step
  // research/tool session still grows its in-memory window and WILL overflow
  // the model without a compaction guard — this is the researcher's 844k →
  // ContextWindowExceeded. Give it the SAME Compactor machinery the main loop
  // uses, backed by an in-memory store (nothing persists) and summarizing with
  // the sub-run's own model. Before every provider call the check estimates the
  // full wire (messages + system + tool schemas) against THIS model's window
  // and folds — or, failing that, truncates — so the request always fits.
  const compactionStore = new TranscriptStore(":memory:");
  const compactor = new Compactor({
    transcript: compactionStore,
    threshold: ctx.compactThreshold,
    registry,
    resolvedModel,
  });

  // Propagate the parent's abort: stopping the turn cancels the sub-run too.
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (opts.signal?.aborted) abortController.abort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const loop = ctx.runTurnImpl ?? runTurn;
  let text = "";
  let stopReason: StopReason = "end";
  let lastError: string | undefined;
  try {
    for await (const e of loop({
      prompt,
      systemPrompt: resolved.systemPrompt,
      resolvedModel,
      tools: resolved.tools,
      executor,
      abortController,
      workspace: opts.workspace,
      maxSteps: ctx.maxSteps,
      // Ephemeral history (no TranscriptStore), but the compactor keeps the
      // window bounded so a long tool session can't blow the model's context.
      compactionCheck: compactor.check,
    })) {
      switch (e.type) {
        // Nested progress joins the main stream, stamped with the task id.
        case "text-delta":
        case "reasoning-delta":
        case "tool-start":
        case "tool-result":
          opts.emit?.({ ...e, parent: opts.taskId });
          break;
        case "error":
          lastError = e.message;
          break;
        case "turn-finish":
          text = e.text;
          stopReason = e.stopReason;
          break;
        default:
          break; // turn-start / step-finish / notes stay internal to the sub-run
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    compactionStore.close();
  }

  if (stopReason === "aborted") throw new Error(`Subagent '${resolved.name}' was aborted.`);
  if (stopReason === "error") {
    throw new Error(lastError ?? `Subagent '${resolved.name}' failed.`);
  }
  return text;
}

const delegateInputSchema = z.object({
  agent: z
    .string()
    .describe("Which subagent runs the task — one of the agent names in this tool's description."),
  prompt: z
    .string()
    .describe(
      "Self-contained instruction for the subagent (it sees NONE of this conversation's context).",
    ),
  label: z.string().optional().describe("Short label for this task in progress displays."),
});

/**
 * The `delegate` tool — one self-contained task, one subagent, its final report
 * back as the tool result. Emits task-start/task-done with id = this tool
 * call's id, which is also the `parent` stamp on every nested event.
 */
export function createDelegateTool(ctx: EngineSubagentContext): HemiTool {
  const agents = availableEngineAgents(ctx);
  const roster = agents
    .map((a) => `- \`${a.name}\` — ${a.description || "(no description)"}`)
    .join("\n");
  // Opus-generation models under-delegate by default, so the description
  // carries explicit when-to-call triggering — but only name the researcher
  // when it's actually in the roster (it needs connected sources).
  const researchTrigger = agents.some((a) => a.name === "researcher")
    ? " Call this whenever the request matches a subagent's specialty — in particular, when the user asks you to research or look something up in the connected sources, delegate to the `researcher` rather than searching the sources yourself (it runs the retrieval in its own context and returns grounded findings); reserve direct source access for trivial single-fact reads."
    : " Call this whenever the request matches a subagent's specialty.";
  return defineTool({
    name: DELEGATE_TOOL_NAME,
    description: `Delegate ONE self-contained task to a specialist subagent and get its final report back.${researchTrigger} The subagent runs in its own isolated context with its own tools and model — give it a complete, self-contained instruction (it shares none of this conversation). Subagents cannot delegate further. For several INDEPENDENT tasks at once, use the parallel tool instead. Available agents:\n${roster}`,
    inputSchema: delegateInputSchema,
    permission: "ask",
    readOnly: false,
    async execute({ agent, prompt, label }, toolCtx) {
      const taskId = toolCtx.toolCallId ?? randomUUID();
      const display = label ?? agent;
      toolCtx.emit({ type: "task-start", id: taskId, agent, label: display });
      try {
        const text = await runEngineSubagent(agent, prompt, ctx, {
          taskId,
          signal: toolCtx.signal,
          emit: toolCtx.emit,
          workspace: toolCtx.workspace,
        });
        toolCtx.emit({ type: "task-done", id: taskId, agent, label: display, ok: true });
        return ok(text || `(the '${agent}' subagent returned no text)`);
      } catch (e) {
        toolCtx.emit({ type: "task-done", id: taskId, agent, label: display, ok: false });
        return {
          content: `Subagent '${agent}' failed: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    },
  });
}
