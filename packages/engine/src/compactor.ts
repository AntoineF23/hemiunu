// The compaction service (P3): watches a turn's context size and, when it
// crosses the model's threshold, folds the whole transcript into a structured
// summary. The summary is durable (compactions table) and old rows are marked
// superseded — never deleted — so the full history stays replayable. Wired
// into the loop as its `compactionCheck` hook (Compactor.check); the CLI's
// /compact calls compactNow() directly.

import { generateText } from "ai";
import { z } from "zod";
import { balanceToolMessages, type CompactionCheck, type CompactionOutcome } from "./loop";
import {
  loadModelRegistry,
  modelForTag,
  resolveModel,
  type ModelEntry,
  type ResolvedModel,
} from "./models";
import { isJsonSchemaInput, type HemiTool, type ToolInputSchema } from "./tool";
import type { TranscriptMessage, TranscriptStore } from "./transcript";

// Compacting prompt (Hermes-style structured state) — ported VERBATIM from the
// old CLI (apps/cli/src/index.tsx COMPACT_PROMPT); improve over time.
export const COMPACT_PROMPT = `Compress the conversation so far into a compact brief that preserves all state needed to continue. If an earlier summary is present, fold it in and update it. Then stop.

Use these headings; keep each to short bullets and omit any that are empty:
- Goal: what the user is trying to achieve.
- Completed actions: what has been done, with outcomes.
- Active state: what is in progress right now.
- Blockers: anything stuck or waiting on input.
- Key decisions: choices made and the reasoning.
- Resolved questions: questions answered, and the answer.
- Relevant files / sources: files or data referenced.
- Open questions / next steps: what remains.

Be factual and concise. Output only the summary — no preamble.`;

/**
 * The auto-compaction trigger fraction from the raw HEMIUNU_COMPACT_THRESHOLD
 * env value. Clamped to [0.1, 0.95]; a missing or non-numeric value falls back
 * to 0.5 — NaN must never escape, or `ctxTokens >= ctxWindow * compactAt`
 * would always be false and auto-compaction would silently never fire.
 * (Ported verbatim from the old CLI's format.ts.)
 */
export function compactAt(raw: string | undefined): number {
  const n = Number(raw ?? 0.5);
  return Math.min(0.95, Math.max(0.1, Number.isFinite(n) ? n : 0.5));
}

/** How a compaction summary is presented to the model (system prompt on
 *  resume, replacement user message on a mid-turn fold). */
export function summaryNote(summary: string): string {
  return `Summary of the conversation so far:\n${summary}`;
}

/**
 * Rough token estimate for a wire history: chars/4 over each message's JSON
 * encoding — the same chars/4 convention the CLI uses for its live turn
 * counter. The JSON overhead makes it slightly pessimistic, which is the safe
 * direction: over-estimating triggers a compaction we might not have needed;
 * under-estimating sends a request the provider will reject
 * (ContextWindowExceeded).
 */
export function estimateContextTokens(messages: TranscriptMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.ceil(chars / 4);
}

/** Chars a single tool's input schema serializes to on the wire. MCP tools
 *  carry raw JSON Schema (shipped verbatim); owned tools carry a zod schema the
 *  AI SDK converts to JSON Schema (z.toJSONSchema mirrors that). A schema that
 *  can't be serialized falls back to a conservative fixed size. */
function schemaChars(schema: ToolInputSchema<unknown>): number {
  try {
    const json = isJsonSchemaInput(schema)
      ? schema.jsonSchema
      : z.toJSONSchema(schema as z.ZodType);
    return JSON.stringify(json).length;
  } catch {
    return 256;
  }
}

/**
 * Rough token estimate for the tool schemas that ride on EVERY provider call:
 * for each tool its name, description, and serialized input schema, chars/4.
 * The loop advertises ~58 tools; their combined JSON is tens of thousands of
 * tokens the message-only estimate ignored — enough to push a request that
 * "fits" by message count over the real window. Counting it here keeps the
 * compactor's estimate honest about what actually goes on the wire.
 */
export function estimateToolTokens(tools: HemiTool[]): number {
  if (tools.length === 0) return 0;
  let chars = 0;
  for (const t of tools) {
    // +16 for the JSON scaffolding around each tool ({"name":…,"description":…}).
    chars += t.name.length + t.description.length + schemaChars(t.inputSchema) + 16;
  }
  return Math.ceil(chars / 4);
}

/**
 * The note prepended to the live window when history had to be dropped
 * because even a compacted summary couldn't fit the model's context window.
 */
export const TRUNCATION_NOTE =
  "[Note: earlier conversation history was dropped because it exceeds this " +
  "model's context window and could not be compacted small enough. Run " +
  "/compact for a fresh summary, or switch to a larger-context model to " +
  "recover the full history.]";

export interface CompactorOptions {
  /** MUST be the same store handed to runTurn — compactions are recorded here. */
  transcript: TranscriptStore;
  /** Trigger fraction of the model's context window.
   *  Default: compactAt(process.env.HEMIUNU_COMPACT_THRESHOLD). */
  threshold?: number;
  /** Registry used to resolve the summarizing model (default: loadModelRegistry()). */
  registry?: ModelEntry[];
  /** Test/DI seam: summarize with this model instead of resolving by entry id. */
  resolvedModel?: ResolvedModel;
}

export class Compactor {
  /** The trigger fraction in effect (exposed for UIs/tests). */
  readonly threshold: number;

  constructor(private opts: CompactorOptions) {
    this.threshold = opts.threshold ?? compactAt(process.env.HEMIUNU_COMPACT_THRESHOLD);
  }

  /** Token count at which compaction fires for a model. */
  thresholdTokens(entry: ModelEntry): number {
    return entry.contextWindow * this.threshold;
  }

  /**
   * The loop's `compactionCheck` hook. The last completed step's input-side
   * tokens (input + cacheRead + cacheWrite) ARE the current context size —
   * when they cross the threshold, summarize, record the compaction, and fold
   * the live window in place so the very next model call starts from the
   * summary. Failures are swallowed (context is left as-is; it retries next
   * step), matching the old CLI's silent auto-compaction.
   *
   * BEFORE THE FIRST provider call of a turn no usage exists yet (all zeros).
   * The transcript is provider-neutral, so a history built under a big-window
   * model (a 1M Claude) can be resumed — or mid-conversation switched — onto a
   * smaller-window model (a 262k qwen3-235b): without a pre-call check that
   * request goes out uncompacted and dies with ContextWindowExceeded. So when
   * usage reports nothing we ESTIMATE the loaded context (chars/4 over the
   * live window plus the system prompt) against the CURRENT entry's window and
   * compact first. This also covers a registry entry whose contextWindow
   * shrank between sessions.
   *
   * Last resort: when even the compacted summary can't fit (a tiny window),
   * or compaction failed AND the estimate says the request cannot fit the
   * window at all, the live window is truncated to the newest messages that
   * fit, behind TRUNCATION_NOTE — a degraded-but-honest request instead of a
   * doomed one.
   */
  check: CompactionCheck = async ({ conversationId, messages, entry, usage, system, tools }) => {
    const reported = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const systemTokens = system ? Math.ceil(system.length / 4) : 0;
    const toolTokens = estimateToolTokens(tools ?? []);
    // Everything that rides on every call ON TOP of the live messages.
    const overhead = systemTokens + toolTokens;
    // Reported usage measures only what the LAST provider call carried, so it
    // is stale the instant a tool result is appended after that step. The
    // estimate covers the CURRENT wire — live messages + system prompt + the
    // outgoing tool schemas — and estimateContextTokens is deliberately
    // pessimistic (JSON overhead). Take the max: a large result appended
    // mid-turn forces compaction on the next iteration instead of overflowing,
    // AND a provider that counts more overhead than we do still wins. (Before
    // the first call reported is zero, so the estimate governs — a history
    // carried over from a bigger-window model compacts before it ships.)
    const ctxTokens = Math.max(reported, estimateContextTokens(messages) + overhead);
    if (messages.length === 0 || ctxTokens < this.thresholdTokens(entry)) return;
    const budget = Math.max(1, Math.floor(this.thresholdTokens(entry)) - overhead);
    let outcome: CompactionOutcome;
    try {
      outcome = { summary: await this.summarizeAndRecord(conversationId, messages, entry) };
    } catch {
      // Not folded this step — mid-turn it retries next step. But when the
      // estimator already knows the request can't fit the window AT ALL (even
      // counting the schema + system overhead), sending it is doomed: truncate.
      if (estimateContextTokens(messages) + overhead >= entry.contextWindow) {
        truncateToFit(messages, budget);
      }
      return;
    }
    messages.splice(0, messages.length, { role: "user", content: summaryNote(outcome.summary) });
    // A tiny window can be beaten even by the summary plus overhead — truncate.
    if (estimateContextTokens(messages) + overhead >= entry.contextWindow) {
      truncateToFit(messages, budget);
    }
    return outcome;
  };

  /**
   * Manual entry point (CLI /compact): summarize everything live in the store
   * for this conversation and record the compaction. Throws when there is
   * nothing to compact or the summarization fails — the caller surfaces it.
   */
  async compactNow(conversationId: string, model?: string): Promise<string> {
    const { messages } = this.opts.transcript.load(conversationId);
    if (messages.length === 0) {
      throw new Error("Nothing to compact — the conversation has no live messages.");
    }
    return this.summarizeAndRecord(conversationId, messages, this.entryFor(model));
  }

  /** Registry entry for the summarizing model (default mirrors the loop's). */
  private entryFor(model?: string): ModelEntry {
    if (this.opts.resolvedModel) return this.opts.resolvedModel.entry;
    const registry = this.opts.registry ?? loadModelRegistry();
    if (model) {
      const entry = registry.find((m) => m.id === model);
      if (entry) return entry;
    }
    return modelForTag("synthesis", registry, registry[0].id);
  }

  /**
   * Ask the model for the summary (COMPACT_PROMPT appended as the final user
   * message; a prior summary rides in as a system message so it gets folded
   * in), then persist it: one compactions row covering every live seq, which
   * marks those transcript rows superseded — nothing is ever deleted.
   */
  private async summarizeAndRecord(
    conversationId: string,
    liveMessages: TranscriptMessage[],
    entry: ModelEntry,
  ): Promise<string> {
    const resolved = this.opts.resolvedModel ?? resolveModel(entry.id, this.opts.registry);
    const prior = this.opts.transcript.load(conversationId).summary;
    // Balance the history for the SAME reason the loop does (balanceToolMessages):
    // the summarizing model can be any provider, and a resumed/legacy transcript
    // may carry an orphaned tool output that a strict provider would reject.
    const wire: TranscriptMessage[] = [
      ...(prior ? [{ role: "system", content: summaryNote(prior) } as TranscriptMessage] : []),
      ...balanceToolMessages(liveMessages),
      { role: "user", content: COMPACT_PROMPT },
    ];
    const { text } = await generateText({
      model: resolved.languageModel,
      messages: wire,
      allowSystemInMessages: true,
      providerOptions: resolved.providerOptions as Parameters<
        typeof generateText
      >[0]["providerOptions"],
    });
    const summary = text.trim();
    if (!summary) throw new Error("Compaction produced an empty summary.");
    const coversToSeq = this.opts.transcript.nextSeq(conversationId) - 1;
    this.opts.transcript.recordCompaction(conversationId, summary, coversToSeq);
    return summary;
  }
}

/**
 * Last-resort in-place truncation of the LIVE window (the durable transcript
 * is never touched): keep the newest messages that fit `budgetTokens`, behind
 * TRUNCATION_NOTE. When even the single newest message is over budget, keep
 * the head of its text as a plain user message — the model at least sees what
 * was being asked. Tool pairing doesn't need care here: the loop's
 * balanceToolMessages repairs any orphan the cut produces before the wire.
 */
export function truncateToFit(messages: TranscriptMessage[], budgetTokens: number): void {
  const note: TranscriptMessage = { role: "user", content: TRUNCATION_NOTE };
  const budget = Math.max(0, budgetTokens - estimateContextTokens([note]));
  const kept: TranscriptMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateContextTokens([messages[i]]);
    if (used + t > budget) break;
    kept.unshift(messages[i]);
    used += t;
  }
  if (kept.length === 0 && messages.length > 0) {
    const last = messages[messages.length - 1];
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    kept.push({ role: "user", content: text.slice(0, Math.max(16, budget * 4)) });
  }
  messages.splice(0, messages.length, note, ...kept);
}
