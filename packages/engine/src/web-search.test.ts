import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelEntry } from "./models";
import type { ToolContext } from "./tool";
import { createWebSearchTool, selectWebSearchProvider } from "./web-search";

function ctx(): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "test",
    emit: () => {},
    mode: () => "default",
    setMode: () => {},
  };
}

const anthropicEntry: ModelEntry = {
  id: "claude-opus-4.8",
  label: "Claude Opus 4.8",
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  contextWindow: 1_000_000,
  supports: { tools: true },
};

const openaiEntry: ModelEntry = {
  id: "gpt-5.2",
  label: "GPT-5.2",
  provider: "openai",
  model: "gpt-5.2",
  contextWindow: 400_000,
  supports: { tools: true },
};

// --- chain selection --------------------------------------------------------------

test("web_search chain: Anthropic direct wins when the resolved model is Anthropic", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant", TAVILY_API_KEY: "tvly" };
  assert.equal(selectWebSearchProvider({ model: anthropicEntry, env }), "anthropic");
});

test("web_search chain: a gateway/baseURL override means NOT Anthropic direct", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant", TAVILY_API_KEY: "tvly" };
  assert.equal(
    selectWebSearchProvider({ model: { ...anthropicEntry, baseURL: "https://gw.example" }, env }),
    "tavily",
  );
  assert.equal(
    selectWebSearchProvider({
      model: anthropicEntry,
      env: { ...env, ANTHROPIC_BASE_URL: "https://gw.example" },
    }),
    "tavily",
  );
  // No Anthropic key → can't use the server-side tool either.
  assert.equal(
    selectWebSearchProvider({ model: anthropicEntry, env: { TAVILY_API_KEY: "tvly" } }),
    "tavily",
  );
});

test("web_search chain: non-Anthropic models fall back to Tavily via TAVILY_API_KEY", () => {
  assert.equal(
    selectWebSearchProvider({ model: openaiEntry, env: { TAVILY_API_KEY: "tvly" } }),
    "tavily",
  );
});

test("web_search chain: no provider → the tool is simply not registered", () => {
  assert.equal(selectWebSearchProvider({ model: openaiEntry, env: {} }), undefined);
  assert.equal(createWebSearchTool({ model: openaiEntry, env: {} }), undefined);
  assert.equal(createWebSearchTool({ env: {} }), undefined);
});

// --- execution (mocked fetch) -------------------------------------------------------

test("web_search via Anthropic: calls the Messages API with the server-side tool", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(
      JSON.stringify({
        content: [
          { type: "server_tool_use", id: "st1", name: "web_search" },
          {
            type: "web_search_tool_result",
            content: [
              {
                type: "web_search_result",
                url: "https://a.example",
                title: "Result A",
                page_age: "1 day ago",
              },
              { type: "web_search_result", url: "https://b.example", title: "Result B" },
            ],
          },
          { type: "text", text: "Two good sources found." },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const tool = createWebSearchTool({
    model: anthropicEntry,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    fetchImpl,
  });
  assert.ok(tool);
  assert.equal(tool.name, "web_search");
  assert.equal(tool.readOnly, true);

  const out = await tool.execute({ query: "pyramid architects" }, ctx());
  assert.equal(out.isError, undefined);
  assert.match(out.content, /Result A/);
  assert.match(out.content, /https:\/\/b\.example/);
  assert.match(out.content, /Two good sources found\./);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-ant-test");
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.model, "claude-opus-4-8");
  assert.deepEqual(body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
  assert.match(body.messages[0].content, /pyramid architects/);
});

test("web_search via Tavily: bearer key, max_results honored, results formatted", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(
      JSON.stringify({
        answer: "Hemiunu designed the Great Pyramid.",
        results: [
          {
            title: "Hemiunu - Encyclopedia",
            url: "https://enc.example/hemiunu",
            content: "Vizier and architect.",
          },
          { title: "Giza", url: "https://giza.example", content: "The plateau." },
          { title: "Extra", url: "https://extra.example", content: "Beyond the cap." },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const tool = createWebSearchTool({
    model: openaiEntry,
    env: { TAVILY_API_KEY: "tvly-test" },
    fetchImpl,
    maxResults: 2,
  });
  assert.ok(tool);

  const out = await tool.execute({ query: "who designed the great pyramid" }, ctx());
  assert.match(out.content, /Hemiunu designed the Great Pyramid\./);
  assert.match(out.content, /1\. Hemiunu - Encyclopedia/);
  assert.match(out.content, /https:\/\/giza\.example/);
  assert.ok(!out.content.includes("extra.example"), "maxResults caps the list");

  assert.equal(requests[0].url, "https://api.tavily.com/search");
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tvly-test");
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.query, "who designed the great pyramid");
  assert.equal(body.max_results, 2);
});

test("web_search: provider HTTP errors surface as readable failures", async () => {
  const fetchImpl: typeof fetch = async () => new Response("rate limited", { status: 429 });
  const tool = createWebSearchTool({ env: { TAVILY_API_KEY: "tvly" }, fetchImpl });
  assert.ok(tool);
  await assert.rejects(() => tool.execute({ query: "x" }, ctx()), /Tavily web search failed: 429/);
});
