/**
 * Shared eval harness — the small toolkit both the smoke gate (smoke.ts) and the
 * capability suite (capability.ts) build on. Since P6-1c it drives the ENGINE
 * runtime (createEngineRuntime → TurnEvent) instead of the old SDK runtime's
 * StreamMessage loop:
 *   check / assert / report  — pass/fail accounting + exit code
 *   parseEvalArgs / resolveEvalModel — the `--model <registry-id>` flag, so a
 *                              live run can target ANY model registry entry
 *                              (Claude, gpt-4o via LiteLLM, local ollama, …)
 *   collectTurn              — drain a runTurn TurnEvent stream to {text, cost}
 *   collectTurnDetailed      — same, plus the tool calls / subagent tasks / full
 *                              event stream, so a test can assert on WHAT the
 *                              agent did (not just its final words)
 *   scriptedLanguageModel    — an offline scripted model (via the runtime's
 *                              `resolve` seam) so smoke can drive the REAL
 *                              engine loop with zero network calls
 *   judge                    — a fixed-model LLM judge for the few dimensions only
 *                              a human-or-model can score (grayscale, fidelity, …)
 *
 * Kept dependency-light and process-local: each script is its own process, so the
 * pass/fail counters here are per-run.
 */
import type { EngineTurnOptions } from "@hemiunu/agent-core";
import type { ModelEntry, ResolvedModel, StopReason, TurnEvent, TurnUsage } from "@hemiunu/engine";
import { emptyUsage } from "@hemiunu/engine";

let passed = 0;
let failed = 0;

/** Run one named check; record pass/fail and print a colored line. */
export async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${msg}`);
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Print the tally and exit non-zero if anything failed (CI/pre-push gate). */
export function report(): never {
  const total = passed + failed;
  const color = failed === 0 ? "\x1b[32m" : "\x1b[31m";
  console.log(`\n${color}${passed}/${total} checks passed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Current tally (for callers that want to branch before report()). */
export function tally() {
  return { passed, failed };
}

// ---- model selection (--model <registry-id>) --------------------------------

export interface EvalArgs {
  /** The `--model <registry-id>` / `--model=<id>` value, if given. */
  model?: string;
  /** Every other CLI arg, in order (scenario ids, --offline, …). */
  rest: string[];
}

/** Split `--model` (both `--model x` and `--model=x`) out of an argv slice. */
export function parseEvalArgs(argv: string[]): EvalArgs {
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") {
      model = argv[++i];
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else {
      rest.push(a);
    }
  }
  return { model, rest };
}

/**
 * Resolve the eval model: an explicit id (flag or env) must exist in the model
 * registry — fail fast with the known ids instead of erroring mid-run — and an
 * absent one falls back (normally the configured/synthesis-tagged model).
 */
export function resolveEvalModel(
  id: string | undefined,
  registry: ModelEntry[],
  fallback: string,
): string {
  if (!id) return fallback;
  if (!registry.some((m) => m.id === id)) {
    const known = registry.map((m) => m.id).join(", ");
    throw new Error(`Unknown model '${id}'. Known registry ids: ${known}.`);
  }
  return id;
}

// ---- turn collection ---------------------------------------------------------

/** Anything that runs engine turns (an EngineRuntime, or a test seam). */
export interface TurnRunner {
  runTurn(opts: EngineTurnOptions): AsyncGenerator<TurnEvent>;
}

/** Drain a runTurn TurnEvent stream into final text + cost. */
export async function collectTurn(
  rt: TurnRunner,
  opts: EngineTurnOptions,
): Promise<{ text: string; cost: number }> {
  let text = "";
  let cost = 0;
  for await (const e of rt.runTurn(opts)) {
    if (e.type === "turn-finish") {
      text = e.text;
      cost = e.costUsd;
    }
  }
  return { text, cost };
}

export interface TurnDetail {
  /** Final assistant text (the `turn-finish` event). */
  text: string;
  /** Turn cost in USD (0 when the registry entry carries no price table). */
  cost: number;
  /** Cumulative token usage for the turn. */
  usage: TurnUsage;
  /** Why the turn stopped (end / max-steps / aborted / error). */
  stopReason: StopReason;
  /** Every TOP-LEVEL tool the agent invoked (tool-start without a `parent`),
   *  in order, with raw input. */
  toolUses: { name: string; input: Record<string, unknown> }[];
  /** Agent name of each subagent task that ran (task-start events) — covers
   *  both `delegate` and the orchestrator's `parallel` fan-out. */
  delegations: string[];
  /** The FULL TurnEvent stream, for event-level assertions (task lifecycle,
   *  todo snapshots, plan proposals, compaction, permission notes, …). */
  events: TurnEvent[];
  /** Wall-clock duration of the whole turn, in ms. */
  ms: number;
  /** The conversation id (from `turn-start`) — the resume handle. */
  conversationId?: string;
}

/**
 * Drive one turn and capture not just the answer but WHAT the agent did: which
 * tools it called (with inputs), which subagents it delegated to, and the live
 * task events. This is the backbone of the capability suite — most claims are
 * asserted as predicates over `toolUses` / `delegations` / `events`, not text.
 */
export async function collectTurnDetailed(
  rt: TurnRunner,
  opts: EngineTurnOptions,
): Promise<TurnDetail> {
  const toolUses: { name: string; input: Record<string, unknown> }[] = [];
  const delegations: string[] = [];
  const events: TurnEvent[] = [];
  let text = "";
  let cost = 0;
  let usage = emptyUsage();
  let stopReason: StopReason = "end";
  let conversationId: string | undefined;
  const start = Date.now();
  for await (const e of rt.runTurn(opts)) {
    events.push(e);
    switch (e.type) {
      case "turn-start":
        conversationId = e.conversationId;
        break;
      case "tool-start":
        // Only the MAIN turn's calls: nested (subagent) events carry `parent`.
        if (!e.parent) {
          const input =
            typeof e.input === "object" && e.input !== null && !Array.isArray(e.input)
              ? (e.input as Record<string, unknown>)
              : {};
          toolUses.push({ name: e.name, input });
        }
        break;
      case "task-start":
        delegations.push(e.agent);
        break;
      case "turn-finish":
        text = e.text;
        cost = e.costUsd;
        usage = e.usage;
        stopReason = e.stopReason;
        break;
    }
  }
  const detail: TurnDetail = {
    text,
    cost,
    usage,
    stopReason,
    toolUses,
    delegations,
    events,
    ms: Date.now() - start,
    conversationId,
  };
  if (process.env.CAP_DEBUG) {
    console.error(
      `      \x1b[2m[debug] tools=[${toolUses.map((t) => t.name).join(", ")}] ` +
        `delegations=[${delegations.join(", ")}] events=${events.length} ` +
        `text="${text.slice(0, 120).replace(/\n/g, " ")}"\x1b[0m`,
    );
  }
  return detail;
}

/** Did the agent call a tool whose name contains `needle`? */
export function calledTool(d: TurnDetail, needle: string): boolean {
  return d.toolUses.some((t) => t.name.includes(needle));
}

/** Pull the first matching tool call (for inspecting its input). */
export function firstTool(
  d: TurnDetail,
  needle: string,
): { name: string; input: Record<string, unknown> } | undefined {
  return d.toolUses.find((t) => t.name.includes(needle));
}

// ---- scripted offline model ---------------------------------------------------

/** One scripted model round-trip: stream text, or request a tool call. */
export type ScriptedStep = { text: string } | { tool: string; input: unknown; id?: string };

/** Fixed per-step usage, so offline checks can assert exact accumulation. */
export const SCRIPTED_STEP_USAGE = {
  inputTokens: { total: 100, noCache: 90, cacheRead: 10, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
} as const;

/**
 * A hand-rolled AI-SDK language model that plays back `steps` one doStream call
 * at a time (the last step repeats if the loop asks for more). Built without
 * importing `ai` — the engine package owns that dependency — and returned as
 * the ResolvedModel shape the runtime's `resolve` seam expects, so the REAL
 * engine loop (tool dispatch, pipeline, transcript, events) runs offline.
 */
export function scriptedLanguageModel(steps: ScriptedStep[]): ResolvedModel["languageModel"] {
  let call = 0;
  const model = {
    specificationVersion: "v4",
    provider: "scripted",
    modelId: "scripted",
    supportedUrls: Promise.resolve({}),
    async doGenerate(): Promise<never> {
      throw new Error("the scripted eval model only streams");
    },
    async doStream() {
      const n = call++;
      const step = steps[Math.min(n, steps.length - 1)];
      const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
      if ("text" in step) {
        chunks.push(
          { type: "text-start", id: `t${n}` },
          { type: "text-delta", id: `t${n}`, delta: step.text },
          { type: "text-end", id: `t${n}` },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: SCRIPTED_STEP_USAGE,
          },
        );
      } else {
        chunks.push(
          {
            type: "tool-call",
            toolCallId: step.id ?? `call-${n}`,
            toolName: step.tool,
            input: JSON.stringify(step.input ?? {}),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: SCRIPTED_STEP_USAGE,
          },
        );
      }
      return {
        stream: new ReadableStream({
          start(c) {
            for (const chunk of chunks) c.enqueue(chunk);
            c.close();
          },
        }),
      };
    },
  };
  return model as unknown as ResolvedModel["languageModel"];
}

/**
 * A `resolve` seam for createEngineRuntime: every registry id resolves to ONE
 * scripted model instance (its step counter spans turns, so multi-turn checks
 * can script `[turn1, turn2, …]` in order), skipping provider factories/keys.
 */
export function scriptedResolve(
  registry: ModelEntry[],
  steps: ScriptedStep[],
): (id: string) => ResolvedModel {
  const languageModel = scriptedLanguageModel(steps);
  return (id) => ({ entry: registry.find((m) => m.id === id) ?? registry[0], languageModel });
}

// ---- LLM judge -----------------------------------------------------------------

/** Best-effort JSON parse: tolerate ```json fences and surrounding prose. */
function parseJsonLoose<T = unknown>(raw: string): T {
  const fenced = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(fenced) as T;
  } catch {
    const m = fenced.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`judge did not return JSON: ${raw.slice(0, 160)}`);
  }
}

/**
 * A fixed-model LLM judge for the handful of dimensions only a model/human can
 * score (e.g. "is this wireframe grayscale and low-fi?"). Runs a clean turn (no
 * MCP sources), forces JSON-only output, and parses it. Use sparingly — prefer
 * objective programmatic assertions wherever a signal exists.
 */
export async function judge<T = unknown>(
  rt: TurnRunner,
  opts: {
    rubric: string;
    payload: string;
    model: string;
  },
): Promise<T> {
  const systemPrompt =
    "You are a strict, terse evaluation judge. Output ONLY a single minified JSON object matching the schema described in the rubric. No prose, no markdown, no code fences.";
  const prompt = `${opts.rubric}\n\n--- ITEM TO JUDGE ---\n${opts.payload}`;
  const { text } = await collectTurn(rt, {
    prompt,
    model: opts.model,
    systemPrompt,
    mcpServers: {},
  });
  return parseJsonLoose<T>(text);
}
