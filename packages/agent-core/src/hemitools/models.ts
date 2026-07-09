// HemiTool port of the hemiunu-models server (tools.ts createModelsServer).
// Handler unchanged; only the SDK tool() wrapper is replaced.

import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { PROVIDER_NAMES } from "../providers";
import { askModel } from "../tools";
import { defineTool, ok } from "./helpers";

/** `ask_model` — one-shot question to a non-Claude model. Read-only (it calls
 *  out, changes nothing), but gated: it spends the user's other API keys. */
export function createModelsTools(): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-models__ask_model",
      description:
        "Ask a non-Claude model one question and get its answer as text. Use for a second opinion, to compare across models, or when another model is stronger for a subtask. You remain the primary agent: call this for a focused subtask, then integrate the result. Each provider needs its own API key configured by the user; if one is missing the tool says which key to add.",
      inputSchema: z.object({
        provider: z
          .enum(PROVIDER_NAMES as [string, ...string[]])
          .describe(
            "Which provider to use: openai, google, groq, xai, deepseek, mistral, or proxy (the user's own gateway).",
          ),
        model: z
          .string()
          .describe(
            "The provider's exact model id, e.g. 'gpt-5.5' (openai), 'gemini-2.5-flash' (google), 'grok-4.3' (xai).",
          ),
        prompt: z.string().describe("The full request/question to send to that model."),
        system: z.string().optional().describe("Optional system instruction for that model."),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Max output tokens (default 2000; raise for reasoning models, which spend tokens thinking).",
          ),
      }),
      permission: "ask",
      readOnly: true,
      async execute({ provider, model, prompt, system, max_tokens }) {
        return ok(await askModel({ provider, model, prompt, system, maxTokens: max_tokens }));
      },
    }),
  ];
}
