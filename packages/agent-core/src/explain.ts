import { isTimeoutError } from "./net";

/**
 * Turn a raw error / HTTP failure into ONE plain-language line a non-coder can
 * act on. The audience is a product team, not engineers, so "socket hang up" or
 * "403" becomes "couldn't reach the network" / "reconnect with /github". Covers
 * GitHub calls, LLM-provider API errors (the AI SDK's APICallError shape —
 * Anthropic, OpenAI, a LiteLLM proxy, local Ollama), MCP server failures, and
 * the engine's model-registry resolution errors. Falls back to the raw message
 * when we don't recognise it (better than hiding it).
 */
export function explainError(e: unknown): string {
  if (isTimeoutError(e)) return "the request timed out — check your connection and try again";
  const msg = e instanceof Error ? e.message : String(e);
  const err = (e ?? {}) as {
    code?: string;
    status?: number;
    statusCode?: number; // the AI SDK's APICallError carries statusCode + url + responseBody
    url?: string;
    responseBody?: string;
  };
  const url = typeof err.url === "string" ? err.url : "";
  const body = typeof err.responseBody === "string" ? err.responseBody : "";
  // Everything we can pattern-match on: message, request URL, response body.
  const text = [msg, url, body].filter(Boolean).join(" ");
  const status = err.status ?? err.statusCode ?? statusFromMessage(msg);

  // --- model-registry resolution (engine resolveModel) ------------------------
  // resolveModel's own messages already name the missing key / file — keep
  // them, adding the one action they lack.
  if (/^Unknown model '/.test(msg)) return `${msg} Pick one with /models.`;
  if (/needs [A-Z][A-Z0-9_]* — add it to ~\/\.hemiunu\/\.env/.test(msg)) return msg;
  if (/has no apiKeyEnv|needs a baseURL/.test(msg)) return msg;

  // --- MCP host failures --------------------------------------------------------
  if (/^Unknown MCP server '/.test(msg)) {
    return `${msg.replace(/\.\s*$/, "")} — check the server name in mcp.json`;
  }
  const mcp = /MCP server '([^']+)'/.exec(msg);
  if (mcp) {
    return `the MCP server '${mcp[1]}' couldn't be reached — check its command/URL in mcp.json and reconnect from the MCP panel (it may need /login or a fresh token)`;
  }

  // --- local model server (Ollama) down -----------------------------------------
  if (
    /ECONNREFUSED|connection refused/i.test(`${err.code ?? ""} ${text}`) &&
    /11434|ollama/i.test(text)
  ) {
    return "the local model server (Ollama) isn't running — start it with `ollama serve`, or pick another model with /models";
  }

  // --- GitHub keeps its historical wording ----------------------------------------
  if (/github/i.test(text)) {
    if (status === 401) return "GitHub didn't accept the credentials — reconnect with /github";
    if (status === 403)
      return "access was refused or you've hit GitHub's rate limit — wait a minute, then retry (reconnect with /github if it persists)";
    if (status === 404) return "GitHub couldn't find that repo or file — check the team is correct";
    if (status === 409 || status === 422)
      return "the file changed at the same time — please try again";
    if (status && status >= 500) return "GitHub had a server error — try again in a moment";
  }

  // --- LLM provider API errors (AI SDK APICallError and friends) ------------------
  const provider = providerLabel(text);
  // Context window exceeded — the conversation (or a history carried over from
  // a bigger-window model) no longer fits this model's context. Shapes covered:
  // LiteLLM's ContextWindowExceededError ("The input (973402 tokens) is longer
  // than the model's context length (262144 tokens)"), OpenAI's
  // context_length_exceeded ("This model's maximum context length is …"), and
  // Anthropic's "prompt is too long: N tokens > M maximum" /
  // "input length and `max_tokens` exceed context limit".
  if (
    /ContextWindowExceeded|context_length_exceeded|longer than the model'?s context length|maximum context length|prompt is too long|exceeds? (the )?(model'?s )?context (limit|window)|input length and `?max_tokens`? exceed/i.test(
      text,
    )
  ) {
    return `the conversation has grown past this model's context window, so ${provider} refused the request — run /compact to fold the history into a summary, or switch to a model with a bigger context window via /models`;
  }
  // LiteLLM's team-scoped model gate (e.g. "team_model_access_denied").
  if (/team_model_access_denied|not allowed to access model|model access denied/i.test(text)) {
    return `your ${provider} key's team doesn't have access to this model — pick another with /models, or ask the proxy admin to enable it`;
  }
  if (status === 401) return `${provider} rejected the API key — check the key in ~/.hemiunu/.env`;
  if (status === 403)
    return `${provider} refused access with this key — check the key's permissions in ~/.hemiunu/.env`;
  if (status === 404)
    return `${provider} couldn't find that model or endpoint — check the model id (/models) and the entry's baseURL in ~/.hemiunu/models.json`;
  if (status === 429)
    return `${provider} is rate-limiting or out of quota — wait a moment and retry, or switch models with /models`;
  if ((status && status >= 500) || /overloaded_error/i.test(text))
    return `${provider} had a server error — try again in a moment`;

  // --- plain network failures -------------------------------------------------------
  if (
    err.code === "ENOTFOUND" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ECONNRESET" ||
    /fetch failed|network|getaddrinfo|socket hang up|ECONNREFUSED/i.test(msg)
  )
    return "couldn't reach the network — check your internet connection";
  return msg;
}

/** Name the party that failed, from whatever URL/message text we have. */
function providerLabel(text: string): string {
  if (/litellm/i.test(text)) return "the LiteLLM proxy";
  if (/11434|ollama/i.test(text)) return "Ollama";
  if (/anthropic|claude/i.test(text)) return "Anthropic";
  if (/openai|api\.openai\.com|gpt-/i.test(text)) return "OpenAI";
  if (/gemini|googleapis|generativelanguage/i.test(text)) return "Google";
  return "the model provider";
}

/** Pull a 3-digit HTTP status out of an error message like "GitHub PUT x: 403 …". */
function statusFromMessage(msg: string): number | undefined {
  const m = /\b([45]\d{2})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
}
