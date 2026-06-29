import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, sdkConfigDir } from "./config";
import { createMemoryServer, createModelsServer } from "./tools";
import { createPrototypeServer } from "./prototype";
import { createOrchestratorServer } from "./orchestrator";
import { createSkillsServer, SKILL_TOOLS } from "./skills";
import { createPrototypeKnowledgeServer, PROTOTYPE_KNOWLEDGE_TOOLS } from "./prototypes";
import { createWorkspaceServer, WORKSPACE_TOOLS } from "./iterate";
import { createShareServer, SHARE_TOOLS } from "./share";
import { createSourcesServer, SOURCE_TOOLS } from "./sources";
import { createAgentHooks } from "./toolcap";
import { createTeamControlServer, TEAM_CONTROL_TOOLS } from "./control";
import { createAskServer, ASK_TOOLS } from "./ask";
import { withWorkspace, type WorkspaceContext } from "./workspace-context";
import {
  SUBAGENTS,
  SUBAGENT_NAMES,
  WEB_TOOLS,
  PLANNING_TOOLS,
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
  /** Tool-availability wildcards for the extra servers, e.g. `mcp__filesystem__*`. */
  toolPatterns?: string[];
  /** Interactive permission callback (yes / always / no). If omitted, tools are auto-approved. */
  canUseTool?: Options["canUseTool"];
  /** Abort controller to stop the turn mid-flight (Esc to interrupt). */
  abortController?: AbortController;
  /** Live progress from parallel subtasks (so the CLI can show what's running). */
  onSubagentEvent?: (e: SubagentEvent) => void;
  /**
   * Pin this turn to one team/repo for its whole life. The agent's file/GitHub
   * tools resolve against this binding (not the global current team), so several
   * teams can run concurrently without writing to each other's repo. Omit to use
   * the persisted global selection (single-session behavior).
   */
  workspace?: WorkspaceContext;
  /**
   * Permission mode for the turn. `'plan'` starts the turn READ-ONLY: the agent
   * researches and proposes a plan via ExitPlanMode but executes nothing until
   * the user approves it (at which point the permission callback returns the
   * SDK's suggested `updatedPermissions` to exit plan mode and continue). Omit
   * for normal execution.
   */
  permissionMode?: Options["permissionMode"];
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
    SHARE_TOOLS,
    SOURCE_TOOLS,
    TEAM_CONTROL_TOOLS,
    ASK_TOOLS,
    ...sourceTools,
    ...WEB_TOOLS,
    ...PLANNING_TOOLS,
    DELEGATE_TOOL,
  ];

  // SDK subagents (delegation via Task), built from the shared spec. The
  // `prototyper` is always available; the `researcher` only when there are
  // sources for it to search.
  const agents: Record<string, AgentDefinition> = {};
  for (const name of SUBAGENT_NAMES) {
    const spec = SUBAGENTS[name];
    const agentTools = spec.tools(sourceTools);
    // Source-dependent subagents (the researcher) only earn their keep when
    // sources are connected; reasoning specialists are always available.
    if (spec.needsSources && !hasSources) continue;
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
    "hemiunu-share": createShareServer(),
    "hemiunu-sources": createSourcesServer(),
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
    // Stopping the turn must also cancel any subagent fanned out by the
    // orchestrator (those run their own query, outside the SDK's Task tree).
    abortController: opts.abortController,
  };

  const queryOptions = {
    prompt: opts.prompt,
    options: {
      model,
      thinking: cfg.thinking,
      systemPrompt: opts.systemPrompt ?? DEFAULT_SOUL,
      // Cap oversized tool results before they enter context (covers the main
      // loop AND SDK-delegated subagents). See toolcap.ts.
      hooks: createAgentHooks(),
      // Context is fully ours — don't load filesystem .claude/ config.
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: cfg.apiKey,
        ...(cfg.baseUrl ? { ANTHROPIC_BASE_URL: cfg.baseUrl } : {}),
        // Keep the SDK's session data under ~/.hemiunu, not ~/.claude.
        CLAUDE_CONFIG_DIR: sdkConfigDir(),
      } as Record<string, string>,
      mcpServers: {
        ...baseServers,
        "hemiunu-orchestrator": createOrchestratorServer(subagentCtx),
        // Main-loop only: lets the agent create/switch teams via the CLI.
        "hemiunu-team-control": createTeamControlServer(),
        // Main-loop only: ask the user a multiple-choice question (control bridge).
        "hemiunu-ask": createAskServer(),
      } as Options["mcpServers"],
      agents,
      // Restrict the available toolset (default loads ~29 built-ins, whose
      // schemas are billed every turn). Only our in-process tools + enabled
      // source servers + the delegate tool + the web tools (WEB_TOOLS) and
      // planning tools (PLANNING_TOOLS) we deliberately opt into; everything else
      // stays stripped to keep turns cheap.
      tools,
      // With a permission callback, every tool use is gated (yes/always/no).
      // Without one, pre-approve our tools so non-interactive runs don't block.
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : { allowedTools: tools }),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  } as Parameters<typeof query>[0];

  // Drive the query inside this turn's workspace binding and relay messages out
  // through a queue. The relay matters: an async generator's body resumes in the
  // CALLER's async context on each `.next()`, which would drop the binding. By
  // starting query() (and its whole internal agent loop, where the in-process
  // tool handlers run) synchronously inside withWorkspace(), every tool callback
  // inherits THIS turn's repo — even while another team's turn runs concurrently.
  if (!opts.workspace) {
    const q = query(queryOptions);
    for await (const message of q) yield message;
    return;
  }

  const buffer: unknown[] = [];
  let done = false;
  let failure: unknown;
  let signal: Promise<void>;
  let fire: () => void = () => {};
  const reset = () => {
    signal = new Promise<void>((r) => (fire = r));
  };
  reset();
  const wake = () => {
    const f = fire;
    reset();
    f();
  };

  withWorkspace(opts.workspace, () => {
    void (async () => {
      try {
        for await (const message of query(queryOptions)) {
          buffer.push(message);
          wake();
        }
      } catch (e) {
        failure = e;
      } finally {
        done = true;
        wake();
      }
    })();
  });

  while (true) {
    const waiter = signal!; // capture before draining, so a push can't slip past
    while (buffer.length) yield buffer.shift();
    if (failure) throw failure;
    if (done) return;
    await waiter;
  }
}
