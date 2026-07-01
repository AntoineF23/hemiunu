import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createPolicyBlockHook } from "./toolpolicy";
import { activeProtoDir } from "./workspace";

/**
 * Generic tool-output cap, the way Claude Code does it: a PostToolUse hook that
 * fires after a tool runs but BEFORE its result is sent to the model, and
 * replaces oversized results with a truncated version (`updatedToolOutput`).
 * Applies to every tool — filesystem, web search, anything — with no per-tool
 * work. A notice tells the model it was truncated and how to get more, so
 * nothing is silently lost. This keeps fat results (large search dumps, big
 * file reads) from accumulating in the context window.
 */

const CHARS_PER_TOKEN = 4;
/** Default per-result budget in TOKENS before a tool result is capped. With a
 *  1M-token context window the old 6k cap was far too aggressive — it truncated
 *  legitimately useful results. This is now just a backstop against a pathological
 *  dump; MCP results (the important retrievals) are exempt entirely (see below). */
export const DEFAULT_RESULT_BUDGET_TOKENS = 60000;

/** Budget from env (HEMIUNU_TOOL_RESULT_BUDGET, in tokens) or the default. */
export function resultBudgetTokens(): number {
  const n = Number(process.env.HEMIUNU_TOOL_RESULT_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESULT_BUDGET_TOKENS;
}

/** Flatten a tool result of unknown shape (string, content blocks, {content}) to text. */
function textOf(resp: unknown): string {
  if (resp == null) return "";
  if (typeof resp === "string") return resp;
  if (Array.isArray(resp)) return resp.map(textOf).join("");
  if (typeof resp === "object") {
    const o = resp as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if ("content" in o) return textOf(o.content);
    return JSON.stringify(resp);
  }
  return String(resp);
}

/**
 * The full hook set every `query()` should run: the PostToolUse output cap, the
 * PreToolUse user-block enforcement, and the PreToolUse workspace guard. The two
 * PreToolUse hooks are concatenated (a shallow spread would drop one); PostToolUse
 * is its own key. Use this everywhere instead of the bare `createToolCapHook()`
 * so a user's "block" AND the workspace confinement are honored in subagents too.
 */
export function createAgentHooks(
  opts: { budgetTokens?: number; writeScope?: string[] } = {},
): NonNullable<Options["hooks"]> {
  const block = createPolicyBlockHook();
  const guard = createWorkspaceGuardHook();
  const scope =
    opts.writeScope && opts.writeScope.length
      ? createWriteScopeGuardHook(opts.writeScope)
      : undefined;
  return {
    PreToolUse: [
      ...(block.PreToolUse ?? []),
      ...(guard.PreToolUse ?? []),
      ...(scope?.PreToolUse ?? []),
    ],
    ...createToolCapHook(opts.budgetTokens),
  };
}

// Tool-input keys that name a file a tool will WRITE to. External MCP tools
// (e.g. canal-image's download_image `destPath`) resolve these against the
// worker's cwd — the Hemiunu app folder — so a relative path silently writes
// the file INTO the app instead of the prototype. Hemiunu's own prototype tools
// use `path` (resolved against the workspace internally), which is deliberately
// NOT in this list, so they're left untouched.
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
 * A PreToolUse hook that confines every file-writing tool to the active
 * prototype workspace (a ~/.hemiunu/tmp folder) by rewriting its destination
 * path. This guarantees the agent — main loop or any subagent — can never write
 * into the Hemiunu app folder, only into the throwaway prototype workspace it
 * owns. It rewrites the input via `updatedInput` rather than denying, so the
 * tool still runs, just in the right place.
 */
export function createWorkspaceGuardHook(): NonNullable<Options["hooks"]> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input;
            if (!toolInput) return {};
            const dir = activeProtoDir();
            let changed = false;
            const next: Record<string, unknown> = { ...toolInput };
            for (const key of WRITE_DEST_KEYS) {
              const v = next[key];
              if (typeof v !== "string" || !v) continue;
              const confined = confineToDir(dir, v);
              if (confined !== v) {
                next[key] = confined;
                changed = true;
              }
            }
            if (!changed) return {};
            return {
              hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: next },
            };
          },
        ],
      },
    ],
  };
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
 * A PreToolUse hook that confines a SCOPED subagent's file writes to its
 * assigned paths — the enforcement behind parallel component builds, where
 * several designers write ONE prototype at once on a workspace that has no
 * locking. Active only when a write-scope is set (i.e. the coordinator handed
 * this subagent specific files to own); otherwise it never fires.
 *
 * A `write_workspace_file` is ALLOWED when the target is within the assigned
 * scope, OR the file does not exist yet (write-if-absent, so a scoped designer
 * can still lay down brand-new shared/sibling assets a design-system bundle
 * returns). It is DENIED when it would OVERWRITE a file outside the scope —
 * another designer's component, or a shared file (App.tsx / index.css / config)
 * the SETUP role established. Scaffolding tools (save_prototype /
 * iterate_prototype) are denied outright: (re)scaffolding is the SETUP role's
 * job, never a scoped component build's.
 */
export function createWriteScopeGuardHook(scope: string[]): NonNullable<Options["hooks"]> {
  const prefixes = scope.map(normRel).filter(Boolean);
  const inScope = (rel: string) => prefixes.some((pre) => rel === pre || rel.startsWith(pre + "/"));
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const toolName = (input as { tool_name?: string }).tool_name ?? "";
            if (/__(?:save_prototype|iterate_prototype)$/.test(toolName)) {
              return deny(
                "You're a scoped component build — don't (re)scaffold. Scaffolding and the design-system setup are the SETUP role's job; write your assigned file with write_workspace_file.",
              );
            }
            if (!/__write_workspace_file$/.test(toolName)) return {};
            const ti = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
            const p = typeof ti.path === "string" ? ti.path : "";
            if (!p) return {};
            const dir = activeProtoDir();
            const abs = confineToDir(dir, p);
            const rel = normRel(relative(dir, abs));
            if (inScope(rel)) return {};
            // Outside the assigned scope: allow creating a brand-new file
            // (write-if-absent for shared assets), but never overwrite one.
            if (!existsSync(abs)) return {};
            return deny(
              `You may only write ${prefixes.join(", ")} (plus brand-new files). '${rel}' already exists and is outside your scope — don't overwrite a shared or another designer's file (shared assets are write-if-absent; App.tsx/index.css/config belong to the SETUP/WIRE role).`,
            );
          },
        ],
      },
    ],
  };
}

/** Build the PostToolUse cap hook for the SDK `hooks` option. */
export function createToolCapHook(
  budgetTokens: number = resultBudgetTokens(),
): NonNullable<Options["hooks"]> {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  return {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            // Never truncate MCP results. These are the agent's substantive
            // retrievals — design-system context (Figma), source data, file
            // reads — and clipping them is exactly what degrades downstream work
            // (e.g. the designer building from a half-read design system). The
            // backstop below only guards built-in tools against a runaway dump.
            const toolName = (input as { tool_name?: string }).tool_name ?? "";
            if (toolName.startsWith("mcp__")) return {};
            const resp = (input as { tool_response?: unknown }).tool_response;
            const full = textOf(resp);
            if (full.length <= budgetChars) return {};
            const hiddenTok = Math.ceil((full.length - budgetChars) / CHARS_PER_TOKEN);
            const capped = `${full.slice(0, budgetChars)}\n\n[Output truncated to protect the context window — ~${hiddenTok.toLocaleString()} tokens hidden. If you need more, re-query more narrowly: a smaller page_size, a specific id/path, or a tighter search term.]`;
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                updatedToolOutput: capped,
              },
            };
          },
        ],
      },
    ],
  };
}
