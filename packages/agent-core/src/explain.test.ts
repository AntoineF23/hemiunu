import assert from "node:assert/strict";
import { test } from "node:test";
import { explainError } from "./explain";

test("explainError: 401 → reconnect hint", () => {
  const e = Object.assign(new Error("GitHub PUT x: 401"), { status: 401 });
  assert.match(explainError(e), /reconnect/i);
});

test("explainError: status parsed from the message when not on the object", () => {
  assert.match(explainError(new Error("GitHub GET PROTOTYPE.md: 404 Not Found")), /couldn't find/i);
});

test("explainError: network failures map to a connection hint", () => {
  const e = Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
  assert.match(explainError(e), /network|connection/i);
});

test("explainError: unrecognised errors fall through to their message", () => {
  assert.equal(explainError(new Error("some unexpected thing")), "some unexpected thing");
});

// --- LLM provider API errors (the AI SDK APICallError shape) ---------------------

test("explainError: provider 401 names the provider and the key location", () => {
  const e = Object.assign(new Error("Unauthorized"), {
    statusCode: 401,
    url: "https://litellm.example.com/v1/chat/completions",
  });
  const out = explainError(e);
  assert.match(out, /LiteLLM proxy/);
  assert.match(out, /API key/);
  assert.match(out, /~\/.hemiunu\/.env/);
});

test("explainError: LiteLLM team_model_access_denied maps to the model-access hint", () => {
  const e = Object.assign(new Error("Forbidden"), {
    statusCode: 403,
    url: "https://litellm.example.com/v1/chat/completions",
    responseBody:
      '{"error":{"message":"team_model_access_denied: Team not allowed to access model gpt-4o","code":"403"}}',
  });
  const out = explainError(e);
  assert.match(out, /doesn't have access to this model/);
  assert.match(out, /\/models|proxy admin/);
});

test("explainError: provider 404 points at the model id and baseURL", () => {
  const e = Object.assign(new Error("Not Found"), {
    statusCode: 404,
    url: "https://api.openai.com/v1/chat/completions",
  });
  const out = explainError(e);
  assert.match(out, /OpenAI/);
  assert.match(out, /model/i);
});

test("explainError: provider 429 suggests waiting or switching models", () => {
  const e = Object.assign(new Error("Too Many Requests"), {
    statusCode: 429,
    url: "https://api.anthropic.com/v1/messages",
  });
  const out = explainError(e);
  assert.match(out, /Anthropic/);
  assert.match(out, /rate-limiting|quota/);
});

test("explainError: provider 5xx (and Anthropic overloaded) read as a server error", () => {
  const e = Object.assign(new Error("Internal Server Error"), {
    statusCode: 500,
    url: "https://api.anthropic.com/v1/messages",
  });
  assert.match(explainError(e), /Anthropic had a server error/);
  assert.match(
    explainError(new Error('{"type":"overloaded_error","message":"Overloaded (anthropic)"}')),
    /server error/,
  );
});

// --- registry resolution errors (engine resolveModel) -----------------------------

test("explainError: unknown registry id keeps the known-model list and adds /models", () => {
  const out = explainError(new Error("Unknown model 'gpt-9'. Known models: claude-opus-4.8."));
  assert.match(out, /Unknown model 'gpt-9'/);
  assert.match(out, /Pick one with \/models/);
});

test("explainError: a missing apiKeyEnv message passes through (already actionable)", () => {
  const msg = "Model gpt-4o needs LITELLM_API_KEY — add it to ~/.hemiunu/.env.";
  assert.equal(explainError(new Error(msg)), msg);
});

// --- MCP host failures --------------------------------------------------------------

test("explainError: an MCP connect/tool failure points at mcp.json and the panel", () => {
  const out = explainError(new Error("MCP server 'notion' is not connected: fetch failed"));
  assert.match(out, /'notion'/);
  assert.match(out, /mcp\.json/);
  assert.match(out, /reconnect/i);
});

test("explainError: an unknown MCP server name points at mcp.json", () => {
  assert.match(explainError(new Error("Unknown MCP server 'nope'.")), /mcp\.json/);
});

// --- local model server ----------------------------------------------------------------

test("explainError: ollama connection-refused says how to start it", () => {
  const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
    code: "ECONNREFUSED",
  });
  const out = explainError(e);
  assert.match(out, /Ollama/);
  assert.match(out, /ollama serve/);
});

// --- context window exceeded ------------------------------------------------

test("explainError: LiteLLM ContextWindowExceededError maps to the compact/switch hint", () => {
  const e = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    url: "https://litellm.example.com/v1/chat/completions",
    responseBody:
      '{"error":{"message":"litellm.ContextWindowExceededError: litellm.BadRequestError: ' +
      "VertexAIException BadRequestError - The input (973402 tokens) is longer than the " +
      'model\'s context length (262144 tokens). Received Model Group=qwen3-235b-instruct","code":"400"}}',
  });
  const out = explainError(e);
  assert.match(out, /context window/i);
  assert.match(out, /\/compact/);
  assert.match(out, /\/models/);
  assert.match(out, /LiteLLM proxy/);
});

test("explainError: OpenAI context_length_exceeded maps to the compact/switch hint", () => {
  const e = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    url: "https://api.openai.com/v1/chat/completions",
    responseBody:
      '{"error":{"message":"This model\'s maximum context length is 128000 tokens.",' +
      '"code":"context_length_exceeded"}}',
  });
  const out = explainError(e);
  assert.match(out, /context window/i);
  assert.match(out, /\/compact/);
});

test("explainError: Anthropic prompt-too-long maps to the compact/switch hint", () => {
  const e = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    url: "https://api.anthropic.com/v1/messages",
    responseBody:
      '{"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"prompt is too long: 210012 tokens > 200000 maximum"}}',
  });
  const out = explainError(e);
  assert.match(out, /context window/i);
  assert.match(out, /\/compact/);
  assert.match(out, /Anthropic/);
});
