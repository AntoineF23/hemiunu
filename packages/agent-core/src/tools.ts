import { isTimeoutError, timeoutSignal } from "./net";
import { resolveProvider } from "./providers";

/** Resolved id of the remember tool (server + tool name). */
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
      signal: timeoutSignal(),
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
    if (isTimeoutError(e)) {
      return `${provider}/${model} timed out (no response in time). Try again, or raise HEMIUNU_FETCH_TIMEOUT_MS.`;
    }
    return `Failed to reach ${provider}/${model}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface AskAnthropicOptions {
  /** Claude model id, e.g. "claude-sonnet-4.6". */
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
}

/**
 * One-shot call to Claude via the native Anthropic Messages API, using the SAME
 * key/endpoint as the brain: ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL (defaulting
 * to api.anthropic.com when no gateway is set). Unlike askModel (OpenAI-format,
 * bring-your-own providers), this reaches Claude for EVERY user with a working
 * key — proxy or direct. Returns the text, or { error } explaining why none.
 */
export async function askAnthropic({
  model,
  prompt,
  system,
  maxTokens = 2000,
}: AskAnthropicOptions): Promise<{ text: string } | { error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { error: "No ANTHROPIC_API_KEY configured." };
  const base = (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(
    /\/$/,
    "",
  );
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        // Some gateways authenticate with a bearer token instead; harmless for
        // Anthropic direct (it reads x-api-key). Sending both maximizes reach.
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: timeoutSignal(),
    });
    if (!res.ok) {
      const body = await res.text();
      return { error: `Anthropic ${model} (HTTP ${res.status}): ${body.slice(0, 300)}` };
    }
    const json = (await res.json()) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    if (!text)
      return {
        error: `Anthropic ${model} returned no text (stop_reason: ${json.stop_reason ?? "unknown"}).`,
      };
    return { text };
  } catch (e) {
    if (isTimeoutError(e)) {
      return {
        error: `Anthropic ${model} timed out (no response in time). Try again, or raise HEMIUNU_FETCH_TIMEOUT_MS.`,
      };
    }
    return {
      error: `Failed to reach Anthropic ${model}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Generate a short conversation title from the user's first message, with a
 * small/cheap model (Haiku via HEMIUNU_TITLE_MODEL, else the retrieval tier).
 * Goes through askAnthropic (raw Messages API → no SDK `effort` param, so Haiku
 * works even on a proxy). Returns null on any failure so the caller keeps its
 * fallback. The result is cleaned to a short, quote-free, single-line title.
 */
export async function generateTitle(firstMessage: string): Promise<string | null> {
  const prompt = firstMessage.trim().slice(0, 2000);
  if (!prompt) return null;
  const model =
    process.env.HEMIUNU_TITLE_MODEL?.trim() ||
    process.env.HEMIUNU_MODEL_RESEARCH?.trim() ||
    "claude-sonnet-4.6";
  const system =
    "Write a 3–6 word title summarizing the user's message, in Title Case. " +
    "No surrounding quotes, no trailing punctuation, no preamble. Reply with ONLY the title.";
  const res = await askAnthropic({ model, prompt, system, maxTokens: 24 });
  if ("error" in res) return null;
  const title = res.text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim();
  return title || null;
}

/** Resolved id of the ask_model tool (server + tool name). */
export const ASK_MODEL_TOOL_ID = "mcp__hemiunu-models__ask_model";
