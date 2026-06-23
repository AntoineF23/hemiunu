import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { remember } from "@hemiunu/memory";
import { z } from "zod";
import { configDir } from "./config";
import { PROVIDER_NAMES, resolveProvider } from "./providers";

/**
 * In-process MCP server exposing the `remember` tool — for GLOBAL facts about
 * the USER only (role, team, stable preferences). Always written to user.md in
 * the agent's core (~/.hemiunu), shared across every project, NEVER the launch
 * folder. Facts about the current feature/project/product do NOT belong here —
 * those go to the team's PROTOTYPE.md via add_prototype_note.
 */
export function createMemoryServer(userRoot: string = configDir()) {
  const rememberTool = tool(
    "remember",
    "Save a durable fact about the USER (their role, team, stable preferences) — global, kept across ALL their projects. Do NOT use this for facts about the current feature/project/product (target users, decisions, research findings) — use add_prototype_note for those, so they stay with the right feature.",
    { note: z.string() },
    async ({ note }) => {
      remember(note, userRoot);
      return {
        content: [{ type: "text", text: "Saved to your global user memory." }],
      };
    },
    { annotations: { title: "Remember", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-memory",
    version: "0.0.0",
    tools: [rememberTool],
  });
}

/** Tool id the SDK exposes for the remember tool (server + tool name). */
export const REMEMBER_TOOL_ID = "mcp__hemiunu-memory__remember";

export interface AskModelOptions {
  /** Provider name (openai, google, groq, xai, deepseek, mistral, or proxy). */
  provider: string;
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
}

/**
 * One-shot call to a model on a bring-your-own provider via its OpenAI-format
 * chat-completions endpoint. The user supplies each provider's key in
 * ~/.hemiunu/.env. Returns the model's text, or a human-readable message saying
 * why there was none (missing key, HTTP error, empty completion, network).
 */
export async function askModel({
  provider,
  model,
  prompt,
  system,
  maxTokens = 2000,
}: AskModelOptions): Promise<string> {
  const resolved = resolveProvider(provider);
  if ("error" in resolved) return resolved.error;
  try {
    const res = await fetch(resolved.chatUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return `Error from ${provider}/${model} (HTTP ${res.status}): ${body.slice(0, 400)}`;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const text = json.choices?.[0]?.message?.content;
    if (!text) {
      const reason = json.choices?.[0]?.finish_reason ?? "unknown";
      return `${provider}/${model} returned no content (finish_reason: ${reason}). Raise max_tokens or simplify the request.`;
    }
    return text;
  } catch (e) {
    return `Failed to reach ${provider}/${model}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * In-process MCP server exposing `ask_model` — a one-shot call to any (esp.
 * non-Claude) model on the proxy. The Claude main loop stays the brain; it
 * calls this for a focused subtask, then integrates the result.
 */
export function createModelsServer() {
  const askModelTool = tool(
    "ask_model",
    "Ask a non-Claude model one question and get its answer as text. Use for a second opinion, to compare across models, or when another model is stronger for a subtask. You remain the primary agent: call this for a focused subtask, then integrate the result. Each provider needs its own API key configured by the user; if one is missing the tool says which key to add.",
    {
      provider: z
        .enum(PROVIDER_NAMES as [string, ...string[]])
        .describe("Which provider to use: openai, google, groq, xai, deepseek, mistral, or proxy (the user's own gateway)."),
      model: z
        .string()
        .describe("The provider's exact model id, e.g. 'gpt-5.5' (openai), 'gemini-2.5-flash' (google), 'grok-4.3' (xai)."),
      prompt: z.string().describe("The full request/question to send to that model."),
      system: z.string().optional().describe("Optional system instruction for that model."),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max output tokens (default 2000; raise for reasoning models, which spend tokens thinking)."),
    },
    async ({ provider, model, prompt, system, max_tokens }) => {
      const text = await askModel({ provider, model, prompt, system, maxTokens: max_tokens });
      return { content: [{ type: "text", text }] };
    },
    { annotations: { title: "Ask model", readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "hemiunu-models",
    version: "0.0.0",
    tools: [askModelTool],
  });
}

/** Tool id the SDK exposes for the ask_model tool (server + tool name). */
export const ASK_MODEL_TOOL_ID = "mcp__hemiunu-models__ask_model";
