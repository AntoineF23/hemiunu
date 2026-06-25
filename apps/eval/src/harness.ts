/**
 * Shared eval harness — the small toolkit both the smoke gate (smoke.ts) and the
 * capability suite (capability.ts) build on:
 *   check / assert / report  — pass/fail accounting + exit code
 *   collectTurn              — drain a runTurn stream to {text, cost}
 *   collectTurnDetailed      — same, plus the tool calls / delegations / subagent
 *                              events, so a test can assert on WHAT the agent did
 *                              (not just its final words)
 *   judge                    — a fixed-model LLM judge for the few dimensions only
 *                              a human-or-model can score (grayscale, fidelity, …)
 *
 * Kept dependency-light and process-local: each script is its own process, so the
 * pass/fail counters here are per-run.
 */
import { runTurn, type RunTurnOptions, type SubagentEvent } from "@hemiunu/agent-core";

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

/** Drain a runTurn stream into final text + cost. */
export async function collectTurn(
  prompt: string,
  model: string,
): Promise<{ text: string; cost: number }> {
  let text = "";
  let cost = 0;
  for await (const m of runTurn({ prompt, model })) {
    const msg = m as Record<string, any>;
    if (msg.type === "result") {
      if (typeof msg.result === "string") text = msg.result;
      if (typeof msg.total_cost_usd === "number") cost = msg.total_cost_usd;
    }
  }
  return { text, cost };
}

export interface TurnDetail {
  /** Final assistant text (the `result` message). */
  text: string;
  /** Turn cost in USD (0 if the proxy doesn't report it). */
  cost: number;
  /** Every top-level tool the agent invoked, in order, with raw input. */
  toolUses: { name: string; input: Record<string, any> }[];
  /** subagent_type of each delegation (Task/Agent tool) — e.g. "researcher". */
  delegations: string[];
  /** Live subagent events (only the `parallel` orchestrator path emits these). */
  events: SubagentEvent[];
  /** Wall-clock duration of the whole turn, in ms. */
  ms: number;
  /** The SDK session id (from the init message) — for resume-continuity tests. */
  sessionId?: string;
}

/**
 * Drive one turn and capture not just the answer but WHAT the agent did: which
 * tools it called (with inputs), which subagents it delegated to, and the live
 * fan-out events. This is the backbone of the capability suite — most claims are
 * asserted as predicates over `toolUses` / `delegations` / `events`, not text.
 */
export async function collectTurnDetailed(opts: RunTurnOptions): Promise<TurnDetail> {
  const toolUses: { name: string; input: Record<string, any> }[] = [];
  const delegations: string[] = [];
  const events: SubagentEvent[] = [];
  const caller = opts.onSubagentEvent;
  let text = "";
  let cost = 0;
  let sessionId: string | undefined;
  const start = Date.now();
  for await (const m of runTurn({
    ...opts,
    onSubagentEvent: (e) => {
      events.push(e);
      caller?.(e);
    },
  })) {
    const msg = m as Record<string, any>;
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    } else if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") {
          toolUses.push({ name: b.name, input: b.input ?? {} });
          if ((b.name === "Task" || b.name === "Agent") && b.input?.subagent_type) {
            delegations.push(String(b.input.subagent_type));
          }
        }
      }
    } else if (msg.type === "result") {
      if (typeof msg.result === "string") text = msg.result;
      if (typeof msg.total_cost_usd === "number") cost = msg.total_cost_usd;
    }
  }
  const detail = { text, cost, toolUses, delegations, events, ms: Date.now() - start, sessionId };
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
): { name: string; input: Record<string, any> } | undefined {
  return d.toolUses.find((t) => t.name.includes(needle));
}

/** Best-effort JSON parse: tolerate ```json fences and surrounding prose. */
function parseJsonLoose<T = any>(raw: string): T {
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
 * sources), forces JSON-only output, and parses it. Use sparingly — prefer
 * objective programmatic assertions wherever a signal exists.
 */
export async function judge<T = any>(opts: {
  rubric: string;
  payload: string;
  model: string;
}): Promise<T> {
  const systemPrompt =
    "You are a strict, terse evaluation judge. Output ONLY a single minified JSON object matching the schema described in the rubric. No prose, no markdown, no code fences.";
  const prompt = `${opts.rubric}\n\n--- ITEM TO JUDGE ---\n${opts.payload}`;
  let text = "";
  for await (const m of runTurn({ prompt, model: opts.model, systemPrompt })) {
    const msg = m as Record<string, any>;
    if (msg.type === "result" && typeof msg.result === "string") text = msg.result;
  }
  return parseJsonLoose<T>(text);
}
