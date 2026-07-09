// The permission pipeline: a configurable middleware chain around tool
// execution, replacing the SDK's hooks + canUseTool plumbing. Everything
// Hemiunu-specific (the persistent tool policy, workspace confinement, the
// interactive permission prompt, seen-tool bookkeeping) is INJECTED via
// PipelineConfig — the engine stays dependency-free of agent-core.

import type { ToolOutput, TurnEvent } from "./events";
import { validateToolInput, type HemiTool, type ToolContext } from "./tool";
import type { ToolCall, ToolExecutor } from "./executor";

/** Persistent per-tool policy verdict (the toolpolicy store's values). */
export type PolicyDecision = "allow" | "ask" | "block";

/** What the interactive gate answers (same shape as the SDK's canUseTool). */
export type CanUseToolResult =
  { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string };

export interface PipelineConfig {
  tools: HemiTool[];
  /** Persistent per-tool policy (toolpolicy store). Default "ask". */
  policy?: (toolName: string) => PolicyDecision;
  /** Interactive gate — parks on the UI. Omit = auto-approve (non-interactive/eval). */
  canUseTool?: (name: string, input: unknown) => Promise<CanUseToolResult>;
  /** Session "always allow" set, checked before canUseTool; "always" answers
   *  are recorded by the CALLER into policy/set. */
  alwaysAllow?: Set<string>;
  /** Auto-accept mode: every gated tool passes without a prompt. */
  autoAccept?: boolean;
  /** Rewrites write-destination inputs (workspace confinement). Return the
   *  (possibly) fixed input. */
  confineWrites?: (tool: HemiTool, input: Record<string, unknown>) => Record<string, unknown>;
  /** Write-scope guard for parallel fan-out (deny out-of-scope writes).
   *  Return an error string to deny. */
  checkWriteScope?: (tool: HemiTool, input: Record<string, unknown>) => string | undefined;
  /** Token budget for result truncation; names matching exempt() skip it. */
  resultBudgetTokens?: number;
  exemptFromTruncation?: (toolName: string) => boolean;
  /** Hard ceiling (tokens) applied to EVERY result — including exempt ones.
   *  Exemption means "skip the normal budget", not "unbounded": a single tool
   *  result that alone would blow the context window is capped here so it can
   *  never overflow on its own. Well above resultBudgetTokens; omit to disable. */
  hardResultCapTokens?: number;
  /** Bookkeeping after execution (recordSeenTool). */
  onExecuted?: (toolName: string) => void;
  /** Wraps the handler execution — agent-core injects withWorkspace() here so
   *  the turn's workspace binding (AsyncLocalStorage) covers every handler. */
  runInWorkspace?: <T>(ctx: ToolContext, fn: () => Promise<T>) => Promise<T>;
}

/** Max self-repair round-trips for one tool's malformed arguments. After this
 *  many invalid attempts the error stops inviting a retry. */
export const MAX_SELF_REPAIR_ATTEMPTS = 3;

/** Same rough estimate the SDK-hook cap used: ~4 chars per token. */
const CHARS_PER_TOKEN = 4;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorOutput(content: string): ToolOutput {
  return { content, isError: true };
}

// --- weak-model repair ladder -----------------------------------------------
// Weak models mangle tool calls in predictable ways: invented-but-close tool
// names, arguments double-encoded as a JSON string, required fields left
// empty. Each rung either repairs the call transparently or returns a
// targeted self-repair error the model can act on — all under the same
// MAX_SELF_REPAIR_ATTEMPTS cap as malformed-args repair.

/** Case/punctuation-insensitive canonical form for tool-name matching. */
function canonicalName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Levenshtein edit distance — tool names only, so the O(n·m) matrix is fine. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(
        prev[j] + 1, // deletion
        row[j - 1] + 1, // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
    }
    prev = row;
  }
  return prev[n];
}

export interface ToolNameMatch {
  tool: HemiTool;
  /** Safe to auto-correct: the name differs only in case/punctuation, or it is
   *  the unambiguous bare name of exactly one namespaced (mcp__…) tool. */
  confident: boolean;
}

/**
 * Fuzzy-match a tool name the model invented against the real tool set.
 * Confident matches (case/punctuation drift, or a bare MCP tool name that
 * belongs to exactly one server) can be corrected in place; near-misses
 * (edit distance within a small budget) are only SUGGESTED back to the model.
 */
export function matchToolName(name: string, tools: HemiTool[]): ToolNameMatch | undefined {
  const canon = canonicalName(name);
  if (!canon) return undefined;

  const exact = tools.filter((t) => canonicalName(t.name) === canon);
  if (exact.length === 1) return { tool: exact[0], confident: true };
  if (exact.length > 1) return { tool: exact[0], confident: false };

  // "search" for mcp__acme__search: models often drop the namespace prefix.
  const bare = tools.filter((t) => {
    const parts = t.name.split("__");
    return parts.length > 1 && canonicalName(parts[parts.length - 1]) === canon;
  });
  if (bare.length === 1) return { tool: bare[0], confident: true };
  if (bare.length > 1) return { tool: bare[0], confident: false };

  // Nearest neighbour by edit distance, within a budget that scales with length.
  let best: HemiTool | undefined;
  let bestD = Infinity;
  for (const t of tools) {
    const d = editDistance(canon, canonicalName(t.name));
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const budget = Math.max(2, Math.floor(canon.length / 4));
  return best && bestD <= budget ? { tool: best, confident: false } : undefined;
}

/** Rung 2: arguments double-encoded as a JSON string → parse them back into
 *  the object the model meant. Anything that isn't a stringified object is
 *  returned untouched (validation produces the targeted error instead). */
function decodeStringInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const s = input.trim();
  if (!s.startsWith("{")) return input;
  try {
    const parsed: unknown = JSON.parse(s);
    return isRecord(parsed) ? parsed : input;
  } catch {
    return input;
  }
}

/**
 * Cap an oversized tool result to the token budget: keep the head, append a
 * truncation notice telling the model how to get more. Mirrors the SDK-era
 * PostToolUse cap (toolcap.ts createToolCapHook) exactly.
 */
function truncateToBudget(output: ToolOutput, budgetTokens: number): ToolOutput {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  if (output.content.length <= budgetChars) return output;
  const hiddenTok = Math.ceil((output.content.length - budgetChars) / CHARS_PER_TOKEN);
  return {
    ...output,
    content: `${output.content.slice(0, budgetChars)}\n\n[Output truncated to protect the context window — ~${hiddenTok.toLocaleString()} tokens hidden. If you need more, re-query more narrowly: a smaller page_size, a specific id/path, or a tighter search term.]`,
  };
}

/**
 * Build the tool executor that runs every call through the permission chain:
 *
 *   1. persistent policy "block" → refused, never executes (even auto-accept)
 *   2. tools marked `permission: "auto"` skip the interactive gate
 *   3. confineWrites rewrites write-destination inputs (workspace confinement)
 *   4. checkWriteScope denies out-of-scope writes (parallel fan-out guard)
 *   5. the gate: policy "allow" / alwaysAllow / autoAccept pass; else park on
 *      canUseTool (prompts are serialized so parallel calls ask one at a time)
 *   6. zod-validate the input (invalid → a self-repair error result the model
 *      can act on; capped at MAX_SELF_REPAIR_ATTEMPTS per tool)
 *   7. execute the handler inside runInWorkspace (throws become error results)
 *   8. truncate oversized results to the token budget (exempt names skip)
 *   9. onExecuted bookkeeping
 *
 * Every allow emits a `permission-note` event saying who decided: "auto" (the
 * tool or auto-accept), "policy" (persistent allow / session always-allow), or
 * "user" (an interactive approval).
 */
export function createPipeline(config: PipelineConfig): ToolExecutor {
  const byName = new Map(config.tools.map((t) => [t.name, t]));

  // Self-repair accounting. The model re-emits a corrected call with a NEW call
  // id, so the cap is tracked per tool NAME for the pipeline's lifetime (one
  // turn). A successful validation resets the count — only a stuck loop of
  // consecutive malformed calls hits the cap.
  const repairAttempts = new Map<string, number>();
  // Rung-1 bookkeeping: each misspelled name is silently corrected at most
  // ONCE per turn — a model that keeps misnaming gets the corrective error
  // (with the real name) so it learns instead of leaning on the crutch.
  const correctedNames = new Set<string>();

  /** One self-repair error under the shared cap: invite a retry until the
   *  per-name attempt budget is spent, then tell the model to stop. */
  const repairError = (key: string, problem: string, fix: string): ToolOutput => {
    const attempt = (repairAttempts.get(key) ?? 0) + 1;
    repairAttempts.set(key, attempt);
    if (attempt >= MAX_SELF_REPAIR_ATTEMPTS) {
      return errorOutput(
        `${problem} Self-repair limit reached (${MAX_SELF_REPAIR_ATTEMPTS} malformed attempts) — do NOT retry this tool call; continue without it.`,
      );
    }
    return errorOutput(`${problem} ${fix} (attempt ${attempt} of ${MAX_SELF_REPAIR_ATTEMPTS}).`);
  };

  // Serializes interactive prompts: each new ask waits for the previous one,
  // so two concurrent tool calls never show two permission menus at once. A
  // deny (or a gate throw) must not wedge the chain — swallow it here; the
  // caller still sees its own rejection.
  let promptChain: Promise<unknown> = Promise.resolve();
  const askUser = (name: string, input: unknown): Promise<CanUseToolResult> => {
    const gate = config.canUseTool;
    // No interactive gate wired (non-interactive/eval runs) → auto-approve.
    if (!gate) return Promise.resolve({ behavior: "allow" });
    const turn = promptChain.then(() => gate(name, input));
    promptChain = turn.catch(() => undefined);
    return turn;
  };

  return {
    async execute(call: ToolCall, ctx: ToolContext): Promise<ToolOutput> {
      // 0. Repair-ladder rung 1: resolve the tool, fuzzy-matching a name the
      // model invented. A confident match (case/punctuation drift, unique bare
      // MCP name) is corrected in place — once per misspelling; a near-miss
      // becomes a self-repair error suggesting the real name.
      let tool = byName.get(call.name);
      if (!tool) {
        const match = matchToolName(call.name, config.tools);
        if (match?.confident && !correctedNames.has(call.name)) {
          correctedNames.add(call.name);
          tool = match.tool;
        } else {
          const hint = match
            ? ` Did you mean '${match.tool.name}'? Re-emit the call with that exact name`
            : ` Re-emit the call with one of the tool names you were given`;
          return repairError(call.name, `Unknown tool: ${call.name}.`, hint.trim());
        }
      }

      const note = (decision: "auto" | "policy" | "user"): TurnEvent => ({
        type: "permission-note",
        id: call.id,
        name: tool.name,
        decision,
      });

      // 1. A user "block" wins over everything — even auto-approve runs.
      // Checked on the REAL tool name, so a rung-1 correction can't dodge it.
      const policy = config.policy?.(tool.name) ?? "ask";
      if (policy === "block") return errorOutput(`Blocked by your tool policy: ${tool.name}`);

      // Repair-ladder rung 2: arguments double-encoded as a JSON string are
      // parsed back into the object the model meant (before confinement, so
      // the guards see the real shape).
      let input = decodeStringInput(call.input);

      // 3. Workspace confinement: rewrite write destinations, never deny.
      if (config.confineWrites && isRecord(input)) input = config.confineWrites(tool, input);

      // 4. Write-scope guard (parallel fan-out): deny out-of-scope writes.
      if (config.checkWriteScope && isRecord(input)) {
        const denied = config.checkWriteScope(tool, input);
        if (denied) return errorOutput(denied);
      }

      // 2 + 5. The permission gate.
      if (tool.permission === "auto") {
        ctx.emit(note("auto"));
      } else if (policy === "allow" || config.alwaysAllow?.has(tool.name)) {
        ctx.emit(note("policy"));
      } else if (config.autoAccept || !config.canUseTool) {
        ctx.emit(note("auto"));
      } else {
        const answer = await askUser(tool.name, input);
        if (answer.behavior === "deny") return errorOutput(answer.message);
        if (answer.updatedInput !== undefined) input = answer.updatedInput;
        ctx.emit(note("user"));
      }

      // 6. Validate — an invalid call becomes a self-repair error result so the
      // model retries with corrected JSON, capped so a stuck loop can't spin.
      // validateToolInput handles both schema variants (zod / raw JSON Schema)
      // and treats empty required fields as missing (repair-ladder rung 3).
      const parsed = validateToolInput(tool.inputSchema, input);
      if (!parsed.ok) {
        // A string that rung 2 could not decode gets the targeted explanation
        // instead of a generic type error.
        const issues =
          typeof input === "string"
            ? `the arguments arrived as a plain string, not a JSON object of arguments`
            : parsed.issues;
        return repairError(
          tool.name,
          `Invalid arguments for ${tool.name}: ${issues}.`,
          "Re-emit the call with corrected JSON",
        );
      }
      repairAttempts.delete(tool.name);

      // 7. Execute (inside the injected workspace binding, so the handler and
      // everything it awaits resolve paths against THIS turn's workspace); a
      // throwing handler becomes an error result, not a crash. The tool sees
      // its own call id, so a delegating tool can stamp subagent events with
      // `parent` = this call's id.
      let output: ToolOutput;
      try {
        const toolCtx: ToolContext = { ...ctx, toolCallId: call.id };
        const run = () => tool.execute(parsed.data, toolCtx);
        output = await (config.runInWorkspace ? config.runInWorkspace(toolCtx, run) : run());
      } catch (e) {
        output = errorOutput(e instanceof Error ? e.message : String(e));
      }

      // 8. Cap oversized results (exempt names — e.g. MCP retrievals — skip
      // the normal budget). The hard ceiling still applies to EVERY result:
      // exemption must not let a single retrieval alone blow the window.
      const budget = config.resultBudgetTokens;
      if (budget && budget > 0 && !config.exemptFromTruncation?.(tool.name)) {
        output = truncateToBudget(output, budget);
      }
      const hardCap = config.hardResultCapTokens;
      if (hardCap && hardCap > 0) {
        output = truncateToBudget(output, hardCap);
      }

      // 9. Bookkeeping (recordSeenTool).
      config.onExecuted?.(tool.name);
      return output;
    },
  };
}
