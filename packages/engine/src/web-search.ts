// web_search — the engine's owned web search tool, with a provider chain:
//
//   1. Anthropic direct — when the resolved model is served by Anthropic with
//      no gateway/baseURL override, searches run through Anthropic's
//      server-side web_search tool (a minimal Messages API call; no extra key).
//   2. Tavily — bring-your-own-key via TAVILY_API_KEY (plain fetch, no SDK).
//   3. Neither available → createWebSearchTool returns undefined and the tool
//      is simply NOT registered (graceful degrade — the model never sees it).

import { z } from "zod";
import type { ModelEntry } from "./models";
import type { HemiTool } from "./tool";

export type WebSearchProvider = "anthropic" | "tavily";

export interface WebSearchOptions {
  /** The model entry the turn resolved to — decides the provider chain. */
  model?: ModelEntry;
  /** Env override (tests); default process.env. */
  env?: Record<string, string | undefined>;
  /** Fetch override (tests); default global fetch (undici). */
  fetchImpl?: typeof fetch;
  /** Max results per search (Tavily) / server-side searches (Anthropic). */
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 8;
const ANTHROPIC_VERSION = "2023-06-01";

/** True when the entry hits Anthropic's own endpoint (no gateway/proxy), so
 *  the server-side web_search tool is actually available. */
function isAnthropicDirect(model: ModelEntry | undefined, env: WebSearchOptions["env"]): boolean {
  if (!model || model.provider !== "anthropic" || model.baseURL) return false;
  const e = env ?? process.env;
  if (e.ANTHROPIC_BASE_URL?.trim()) return false;
  return !!e[model.apiKeyEnv ?? "ANTHROPIC_API_KEY"]?.trim();
}

/** Which provider the chain selects, or undefined when none is available. */
export function selectWebSearchProvider(
  opts: WebSearchOptions = {},
): WebSearchProvider | undefined {
  const env = opts.env ?? process.env;
  if (isAnthropicDirect(opts.model, env)) return "anthropic";
  if (env.TAVILY_API_KEY?.trim()) return "tavily";
  return undefined;
}

interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

function formatHits(hits: SearchHit[], preamble?: string): string {
  if (!hits.length) return preamble?.trim() || "No results found.";
  const lines = hits.map((h, i) => {
    const head = `${i + 1}. ${h.title || h.url}\n   ${h.url}`;
    return h.snippet ? `${head}\n   ${h.snippet.trim()}` : head;
  });
  return [preamble?.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Anthropic server-side search: one minimal Messages call with the
 *  web_search server tool; results come back as web_search_tool_result blocks. */
async function anthropicSearch(
  query: string,
  model: ModelEntry,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  maxResults: number,
): Promise<string> {
  const apiKey = env[model.apiKeyEnv ?? "ANTHROPIC_API_KEY"]?.trim() ?? "";
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: `Search the web for: ${query}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic web search failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    content?: Array<{
      type?: string;
      text?: string;
      content?: Array<{ type?: string; url?: string; title?: string; page_age?: string }>;
    }>;
  };
  const hits: SearchHit[] = [];
  const texts: string[] = [];
  for (const block of body.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type !== "web_search_result" || typeof r.url !== "string") continue;
        if (hits.length >= maxResults) break;
        hits.push({ title: r.title ?? r.url, url: r.url, snippet: r.page_age });
      }
    }
  }
  return formatHits(hits, texts.join("\n"));
}

/** Tavily search — plain fetch against api.tavily.com with the user's key. */
async function tavilySearch(
  query: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  maxResults: number,
): Promise<string> {
  const res = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TAVILY_API_KEY?.trim() ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, max_results: maxResults, include_answer: true }),
  });
  if (!res.ok) {
    throw new Error(`Tavily web search failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const hits: SearchHit[] = (body.results ?? [])
    .filter(
      (r): r is { title?: string; url: string; content?: string } => typeof r.url === "string",
    )
    .slice(0, maxResults)
    .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content }));
  return formatHits(hits, body.answer);
}

/**
 * Build the `web_search` HemiTool for this turn, or undefined when no search
 * provider is available (Anthropic-direct model or TAVILY_API_KEY) — an
 * unregistered tool is invisible to the model, so degradation is graceful.
 */
export function createWebSearchTool(
  opts: WebSearchOptions = {},
): HemiTool<{ query: string }> | undefined {
  const provider = selectWebSearchProvider(opts);
  if (!provider) return undefined;
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  return {
    name: "web_search",
    description:
      "Search the web and get back a ranked list of results (title, URL, snippet). Use it for anything you don't reliably know: current events, versions, prices, documentation. Follow up with web_fetch to read a promising result in full.",
    inputSchema: z.object({
      query: z.string().min(1).describe("The search query, as you'd type it into a search engine."),
    }),
    readOnly: true,
    async execute({ query }) {
      const content =
        provider === "anthropic"
          ? await anthropicSearch(query, opts.model!, env, fetchImpl, maxResults)
          : await tavilySearch(query, env, fetchImpl, maxResults);
      return { content };
    },
  };
}
