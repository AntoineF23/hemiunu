import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { remember } from "@hemiunu/memory";
import { z } from "zod";
import { loadConfig } from "./config";

/** In-process MCP server exposing the `remember` tool to the agent. */
export function createMemoryServer() {
  const rememberTool = tool(
    "remember",
    "Save a durable note for future sessions. Use target 'user' for facts about the user, 'memory' for general product context, workflows, or facts.",
    { target: z.enum(["user", "memory"]), note: z.string() },
    async ({ target, note }) => {
      remember(target, note);
      return {
        content: [{ type: "text", text: `Saved to ${target}.md.` }],
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
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
}

/**
 * One-shot call to any model on the proxy via its OpenAI-format
 * chat-completions endpoint (the reliable path for non-Claude models), using
 * the same bearer key. Returns the model's text, or a human-readable message
 * describing why there was none (HTTP error, empty completion, network).
 */
export async function askModel({
  model,
  prompt,
  system,
  maxTokens = 2000,
}: AskModelOptions): Promise<string> {
  const cfg = loadConfig();
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
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
      return `Error from ${model} (HTTP ${res.status}): ${body.slice(0, 400)}`;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const text = json.choices?.[0]?.message?.content;
    if (!text) {
      const reason = json.choices?.[0]?.finish_reason ?? "unknown";
      return `${model} returned no content (finish_reason: ${reason}). Raise max_tokens or simplify the request.`;
    }
    return text;
  } catch (e) {
    return `Failed to reach ${model}: ${e instanceof Error ? e.message : String(e)}`;
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
    "Ask a non-Claude model (Gemini, GPT, Grok, DeepSeek, Qwen, Mistral, Llama, …) one question through the proxy and get its answer as text. Use for a second opinion, to compare across models, or when another model is stronger for a subtask. You remain the primary agent: call this for a focused subtask, then integrate the result. Pass the exact proxy model id.",
    {
      model: z
        .string()
        .describe("Exact proxy model id, e.g. 'gemini-3.1-pro-preview', 'gpt-5.5', 'grok-4.3', 'deepseek-r1'."),
      prompt: z.string().describe("The full request/question to send to that model."),
      system: z.string().optional().describe("Optional system instruction for that model."),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max output tokens (default 2000; raise for reasoning models, which spend tokens thinking)."),
    },
    async ({ model, prompt, system, max_tokens }) => {
      const text = await askModel({ model, prompt, system, maxTokens: max_tokens });
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
