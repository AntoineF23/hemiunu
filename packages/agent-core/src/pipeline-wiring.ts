// Wires Hemiunu's policies into the engine's permission pipeline: the
// persistent toolpolicy store, the workspace-confinement guard, the parallel
// write-scope guard, and the seen-tool bookkeeping. This is the PipelineConfig
// the front-ends (and subagent runs) hand to createPipeline() — the engine
// stays dependency-free while all Hemiunu-specific behavior lives here.
//
// The guard logic is ported VERBATIM from the SDK-era hooks in toolcap.ts
// (createWorkspaceGuardHook / createWriteScopeGuardHook) — same keys, same
// confinement rules, same messages — so behavior is bit-for-bit compatible.

import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { CanUseToolResult, HemiTool, PipelineConfig, ToolContext } from "@hemiunu/engine";
import { resultBudgetTokens } from "./toolcap";
import { loadToolPolicy, recordSeenTool, resolveToolPolicy } from "./toolpolicy";
import { activeProtoDir } from "./workspace";
import { withWorkspace } from "./workspace-context";

// Tool-input keys that name a file a tool will WRITE to. External MCP tools
// (e.g. canal-image's download_image `destPath`) resolve these against the
// worker's cwd — the Hemiunu app folder — so a relative path silently writes
// the file INTO the app instead of the prototype. Hemiunu's own prototype tools
// use `path` (resolved against the workspace internally), which is deliberately
// NOT in this list, so they're left untouched. A tool may override the list by
// declaring `writeDestKeys` on its HemiTool.
const WRITE_DEST_KEYS = ["destPath", "dest", "outputPath", "outPath", "savePath"];

/** Resolve `p` to an absolute path INSIDE `dir`. A relative path keeps its
 *  subpath under the workspace (so `public/x.png` → `<workspace>/public/x.png`);
 *  an absolute path already inside is kept; anything else is pulled in by name. */
function confineToDir(dir: string, p: string): string {
  const abs = isAbsolute(p) ? p : join(dir, p);
  const rel = relative(dir, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return inside ? abs : join(dir, basename(p));
}

/**
 * The workspace guard (pipeline `confineWrites`): confines every file-writing
 * tool to the active prototype workspace by rewriting its destination path —
 * the tool still runs, just in the right place. Exported for tests.
 */
export function confineWriteDestinations(
  tool: HemiTool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const keys = tool.writeDestKeys?.length ? tool.writeDestKeys : WRITE_DEST_KEYS;
  const dir = activeProtoDir();
  let changed = false;
  const next: Record<string, unknown> = { ...input };
  for (const key of keys) {
    const v = next[key];
    if (typeof v !== "string" || !v) continue;
    const confined = confineToDir(dir, v);
    if (confined !== v) {
      next[key] = confined;
      changed = true;
    }
  }
  return changed ? next : input;
}

/** Normalise a workspace-relative path for comparison: strip a leading `./` or
 *  `/`, drop a trailing slash, and use forward slashes. */
function normRel(p: string): string {
  return p
    .split(sep)
    .join("/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

/**
 * The write-scope guard (pipeline `checkWriteScope`) for a SCOPED subagent —
 * the enforcement behind parallel component builds, where several designers
 * write ONE prototype at once on a workspace that has no locking. A
 * `write_workspace_file` is ALLOWED when the target is within the assigned
 * scope, OR the file does not exist yet (write-if-absent). It is DENIED when
 * it would OVERWRITE a file outside the scope. Scaffolding tools
 * (save_prototype / iterate_prototype) are denied outright. Returns the denial
 * message, or undefined to allow. Exported for tests.
 */
export function createWriteScopeCheck(
  scope: string[],
): (tool: HemiTool, input: Record<string, unknown>) => string | undefined {
  const prefixes = scope.map(normRel).filter(Boolean);
  const inScope = (rel: string) => prefixes.some((pre) => rel === pre || rel.startsWith(pre + "/"));
  return (tool, input) => {
    if (/__(?:save_prototype|iterate_prototype)$/.test(tool.name)) {
      return "You're a scoped component build — don't (re)scaffold. Scaffolding and the design-system setup are the SETUP role's job; write your assigned file with write_workspace_file.";
    }
    if (!/__write_workspace_file$/.test(tool.name)) return undefined;
    const p = typeof input.path === "string" ? input.path : "";
    if (!p) return undefined;
    const dir = activeProtoDir();
    const abs = confineToDir(dir, p);
    const rel = normRel(relative(dir, abs));
    if (inScope(rel)) return undefined;
    // Outside the assigned scope: allow creating a brand-new file
    // (write-if-absent for shared assets), but never overwrite one.
    if (!existsSync(abs)) return undefined;
    return `You may only write ${prefixes.join(", ")} (plus brand-new files). '${rel}' already exists and is outside your scope — don't overwrite a shared or another designer's file (shared assets are write-if-absent; App.tsx/index.css/config belong to the SETUP/WIRE role).`;
  };
}

export interface HemiPipelineOptions {
  tools: HemiTool[];
  /** Interactive permission gate; omit for non-interactive/eval/subagent runs. */
  canUseTool?: (name: string, input: unknown) => Promise<CanUseToolResult>;
  /** Session "always allow" set (persisted "always" answers go to toolpolicy). */
  alwaysAllow?: Set<string>;
  /** Auto-accept mode: every gated tool passes without a prompt. */
  autoAccept?: boolean;
  /** Assigned write scope for a parallel (scoped) subagent run. */
  writeScope?: string[];
  /** Per-result truncation budget in tokens (default: resultBudgetTokens()). */
  budgetTokens?: number;
  /** The run model's context window — the hard per-result ceiling is derived
   *  from it (a single result may not exceed HARD_RESULT_CAP_FRACTION of the
   *  window), so even a truncation-exempt MCP result can't overflow alone. */
  contextWindow?: number;
  /** toolpolicy root override (tests). */
  policyRoot?: string;
}

/** A single tool result may occupy at most this fraction of the model's
 *  context window, leaving room for the system prompt, tool schemas, and the
 *  rest of the conversation. Applies even to truncation-exempt MCP results. */
export const HARD_RESULT_CAP_FRACTION = 0.5;

/**
 * Build the full PipelineConfig for a Hemiunu run. Because the policy callback
 * is part of the pipeline itself (not a front-end canUseTool), a user's "block"
 * is enforced in EVERY run — main agent and auto-approving subagents alike
 * (what the SDK era needed a separate PreToolUse hook for).
 */
export function createHemiPipelineConfig(opts: HemiPipelineOptions): PipelineConfig {
  return {
    tools: opts.tools,
    // Read fresh on every call so a policy change mid-conversation applies to
    // the very next tool call.
    policy: (toolName) => resolveToolPolicy(toolName, loadToolPolicy(opts.policyRoot)),
    canUseTool: opts.canUseTool,
    alwaysAllow: opts.alwaysAllow,
    autoAccept: opts.autoAccept,
    confineWrites: confineWriteDestinations,
    checkWriteScope: opts.writeScope?.length ? createWriteScopeCheck(opts.writeScope) : undefined,
    resultBudgetTokens: opts.budgetTokens ?? resultBudgetTokens(),
    // Never truncate MCP results at the normal budget — they are the agent's
    // substantive retrievals (design-system context, source data); the budget
    // only backstops built-ins.
    exemptFromTruncation: (toolName) => toolName.startsWith("mcp__"),
    // …but still cap any single result to a fraction of the window, so an
    // exempt retrieval can never overflow the context on its own.
    hardResultCapTokens: opts.contextWindow
      ? Math.floor(opts.contextWindow * HARD_RESULT_CAP_FRACTION)
      : undefined,
    onExecuted: (toolName) => recordSeenTool(toolName, opts.policyRoot),
    // Execute handlers inside the turn's workspace binding so activeProtoDir()
    // et al. resolve against THIS conversation's repo/local session.
    runInWorkspace: (ctx: ToolContext, fn) => {
      const ws = ctx.workspace;
      if (!ws) return fn();
      return withWorkspace({ repo: ws.repo || null, localSessionId: ws.localSessionId }, fn);
    },
  };
}
