import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config";
import { createMemoryServer, createModelsServer } from "./tools";
import { createPrototypeServer } from "./prototype";
import { createOrchestratorServer } from "./orchestrator";
import { createSkillsServer, SKILL_TOOLS } from "./skills";
import { createPrototypeKnowledgeServer, PROTOTYPE_KNOWLEDGE_TOOLS } from "./prototypes";
import { createWorkspaceServer, WORKSPACE_TOOLS } from "./iterate";
import {
  SUBAGENTS,
  SUBAGENT_NAMES,
  subagentPrompt,
  type SubagentRunContext,
  type SubagentEvent,
} from "./subagents";

/** Minimal default persona if context/soul.md is empty/missing. */
const DEFAULT_SOUL =
  "You are Hemiunu, a product agent for a product team. Be professional and concise, with simple, precise vocabulary. If you lack information, say so in one line.";

const MEMORY_TOOLS = "mcp__hemiunu-memory__*";
/** ask_model — one-shot calls to non-Claude models on the proxy. */
const MODEL_TOOLS = "mcp__hemiunu-models__*";
/** save_prototype — writes a wireframe into the prototypes/ sandbox. */
const PROTOTYPE_TOOLS = "mcp__hemiunu-prototype__*";
/** parallel — run independent subtasks concurrently (code-level fan-out). */
const ORCHESTRATOR_TOOLS = "mcp__hemiunu-orchestrator__*";
/** Built-in tool the main loop uses to delegate to a subagent (resolved id is "Task"). */
const DELEGATE_TOOL = "Task";

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
  /** Live progress from parallel subtasks (so the CLI can show what's running). */
  onSubagentEvent?: (e: SubagentEvent) => void;
}

/**
 * Runs one agent turn and yields the raw SDK message stream.
 * Always connects the in-process `remember` tool; merges any registry servers.
 */
export async function* runTurn(opts: RunTurnOptions) {
  const cfg = loadConfig();
  const sourceTools = opts.toolPatterns ?? [];
  const model = opts.model ?? cfg.model;
  const researchModel = opts.researchModel ?? cfg.researchModel;
  // A researcher only earns its keep when there are sources to search. With
  // none connected, the main loop just answers directly (still has memory).
  const hasSources = sourceTools.length > 0;

  // Subagent tools must also be in the parent allowlist to exist in the session
  // (so subagents can inherit them); soul.md steers the main loop to delegate
  // rather than do the heavy work itself.
  const tools = [
    MEMORY_TOOLS,
    MODEL_TOOLS,
    PROTOTYPE_TOOLS,
    ORCHESTRATOR_TOOLS,
    SKILL_TOOLS,
    PROTOTYPE_KNOWLEDGE_TOOLS,
    WORKSPACE_TOOLS,
    ...sourceTools,
    DELEGATE_TOOL,
  ];

  // SDK subagents (delegation via Task), built from the shared spec. The
  // `prototyper` is always available; the `researcher` only when there are
  // sources for it to search.
  const agents: Record<string, AgentDefinition> = {};
  for (const name of SUBAGENT_NAMES) {
    const spec = SUBAGENTS[name];
    const agentTools = spec.tools(sourceTools);
    if (name === "researcher" && !hasSources) continue;
    agents[name] = {
      description: spec.description,
      prompt: subagentPrompt(name),
      model: spec.tier === "research" ? researchModel : model,
      tools: agentTools,
    };
  }

  // Base servers the main loop AND parallel sub-runs share. The orchestrator is
  // added only to the main loop (below) so sub-runs can't recursively fan out.
  const baseServers = {
    "hemiunu-memory": createMemoryServer(),
    "hemiunu-models": createModelsServer(),
    "hemiunu-prototype": createPrototypeServer(),
    "hemiunu-skills": createSkillsServer(),
    "hemiunu-prototype-knowledge": createPrototypeKnowledgeServer(),
    "hemiunu-workspace": createWorkspaceServer(),
    ...(opts.mcpServers ?? {}),
  } as Options["mcpServers"];

  const subagentCtx: SubagentRunContext = {
    model,
    researchModel,
    sourceTools,
    mcpServers: baseServers,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    thinking: cfg.thinking,
    onEvent: opts.onSubagentEvent,
  };

  const q = query({
    prompt: opts.prompt,
    options: {
      model,
      thinking: cfg.thinking,
      systemPrompt: opts.systemPrompt ?? DEFAULT_SOUL,
      // Context is fully ours — don't load filesystem .claude/ config.
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: cfg.apiKey,
        ...(cfg.baseUrl ? { ANTHROPIC_BASE_URL: cfg.baseUrl } : {}),
      } as Record<string, string>,
      mcpServers: {
        ...baseServers,
        "hemiunu-orchestrator": createOrchestratorServer(subagentCtx),
      } as Options["mcpServers"],
      agents,
      // Restrict the available toolset (default loads ~29 built-ins, whose
      // schemas are billed every turn). Only our in-process tools + enabled
      // source servers + the delegate tool for subagents.
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
