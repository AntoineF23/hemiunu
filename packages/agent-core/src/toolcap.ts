import type { Options } from "@anthropic-ai/claude-agent-sdk";

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
/** Default per-result budget in TOKENS before a tool result is capped. */
export const DEFAULT_RESULT_BUDGET_TOKENS = 6000;

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
