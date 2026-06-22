import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config";
import { createMemoryServer } from "./tools";

/** Minimal default persona if context/soul.md is empty/missing. */
const DEFAULT_SOUL =
  "You are Hemiunu, a product agent for a product team. Be professional and concise, with simple, precise vocabulary. If you lack information, say so in one line.";

const MEMORY_TOOLS = "mcp__hemiunu-memory__*";

export interface RunTurnOptions {
  prompt: string;
  /** Model override (defaults to config/env HEMIUNU_MODEL). */
  model?: string;
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
  const tools = [MEMORY_TOOLS, ...(opts.toolPatterns ?? [])];

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
        ...(opts.mcpServers ?? {}),
      } as Options["mcpServers"],
      // Restrict the available toolset (default loads ~29 built-ins, whose
      // schemas are billed every turn). Only our memory tool + enabled servers.
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
