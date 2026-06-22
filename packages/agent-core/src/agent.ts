import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config";
import { createMemoryServer, createModelsServer } from "./tools";

/** Minimal default persona if context/soul.md is empty/missing. */
const DEFAULT_SOUL =
  "You are Hemiunu, a product agent for a product team. Be professional and concise, with simple, precise vocabulary. If you lack information, say so in one line.";

const MEMORY_TOOLS = "mcp__hemiunu-memory__*";
/** ask_model — one-shot calls to non-Claude models on the proxy. */
const MODEL_TOOLS = "mcp__hemiunu-models__*";
/** Built-in tool the main loop uses to delegate to a subagent (resolved id is "Task"). */
const DELEGATE_TOOL = "Task";

/** System prompt for the `researcher` subagent (runs on the cheaper retrieval tier). */
const RESEARCHER_PROMPT = `You are Hemiunu's research subagent. The coordinator delegates a research request to you; your job is to gather grounded information from the connected data sources so the coordinator can answer.

- Search the available sources (Notion, local files, and any other connected MCP servers) thoroughly. Run several searches/reads as needed — don't stop at the first hit.
- Return only what you actually found, each point attributed to its source (page title, file path, URL).
- If the sources do not contain the answer, say so plainly. Never invent facts or fill gaps from general knowledge.
- Output a concise findings brief (short bullets or sections) for the coordinator to synthesize. Do not address the end user directly.`;

export interface RunTurnOptions {
  prompt: string;
  /** Main / synthesis model override (defaults to config/env HEMIUNU_MODEL). */
  model?: string;
  /** Retrieval-tier model for the researcher subagent (defaults to config/env HEMIUNU_MODEL_RESEARCH). */
  researchModel?: string;
  /** System prompt, normally built from context/ (soul + user + memory). */
  systemPrompt?: string;
  /** Session id to resume a prior conversation. */
  resume?: string;
  /** Extra MCP servers to connect (from the mcp.json registry). */
  mcpServers?: Record<string, unknown>;
  /** Tool-availability wildcards for the extra servers, e.g. `mcp__notion__*`. */
  toolPatterns?: string[];
  /** Interactive permission callback (yes / always / no). If omitted, tools are auto-approved. */
  canUseTool?: Options["canUseTool"];
  /** Abort controller to stop the turn mid-flight (Esc to interrupt). */
  abortController?: AbortController;
}

/**
 * Runs one agent turn and yields the raw SDK message stream.
 * Always connects the in-process `remember` tool; merges any registry servers.
 */
export async function* runTurn(opts: RunTurnOptions) {
  const cfg = loadConfig();
  const sourceTools = opts.toolPatterns ?? [];
  // A researcher only earns its keep when there are sources to search. With
  // none connected, the main loop just answers directly (still has memory).
  const hasSources = sourceTools.length > 0;

  // The source tools must be in the parent allowlist to exist in the session
  // at all (so the subagent can inherit them); soul.md steers the main loop to
  // delegate deep/multi-source work to the researcher rather than search itself.
  const tools = [
    MEMORY_TOOLS,
    MODEL_TOOLS,
    ...sourceTools,
    ...(hasSources ? [DELEGATE_TOOL] : []),
  ];

  // Retrieval tier: the researcher runs on the cheaper model and is scoped to
  // the source tools only — no memory writes, no nested delegation.
  const agents: Record<string, AgentDefinition> | undefined = hasSources
    ? {
        researcher: {
          description:
            "Searches the connected data sources (Notion, local files, and any other connected MCP servers) and returns grounded findings with citations. Delegate any question that needs looking things up, or any non-trivial product/research question.",
          prompt: RESEARCHER_PROMPT,
          model: opts.researchModel ?? cfg.researchModel,
          tools: sourceTools,
        },
      }
    : undefined;

  const q = query({
    prompt: opts.prompt,
    options: {
      model: opts.model ?? cfg.model,
      thinking: cfg.thinking,
      systemPrompt: opts.systemPrompt ?? DEFAULT_SOUL,
      // Context is fully ours — don't load filesystem .claude/ config.
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: cfg.baseUrl,
        ANTHROPIC_API_KEY: cfg.apiKey,
      } as Record<string, string>,
      mcpServers: {
        "hemiunu-memory": createMemoryServer(),
        "hemiunu-models": createModelsServer(),
        ...(opts.mcpServers ?? {}),
      } as Options["mcpServers"],
      ...(agents ? { agents } : {}),
      // Restrict the available toolset (default loads ~29 built-ins, whose
      // schemas are billed every turn). Only our memory tool + enabled servers
      // + the delegate tool when a researcher is available.
      tools,
      // With a permission callback, every tool use is gated (yes/always/no).
      // Without one, pre-approve our tools so non-interactive runs don't block.
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : { allowedTools: tools }),
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  });

  for await (const message of q) {
    yield message;
  }
}
