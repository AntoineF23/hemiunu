// The engine's hand-rolled agent loop. One turn = a `while` loop over
// SINGLE-STEP streamText calls with NON-EXECUTING tools (schemas only — the
// AI SDK never runs them). The loop stays under our control because Hemiunu
// parks a promise mid-turn for permission prompts and rewrites tool inputs;
// the SDK's own multi-step loop can't do either. Tool calls run through the
// ToolExecutor seam (P2 puts the permission pipeline behind it), results are
// appended to the transcript, and the loop repeats until the model stops.

import { randomUUID } from "node:crypto";
import {
  APICallError,
  jsonSchema,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ToolSet,
} from "ai";
import { summaryNote } from "./compactor";
import {
  addUsage,
  emptyUsage,
  type StopReason,
  type ToolOutput,
  type TurnEvent,
  type TurnUsage,
} from "./events";
import { DirectExecutor, type CanUseTool, type ToolCall, type ToolExecutor } from "./executor";
import {
  costUsd,
  loadModelRegistry,
  modelForTag,
  promptHintsBlock,
  resolveModel,
  type ModelEntry,
  type ResolvedModel,
} from "./models";
import { isJsonSchemaInput, type HemiTool, type PermissionMode, type ToolContext } from "./tool";
import type { TranscriptMessage, TranscriptStore } from "./transcript";
import { withWorkspace, type WorkspaceContext } from "./workspace";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  contentAttr,
  ctxWith,
  otelContext,
  recordContent,
  startSpan,
  telemetryEnabled,
} from "./telemetry";

/** JSON-serialize a tool input/output for a span attribute (never throws). */
function spanJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The one non-read-only tool that stays advertised in plan mode. */
export const PLAN_EXIT_TOOL = "exit_plan_mode";

const DEFAULT_MAX_STEPS = 40;

/** What a compaction check produced: the summary the history was folded into. */
export interface CompactionOutcome {
  summary: string;
}

/**
 * P3 seam: called before every model round-trip so the compaction service can
 * fold history in place (and record it via TranscriptStore.recordCompaction).
 * `usage` is the most recent completed step's usage — its input-side tokens
 * (input + cacheRead + cacheWrite) are the current context size; zero before
 * the first step, where the shipped Compactor.check falls back to estimating
 * the loaded history against the CURRENT entry's window (so a transcript
 * carried over from a bigger-window model is compacted BEFORE the first
 * provider call instead of dying with ContextWindowExceeded). `system` is the
 * turn's assembled system prompt — it rides on every wire call, so estimates
 * must account for it. Returning a CompactionOutcome makes the loop emit the
 * `compaction` TurnEvent. Omitting the hook is a no-op — Compactor.check is
 * the shipped implementation.
 */
export type CompactionCheck = (state: {
  conversationId: string;
  messages: TranscriptMessage[];
  entry: ModelEntry;
  usage: TurnUsage;
  /** The turn's system prompt (soul + hints + resume summary), if any. */
  system?: string;
  /** The tool set advertised on the upcoming call. Its serialized schemas ride
   *  on every request, so a faithful estimate must count them (loop passes the
   *  step's ACTIVE tools — plan mode narrows the set). */
  tools?: HemiTool[];
}) => void | CompactionOutcome | Promise<void | CompactionOutcome>;

export interface RunTurnOptions {
  prompt: string;
  /** Registry id of the main model (default: the synthesis-tagged entry). */
  model?: string;
  /** Registry id for the retrieval tier (subagents; unused by the core loop). */
  researchModel?: string;
  systemPrompt?: string;
  /** Conversation id to resume; omit to start a fresh conversation. */
  resume?: string;
  /** Extra MCP servers — adapted to HemiTools by the caller (later phase). */
  mcpServers?: Record<string, unknown>;
  /** Interactive permission callback — consumed by the P2 pipeline executor. */
  canUseTool?: CanUseTool;
  /** Abort controller to stop the turn mid-flight (Esc to interrupt). */
  abortController?: AbortController;
  /** Pin this turn to one workspace for its whole life (ALS-relayed). */
  workspace?: WorkspaceContext;
  permissionMode?: PermissionMode;
  /** The turn's toolset (already includes MCP/subagent adapters). */
  tools?: HemiTool[];
  /** Tool-execution seam (default: DirectExecutor over `tools`). */
  executor?: ToolExecutor;
  /** Durable history; omit for throwaway turns. */
  transcript?: TranscriptStore;
  /** Model registry override (default: loadModelRegistry()). */
  registry?: ModelEntry[];
  /** Hard cap on model round-trips per turn. */
  maxSteps?: number;
  compactionCheck?: CompactionCheck;
  /** Test/DI seam: skip registry resolution and use this model directly. */
  resolvedModel?: ResolvedModel;
  /** OpenTelemetry span naming + attributes for this turn. Subagent runs set a
   *  `functionId` (e.g. "hemiunu.subagent.designer") and knowledge-pack
   *  attributes so their spans are labelled and attributable. No-op when OTel
   *  is off. */
  telemetry?: { functionId?: string; attributes?: Record<string, string | number | boolean> };
}

/**
 * Run one agent turn and stream it as TurnEvents. When a workspace is given,
 * the whole loop (and every tool callback inside it) runs bound to that
 * workspace — see the relay comment below, ported from agent-core/agent.ts.
 */
export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<TurnEvent> {
  // Drive the loop inside this turn's workspace binding and relay events out
  // through a queue. The relay matters: an async generator's body resumes in
  // the CALLER's async context on each `.next()`, which would drop the
  // binding. By starting turnLoop() (and every tool execution inside it)
  // synchronously inside withWorkspace(), every tool callback inherits THIS
  // turn's repo — even while another team's turn runs concurrently.
  if (!opts.workspace) {
    yield* turnLoop(opts);
    return;
  }

  const buffer: TurnEvent[] = [];
  let done = false;
  let failure: unknown;
  let signal: Promise<void>;
  let fire: () => void = () => {};
  const reset = () => {
    signal = new Promise<void>((r) => (fire = r));
  };
  reset();
  const wake = () => {
    const f = fire;
    reset();
    f();
  };

  // Capture the active OTel context so spans created inside the detached IIFE
  // (which the async-context relay would otherwise orphan) still nest under the
  // caller's span — the same reason the workspace binding is re-established here.
  const parentCtx = otelContext.active();
  withWorkspace(opts.workspace, () => {
    void otelContext.with(parentCtx, () =>
      (async () => {
        try {
          for await (const event of turnLoop(opts)) {
            buffer.push(event);
            wake();
          }
        } catch (e) {
          failure = e;
        } finally {
          done = true;
          wake();
        }
      })(),
    );
  });

  while (true) {
    const waiter = signal!; // capture before draining, so a push can't slip past
    while (buffer.length) yield buffer.shift()!;
    if (failure) throw failure;
    if (done) return;
    await waiter;
  }
}

/** The actual loop, free of workspace-relay concerns. */
async function* turnLoop(opts: RunTurnOptions): AsyncGenerator<TurnEvent> {
  const resolved = opts.resolvedModel ?? resolveDefault(opts.model, opts.registry);
  const { entry } = resolved;
  const conversationId = opts.resume ?? randomUUID();
  const signal = (opts.abortController ?? new AbortController()).signal;
  const tools = opts.tools ?? [];
  const executor = opts.executor ?? new DirectExecutor(tools);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  // The turn span — parent of every step / model / tool / subagent span. No-op
  // (undefined) when telemetry is off, so the rest of the loop stays branch-free.
  const turnSpan = startSpan(opts.telemetry?.functionId ?? "hemiunu.turn", {
    "hemiunu.conversation_id": conversationId,
    "hemiunu.model": entry.id,
    "hemiunu.permission_mode": opts.permissionMode ?? "default",
    ...(opts.telemetry?.attributes ?? {}),
  });
  const turnCtx = ctxWith(turnSpan);

  // History: the latest compaction summary rides in the system prompt; live
  // (non-superseded, post-compaction) messages come back verbatim. Because the
  // transcript IS the AI SDK ModelMessage[], resuming on a different model
  // than the one that wrote it just works.
  const loaded = opts.transcript?.load(conversationId);
  const messages: TranscriptMessage[] = [...(loaded?.messages ?? [])];
  const userMessage: TranscriptMessage = { role: "user", content: opts.prompt };
  messages.push(userMessage);
  opts.transcript?.append(conversationId, [userMessage]);
  // The entry's family-scoped prompt hints ride AFTER the caller's system
  // prompt (soul + overlays) and BEFORE the compaction summary — small
  // addenda that correct a weaker family's quirks without forking the soul.
  const system = [
    opts.systemPrompt,
    promptHintsBlock(entry),
    loaded?.summary && summaryNote(loaded.summary),
  ]
    .filter(Boolean)
    .join("\n\n");

  // Tool-context plumbing. ctx.emit buffers into `pending`; emitDuring drains
  // the buffer as TurnEvents WHILE a tool executes (so subagent progress
  // streams live instead of arriving when the tool finishes).
  let mode: PermissionMode = opts.permissionMode ?? "default";
  const pending: TurnEvent[] = [];
  let notify: (() => void) | undefined;
  // Permission decision per tool-call id, captured off the event stream so the
  // tool span can record who authorized the call.
  const decisions = new Map<string, "auto" | "policy" | "user">();
  const ctx: ToolContext = {
    workspace: opts.workspace,
    signal,
    conversationId,
    emit: (e) => {
      if (e.type === "permission-note") decisions.set(e.id, e.decision);
      pending.push(e);
      notify?.();
    },
    mode: () => mode,
    setMode: (m) => {
      mode = m;
    },
  };

  async function* emitDuring<T>(work: Promise<T>): AsyncGenerator<TurnEvent, T> {
    let settled = false;
    const guarded = work.finally(() => {
      settled = true;
      notify?.();
    });
    while (!settled) {
      while (pending.length) yield pending.shift()!;
      if (settled) break;
      await Promise.race([
        guarded.catch(() => {}),
        new Promise<void>((r) => {
          notify = r;
        }),
      ]);
      notify = undefined;
    }
    while (pending.length) yield pending.shift()!;
    return guarded;
  }

  yield { type: "turn-start", conversationId, model: entry.id };

  let total = emptyUsage();
  // The last completed step's usage — its input-side tokens are the context
  // size the compaction check compares against the model's window.
  let lastStepUsage = emptyUsage();
  let finalText = "";
  let stopReason: StopReason = "end";
  let toolErrors = 0;
  let stepIndex = 0;

  try {
    turn: while (true) {
      if (signal.aborted) {
        stopReason = "aborted";
        break;
      }
      if (total.steps >= maxSteps) {
        stopReason = "max-steps";
        break;
      }
      // Plan mode: advertise only read-only tools plus the plan-exit tool.
      // Recomputed every step because a tool may setMode() mid-turn. Resolved
      // BEFORE the compaction check so the estimate counts the schemas actually
      // going on this call.
      const active =
        mode === "plan" ? tools.filter((t) => t.readOnly || t.name === PLAN_EXIT_TOOL) : tools;

      const compaction = await opts.compactionCheck?.({
        conversationId,
        messages,
        entry,
        usage: lastStepUsage,
        system,
        tools: active,
      });
      if (compaction) yield { type: "compaction", summary: compaction.summary };

      // One step span per model round-trip. The AI-SDK model span (from
      // experimental_telemetry) and any tool spans nest under it via stepCtx.
      const stepSpan = startSpan(
        "hemiunu.step",
        { "hemiunu.step": stepIndex, "hemiunu.model": entry.id },
        turnCtx,
      );
      const stepCtx = ctxWith(stepSpan, turnCtx);
      try {
        const wire = wireMessages(system, messages, entry);
        const result = otelContext.with(stepCtx, () =>
          streamText({
            model: resolved.languageModel,
            messages: wire,
            allowSystemInMessages: true,
            tools: toToolSet(active),
            stopWhen: stepCountIs(1),
            abortSignal: signal,
            providerOptions: resolved.providerOptions as Parameters<
              typeof streamText
            >[0]["providerOptions"],
            // The GenAI model span nests under our hemiunu.step span (via
            // stepCtx), which already carries conversation/model/knowledge-pack
            // attributes — so this only needs the enable + content flags. (v7's
            // TelemetryOptions has no `metadata` field.)
            experimental_telemetry: telemetryEnabled()
              ? {
                  isEnabled: true,
                  functionId: opts.telemetry?.functionId ?? "hemiunu.turn",
                  recordInputs: recordContent(),
                  recordOutputs: recordContent(),
                }
              : undefined,
          }),
        );

        let stepText = "";
        let stepUsage = emptyUsage();
        let finishReason: string | undefined;
        const calls: ToolCall[] = [];
        try {
          for await (const part of result.fullStream) {
            switch (part.type) {
              case "text-delta":
                stepText += part.text;
                yield { type: "text-delta", text: part.text };
                break;
              case "reasoning-delta":
                yield { type: "reasoning-delta", text: part.text };
                break;
              case "tool-call": {
                const c = part as unknown as {
                  toolCallId: string;
                  toolName: string;
                  input: unknown;
                };
                calls.push({ id: c.toolCallId, name: c.toolName, input: c.input });
                yield { type: "tool-start", id: c.toolCallId, name: c.toolName, input: c.input };
                break;
              }
              case "finish-step":
                stepUsage = toTurnUsage(part.usage);
                finishReason = part.finishReason;
                break;
              case "abort":
                stopReason = "aborted";
                break turn;
              case "error":
                warnWireShape(part.error, wire);
                yield { type: "error", message: describe(part.error) };
                stopReason = "error";
                break turn;
            }
          }
        } catch (e) {
          if (signal.aborted) {
            stopReason = "aborted";
            break;
          }
          warnWireShape(e, wire);
          yield { type: "error", message: describe(e) };
          stopReason = "error";
          break;
        }

        total = addUsage(total, stepUsage);
        lastStepUsage = stepUsage;
        if (stepText) finalText = stepText;
        yield { type: "step-finish", usage: stepUsage };

        if (stepSpan) {
          if (finishReason) stepSpan.setAttribute("hemiunu.finish_reason", finishReason);
          stepSpan.setAttribute("hemiunu.usage.input_tokens", stepUsage.inputTokens);
          stepSpan.setAttribute("hemiunu.usage.output_tokens", stepUsage.outputTokens);
          stepSpan.setAttribute("hemiunu.usage.cache_read_tokens", stepUsage.cacheReadTokens);
          const t = contentAttr(stepText);
          if (t) stepSpan.setAttribute("hemiunu.step.text", t);
        }

        // Persist what the model said (assistant message incl. tool-call parts).
        // The stream's `calls[]` are authoritative for what we execute below, so
        // reconcile the snapshot against them — never persist a tool result whose
        // tool-call is missing from the assistant message (a provider-rejected
        // orphan; see ensureAssistantToolCalls).
        const stepMessages = ensureAssistantToolCalls(
          (await result.response).messages as TranscriptMessage[],
          calls,
        );
        messages.push(...stepMessages);
        opts.transcript?.append(conversationId, stepMessages);

        if (finishReason !== "tool-calls" || calls.length === 0) break;

        // Run the tool calls through the executor seam and pair each with its
        // tool-start. An abort mid-batch synthesizes error results for the rest
        // so the transcript stays resumable (every tool call has a result).
        const results: Extract<TranscriptMessage, { role: "tool" }>["content"] = [];
        for (const call of calls) {
          // Tool span — nested under the step. Captures input, result, the
          // permission decision, duration; and, for `delegate`, the subagent's
          // whole span subtree (execSafe runs within toolCtx).
          const toolSpan = startSpan(
            `hemiunu.tool.${call.name}`,
            {
              "hemiunu.tool.name": call.name,
              "hemiunu.tool.id": call.id,
              ...(contentAttr(spanJson(call.input))
                ? { "hemiunu.tool.input": contentAttr(spanJson(call.input))! }
                : {}),
            },
            stepCtx,
          );
          const toolCtx = ctxWith(toolSpan, stepCtx);
          const startedAt = Date.now();
          const output: ToolOutput = signal.aborted
            ? { content: "Tool execution aborted.", isError: true }
            : yield* emitDuring(otelContext.with(toolCtx, () => execSafe(executor, call, ctx)));
          if (output.isError) toolErrors += 1;
          if (toolSpan) {
            toolSpan.setAttribute("hemiunu.tool.duration_ms", Date.now() - startedAt);
            toolSpan.setAttribute("hemiunu.tool.is_error", !!output.isError);
            const decision = decisions.get(call.id);
            if (decision) toolSpan.setAttribute("hemiunu.tool.decision", decision);
            const resultAttr = contentAttr(output.content);
            if (resultAttr) toolSpan.setAttribute("hemiunu.tool.result", resultAttr);
            if (output.isError) toolSpan.setStatus({ code: SpanStatusCode.ERROR });
            toolSpan.end();
          }
          yield { type: "tool-result", id: call.id, name: call.name, output };
          results.push({
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.name,
            output: output.isError
              ? { type: "error-text", value: output.content }
              : { type: "text", value: output.content },
          });
        }
        const toolMessage: TranscriptMessage = { role: "tool", content: results };
        messages.push(toolMessage);
        opts.transcript?.append(conversationId, [toolMessage]);
        stepIndex += 1;
      } finally {
        stepSpan?.end();
      }
    }
  } finally {
    if (turnSpan) {
      turnSpan.setAttribute("hemiunu.usage.input_tokens", total.inputTokens);
      turnSpan.setAttribute("hemiunu.usage.output_tokens", total.outputTokens);
      turnSpan.setAttribute("hemiunu.usage.cache_read_tokens", total.cacheReadTokens);
      turnSpan.setAttribute("hemiunu.usage.steps", total.steps);
      turnSpan.setAttribute("hemiunu.cost_usd", costUsd(entry, total));
      turnSpan.setAttribute("hemiunu.stop_reason", stopReason);
      turnSpan.setAttribute("hemiunu.tool_errors", toolErrors);
      if (stopReason === "error") turnSpan.setStatus({ code: SpanStatusCode.ERROR });
      turnSpan.end();
    }
  }

  yield {
    type: "turn-finish",
    text: finalText,
    usage: total,
    costUsd: costUsd(entry, total),
    stopReason,
  };
}

/** Resolve the model id (default: the synthesis-tagged registry entry). */
function resolveDefault(id: string | undefined, registry?: ModelEntry[]): ResolvedModel {
  const entries = registry ?? loadModelRegistry();
  return resolveModel(id ?? modelForTag("synthesis", entries, entries[0].id).id, entries);
}

/** Advertise tools to the model as SCHEMAS ONLY — no execute, so the AI SDK
 * never runs them and every call comes back to our loop as finish "tool-calls".
 * MCP tools carry raw JSON Schema — wrapped with the AI SDK's jsonSchema()
 * verbatim, never round-tripped through zod. */
function toToolSet(tools: HemiTool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    const schema = isJsonSchemaInput(t.inputSchema)
      ? jsonSchema(t.inputSchema.jsonSchema as Parameters<typeof jsonSchema>[0])
      : t.inputSchema;
    set[t.name] = { description: t.description, inputSchema: schema };
  }
  return set;
}

type AssistantMessage = Extract<TranscriptMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolMessage = Extract<TranscriptMessage, { role: "tool" }>;
type ToolResultPart = ToolMessage["content"][number];

/** An assistant message's content as parts (a plain string becomes one text part). */
function assistantParts(content: AssistantMessage["content"]): AssistantPart[] {
  if (Array.isArray(content)) return content;
  return content ? [{ type: "text", text: content }] : [];
}

/**
 * Guarantee tool-call / tool-result integrity before the history reaches ANY
 * provider — a canonicalizing normalizer over the WIRE view (the persisted
 * transcript is never rewritten). Strict providers — notably Vertex/Gemini,
 * reached here through the LiteLLM proxy for openai-compatible entries like
 * `deepseek-v3` — reject a tool output that isn't preceded by the assistant
 * tool-call it answers ("No tool calls but found tool output"), reject a
 * tool-call that never gets a result, and several also reject duplicated
 * results, results split away from their call, and back-to-back assistant
 * messages. A durable transcript can hold any of these (a proxied step whose
 * streamed tool-calls didn't survive into the persisted assistant message, a
 * crash between the assistant and tool appends, a compaction/truncation splice
 * landing between a pair), so we canonicalize every step rather than trust
 * the store. The wire-invariants harness proves the postconditions through
 * each real provider adapter.
 *
 * Postconditions:
 *  - every kept tool-call has exactly ONE result and vice-versa (orphaned
 *    results and dangling calls are dropped, as before);
 *  - duplicate results for one id keep the LAST; duplicate call ids keep the
 *    FIRST introduction;
 *  - results immediately follow their assistant message, in call order, as a
 *    single tool message (fixes out-of-order pairs AND splice non-adjacency);
 *  - consecutive assistant messages are merged into one (providerOptions are
 *    shallow-merged, later message wins per key).
 *
 * Pure and provider-neutral: an already-canonical history (the common case,
 * e.g. Anthropic direct) is returned as the SAME reference, untouched.
 */
export function balanceToolMessages(history: TranscriptMessage[]): TranscriptMessage[] {
  if (isCanonical(history)) return history;

  // Global facts first, so array order can't hide an answer: a call is
  // "answered" iff some result ANYWHERE carries its id (out-of-order included),
  // and when several do, the LAST one wins.
  const lastResult = new Map<string, ToolResultPart>();
  for (const m of history) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const p of m.content) if (p.type === "tool-result") lastResult.set(p.toolCallId, p);
  }

  const introduced = new Set<string>(); // kept call ids — duplicates keep the FIRST
  const out: TranscriptMessage[] = [];
  // The current run of consecutive assistant messages, merged as we go; its
  // kept call ids in call order. Flushed (assistant, then ONE tool message
  // answering every call) when a non-assistant message or the end arrives.
  let run: AssistantMessage | undefined;
  let runCalls: string[] = [];

  const flush = () => {
    if (!run) return;
    out.push(run);
    if (runCalls.length > 0) {
      out.push({ role: "tool", content: runCalls.map((id) => lastResult.get(id)!) });
    }
    run = undefined;
    runCalls = [];
  };

  for (const m of history) {
    if (m.role === "assistant") {
      const parts = assistantParts(m.content);
      const kept = parts.filter(
        (p) =>
          p.type !== "tool-call" || (lastResult.has(p.toolCallId) && !introduced.has(p.toolCallId)),
      );
      const callIds: string[] = [];
      for (const p of kept) {
        if (p.type === "tool-call") {
          introduced.add(p.toolCallId);
          callIds.push(p.toolCallId);
        }
      }
      if (kept.length === 0) continue; // only dangling/duplicate calls → drop the message
      if (run) {
        const providerOptions =
          run.providerOptions || m.providerOptions
            ? { ...run.providerOptions, ...m.providerOptions }
            : undefined;
        run = {
          role: "assistant",
          content: [...assistantParts(run.content), ...kept],
          ...(providerOptions ? { providerOptions } : {}),
        };
      } else {
        run = kept.length === parts.length ? m : { ...m, content: kept };
      }
      runCalls.push(...callIds);
      continue;
    }
    // Tool messages are dropped here: every kept result is re-emitted next to
    // the assistant message that introduced its call (orphans simply vanish).
    if (m.role === "tool") continue;
    flush();
    out.push(m);
  }
  flush();
  return out;
}

/**
 * Fast-path scan for balanceToolMessages: true iff the history already meets
 * every postcondition, so the common case costs one pass and zero copies.
 */
function isCanonical(history: TranscriptMessage[]): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === "tool") return false; // a tool message not claimed by an assistant below
    if (m.role !== "assistant") continue;
    if (history[i + 1]?.role === "assistant") return false; // consecutive assistants
    const callIds: string[] = [];
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type !== "tool-call") continue;
        if (seen.has(p.toolCallId)) return false; // duplicate call id
        seen.add(p.toolCallId);
        callIds.push(p.toolCallId);
      }
    }
    if (callIds.length === 0) continue;
    const next = history[i + 1];
    if (!next || next.role !== "tool" || !Array.isArray(next.content)) return false; // dangling
    const resultIds: string[] = [];
    for (const p of next.content) {
      if (p.type !== "tool-result") return false;
      if (seen.has(`result:${p.toolCallId}`)) return false; // duplicate result
      seen.add(`result:${p.toolCallId}`);
      resultIds.push(p.toolCallId);
    }
    if (resultIds.length !== callIds.length || resultIds.some((id, k) => id !== callIds[k])) {
      return false; // orphaned/missing/mis-ordered results
    }
    i++; // the tool message is claimed — skip it
  }
  return true;
}

/**
 * Make the persisted assistant message authoritative w.r.t. the tool calls we
 * actually execute. The loop executes the STREAM's `calls[]` (the source of
 * truth) but persists the assistant message from a SEPARATE snapshot
 * (`result.response.messages`); a flaky/proxied step can report tool-calls in
 * the stream that are missing from that snapshot. Injecting the missing calls
 * here means we never write a tool result whose tool-call is absent from
 * history — the durable orphan that wedges a conversation. A no-op when the
 * snapshot already carries every call (the normal case).
 */
export function ensureAssistantToolCalls(
  stepMessages: TranscriptMessage[],
  calls: ToolCall[],
): TranscriptMessage[] {
  if (calls.length === 0) return stepMessages;
  const present = new Set<string>();
  for (const m of stepMessages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === "tool-call") present.add(p.toolCallId);
    }
  }
  const missing = calls.filter((c) => !present.has(c.id));
  if (missing.length === 0) return stepMessages;

  const parts = missing.map((c) => ({
    type: "tool-call" as const,
    toolCallId: c.id,
    toolName: c.name,
    input: c.input,
  }));
  // Inject into the FINAL message only when it is an assistant — injecting
  // into an earlier assistant would put the calls before messages that follow
  // it (mid-array), which the canonical wire view then has to unpick. When the
  // snapshot ends with anything else, append a fresh assistant message last.
  const out = [...stepMessages];
  const last = out.at(-1);
  if (last?.role === "assistant") {
    out[out.length - 1] = { ...last, content: [...assistantParts(last.content), ...parts] };
  } else {
    out.push({ role: "assistant", content: parts });
  }
  return out;
}

/**
 * The wire view of a step: the system prompt as a leading system message,
 * then the live history. For Anthropic models with caching, breakpoints go on
 * the system prompt and the last two history messages so each step reuses the
 * previous step's prefix (system + old turns) from the prompt cache.
 *
 * Exported for package-internal use only (the wire-invariant harness builds
 * the exact view the loop ships) — NOT part of the engine's public index.
 */
export function wireMessages(
  system: string,
  history: TranscriptMessage[],
  entry: ModelEntry,
): TranscriptMessage[] {
  const balanced = balanceToolMessages(history);
  const messages: TranscriptMessage[] = system
    ? [{ role: "system", content: system }, ...balanced]
    : [...balanced];
  if (entry.provider !== "anthropic" || entry.supports.caching === false) return messages;

  const mark = (i: number) => {
    messages[i] = {
      ...messages[i],
      providerOptions: {
        ...messages[i].providerOptions,
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    } as TranscriptMessage;
  };
  if (system) mark(0);
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--, marked++) {
    if (messages[i].role === "system") break;
    mark(i);
  }
  return messages;
}

/** Fold the AI SDK's usage shape into the frozen TurnUsage (one step). */
function toTurnUsage(u: LanguageModelUsage): TurnUsage {
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    steps: 1,
  };
}

/** Executor calls never throw into the loop — failures become error outputs. */
async function execSafe(
  executor: ToolExecutor,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolOutput> {
  try {
    return await executor.execute(call, ctx);
  } catch (e) {
    return { content: describe(e), isError: true };
  }
}

/**
 * The shape of a wire view for failure diagnostics: roles + part types + tool
 * ids only — NEVER message content, so it is always safe to log. This is what
 * pinpoints a pairing defect in a live 4xx ("was the tool result adjacent to
 * its call?") without exposing a word of the conversation.
 */
export function wireShape(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => {
      if (!Array.isArray(m.content)) return m.role;
      const parts = m.content.map((p) =>
        p.type === "tool-call" || p.type === "tool-result" ? `${p.type}:${p.toolCallId}` : p.type,
      );
      return `${m.role}[${parts.join(" ")}]`;
    })
    .join(" | ");
}

/** The 4xx APICallError behind `e` (directly or as a cause), if any. */
function clientError(e: unknown): APICallError | undefined {
  if (APICallError.isInstance(e)) {
    const status = e.statusCode;
    return status !== undefined && status >= 400 && status < 500 ? e : undefined;
  }
  if (e instanceof Error && e.cause !== undefined && e.cause !== e) return clientError(e.cause);
  return undefined;
}

/** Opt-in wire diagnostics: HEMIUNU_WIRE_DEBUG=1 logs the (content-free) wire
 *  shape whenever a provider rejects the request with a 4xx. */
function warnWireShape(e: unknown, wire: TranscriptMessage[]): void {
  if (process.env.HEMIUNU_WIRE_DEBUG !== "1" || !clientError(e)) return;
  console.warn(`hemiunu: provider rejected the request — wire shape: ${wireShape(wire)}`);
}

function describe(e: unknown): string {
  const base = e instanceof Error ? e.message : String(e);
  const api = clientError(e);
  if (!api) return base;
  // A 4xx means WE shipped something the provider rejects — surface the status
  // and the response body (where messages like "No tool calls but found tool
  // output" otherwise get swallowed) so the failure is actionable.
  const body = typeof api.responseBody === "string" ? api.responseBody.trim().slice(0, 300) : "";
  const status = `HTTP ${api.statusCode}`;
  return body ? `${base} (${status}): ${body}` : `${base} (${status})`;
}
