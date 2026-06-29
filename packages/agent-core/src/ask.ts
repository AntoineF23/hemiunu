import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { requestControl } from "./control";

/**
 * The `ask_user` tool — the agent's only way to ask the user a structured,
 * multiple-choice question and block until they answer. The SDK's built-in
 * `AskUserQuestion` is unreachable through the high-level `query()` API (it's
 * answered via a low-level dialog control request), so we provide our own over
 * the agent→front-end control bridge (see control.ts): the tool emits an
 * `ask-user` event, the CLI/web render a chooser, and the chosen answer comes
 * back as the tool result.
 *
 * Use sparingly — only when genuinely blocked on a user DECISION; otherwise make
 * a reasonable assumption and note it (see the persona).
 */
export function createAskServer() {
  const askTool = tool(
    "ask_user",
    "Ask the user 1–4 multiple-choice questions and wait for their answer before continuing. Use ONLY when you genuinely need the user to decide between options (design direction, scope, an ambiguous request) — not for things you can reasonably assume. Each question has a short `header` (a chip label), the `question` text (end with a question mark), and 2–4 `options`, each a concise `label` plus a one-line `description` of its trade-off. Returns the user's selection(s).",
    {
      questions: z
        .array(
          z.object({
            question: z.string().describe("The full question, ending in a question mark."),
            header: z.string().describe("Very short chip label, e.g. 'Approach' or 'Scope'."),
            options: z
              .array(
                z.object({
                  label: z.string().describe("Concise choice text (1–5 words)."),
                  description: z
                    .string()
                    .optional()
                    .describe("One line on what this choice means / its trade-off."),
                }),
              )
              .min(2)
              .max(4)
              .describe("2–4 mutually-exclusive choices."),
          }),
        )
        .min(1)
        .max(4)
        .describe("1–4 questions to ask."),
    },
    async ({ questions }) => ({
      content: [{ type: "text", text: await requestControl({ type: "ask-user", questions }) }],
    }),
    { annotations: { title: "Ask the user", readOnlyHint: true } },
  );

  return createSdkMcpServer({ name: "hemiunu-ask", version: "0.0.0", tools: [askTool] });
}

/** Tool-availability wildcard for the ask server. */
export const ASK_TOOLS = "mcp__hemiunu-ask__*";
/** Resolved id of the ask_user tool — auto-approved by the front-ends (asking
 *  the user is the whole point; it must never sit behind a "may I ask?" prompt). */
export const ASK_USER_TOOL_ID = "mcp__hemiunu-ask__ask_user";
