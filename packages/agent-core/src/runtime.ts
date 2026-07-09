// P6-0 — the drop-in runtime composition. One factory wires the ENTIRE
// multi-provider engine — model registry, transcript store, compactor, the
// per-turn tool assembly (11 in-process servers + control + delegate/parallel
// + web_search/web_fetch + MCP host tools), the permission pipeline, and the
// soul/system-prompt overlay — so consumers (CLI / web / eval) only construct
// it and iterate TurnEvents.
//
// Turn options deliberately keep the OLD agent.ts runTurn option names
// (prompt / model / researchModel / systemPrompt / resume / mcpServers /
// canUseTool / abortController / workspace / permissionMode) so the consumer
// diff at cutover stays minimal. The SDK runtime (agent.ts) stays in place
// untouched — this is its engine-side twin, adopted in later phases.

import { join } from "node:path";
import type {
  CanUseToolResult,
  HemiTool,
  McpHostOptions,
  ModelEntry,
  PermissionMode,
  ResolvedModel,
  RunTurnOptions as EngineRunTurnOptions,
  TurnEvent,
  WorkspaceContext,
} from "@hemiunu/engine";
import {
  Compactor,
  createPipeline,
  createWebFetchTool,
  createWebSearchTool,
  generateTitle as engineGenerateTitle,
  loadModelRegistry,
  McpHost,
  modelForTag,
  runTurn as engineRunTurn,
  TranscriptStore,
} from "@hemiunu/engine";
import { DEFAULT_SOUL } from "@hemiunu/memory";
import { loadMcpRegistry } from "@hemiunu/mcp";
import { customAgentsBlock } from "./agents";
import { configDir } from "./config";
import { createDelegateTool, type EngineSubagentContext } from "./engine-subagents";
import { allHemiTools, createOrchestratorTools } from "./hemitools";
import { mcpOAuthHeaders } from "./mcp-oauth";
import { attachmentsBlock } from "./overlay";
import { createHemiPipelineConfig } from "./pipeline-wiring";
import { serverOf } from "./toolpolicy";

/** Factory-level configuration: the durable pieces one runtime owns. */
export interface EngineRuntimeOptions {
  /**
   * better-sqlite3 database file for the transcript store. Default:
   * `<configDir()>/hemiunu.db` — the SAME file agent-core's ConversationStore
   * opens (the TranscriptStore adds its own `transcript`/`compactions` tables
   * alongside the existing `conversations`/`messages`).
   */
  dbPath?: string;
  /** Model registry override. Default: loadModelRegistry() — shipped defaults
   *  merged with ~/.hemiunu/models.json. */
  registry?: ModelEntry[];
  /** SDK-ready MCP server map for the host. Default: the packages/mcp registry
   *  — loadMcpRegistry(HEMIUNU_HOME, ~/.hemiunu/mcp.json).mcpServers. */
  mcpServers?: Record<string, unknown>;
  /** OAuth header supplier for remote MCP servers. Default: mcpOAuthHeaders
   *  (agent-core's mcp-oauth store, refreshing bearers near expiry). */
  mcpHeaders?: McpHostOptions["headers"];
  /** McpHost tuning / test seams, passed through to the host. */
  mcpHost?: Pick<
    McpHostOptions,
    "clientFactory" | "transportFactory" | "connectTimeoutMs" | "callTimeoutMs"
  >;
  /** Compaction trigger fraction of the model's context window.
   *  Default: compactAt(HEMIUNU_COMPACT_THRESHOLD). */
  compactThreshold?: number;
  /** Per-user config root override — custom agents, attachments, skills (tests). */
  userRoot?: string;
  /** toolpolicy root override (tests). */
  policyRoot?: string;
  /** Per-result truncation budget in tokens (default: resultBudgetTokens()). */
  budgetTokens?: number;
  /** Hard cap on model round-trips per turn (and per subagent run). */
  maxSteps?: number;
  /** Env consulted by the web_search provider chain (tests; default process.env). */
  webSearchEnv?: Record<string, string | undefined>;
  /** Test seam: registry id → ResolvedModel, skipping provider factories/keys. */
  resolve?: (id: string) => ResolvedModel;
  /** Test seam: the engine loop implementation (default: engine runTurn). */
  runTurnImpl?: (opts: EngineRunTurnOptions) => AsyncGenerator<TurnEvent>;
}

/** Per-turn options — the OLD agent.ts runTurn names, kept verbatim. */
export interface EngineTurnOptions {
  prompt: string;
  /** Registry id of the main / synthesis model (default: the synthesis-tagged entry). */
  model?: string;
  /** Registry id for the retrieval tier (the researcher subagent). */
  researchModel?: string;
  /** System prompt, normally built from context/ (soul + user + memory). The
   *  user's overlay (attachments + custom-agent roster) is appended, exactly
   *  as the old runtime did. */
  systemPrompt?: string;
  /** Conversation id to resume a prior conversation. */
  resume?: string;
  /**
   * The MCP servers active THIS turn (e.g. the folder-trust-gated subset the
   * web/CLI front-ends compute). Only tools of the named servers are
   * advertised; names unknown to the runtime's host are ignored. Omit to
   * expose every server the runtime was constructed with.
   */
  mcpServers?: Record<string, unknown>;
  /** Tool-availability wildcards (`mcp__<name>__*`) for the researcher's
   *  sources. Default: derived from the active MCP server names. */
  toolPatterns?: string[];
  /** Interactive permission gate (yes / always / no). If omitted, gated tools
   *  are auto-approved (non-interactive runs) — a policy "block" still wins. */
  canUseTool?: (name: string, input: unknown) => Promise<CanUseToolResult>;
  /** Abort controller to stop the turn mid-flight (Esc to interrupt). */
  abortController?: AbortController;
  /** Pin this turn to one team/repo for its whole life (ALS-relayed). */
  workspace?: WorkspaceContext;
  /** `'plan'` starts the turn READ-ONLY — the loop advertises only read-only
   *  tools plus exit_plan_mode until the plan is approved. */
  permissionMode?: PermissionMode;
  /** Session "always allow" set, checked before the interactive gate. */
  alwaysAllow?: Set<string>;
  /** Auto-accept mode: every gated tool passes without a prompt. */
  autoAccept?: boolean;
  /** Hard cap on model round-trips for this turn. */
  maxSteps?: number;
}

/** What the factory returns: everything a front-end needs, ready to drive. */
export interface EngineRuntime {
  /** Run one agent turn on the engine loop and stream it as TurnEvents. */
  runTurn(opts: EngineTurnOptions): AsyncGenerator<TurnEvent>;
  /** Manual compaction (the CLI's /compact) on this runtime's transcript. */
  compactNow(conversationId: string, model?: string): Promise<string>;
  /** Short conversation title via the registry's title-tagged model
   *  (null on any failure — the caller keeps its fallback). */
  generateTitle(firstMessage: string): Promise<string | null>;
  /** The MCP client host — for the front-ends' MCP panel (status, reconnect). */
  mcpHost: McpHost;
  /** The durable conversation history this runtime reads and writes. */
  transcript: TranscriptStore;
  /** Close MCP clients and the transcript store. */
  shutdown(): Promise<void>;
}

/**
 * Compose the whole engine runtime. Everything durable (registry, transcript
 * store, compactor, MCP host) is built ONCE here; the tool set and permission
 * pipeline are assembled fresh per turn so registry/policy changes and the
 * turn's own gates (canUseTool / plan mode / always-allow) apply immediately.
 */
export function createEngineRuntime(options: EngineRuntimeOptions = {}): EngineRuntime {
  const registry = options.registry ?? loadModelRegistry();
  const dbPath = options.dbPath ?? join(configDir(), "hemiunu.db");
  const transcript = new TranscriptStore(dbPath);
  const compactor = new Compactor({ transcript, threshold: options.compactThreshold, registry });
  const servers =
    options.mcpServers ??
    loadMcpRegistry(process.env.HEMIUNU_HOME ?? process.cwd(), join(configDir(), "mcp.json"))
      .mcpServers;
  const mcpHost = new McpHost({
    servers,
    headers: options.mcpHeaders ?? mcpOAuthHeaders,
    ...options.mcpHost,
  });

  async function* runTurn(opts: EngineTurnOptions): AsyncGenerator<TurnEvent> {
    const modelId = opts.model ?? modelForTag("synthesis", registry, registry[0].id).id;
    const resolvedModel = options.resolve?.(modelId);
    const entry = resolvedModel?.entry ?? registry.find((m) => m.id === modelId);

    // MCP tools for the active servers (per-turn subset, e.g. folder-trust
    // gating). listTools connects on demand; failures land in host status.
    const activeNames = Object.keys(opts.mcpServers ?? servers);
    const activeSet = new Set(activeNames);
    const mcpTools = (await mcpHost.listTools()).filter((t) => activeSet.has(serverOf(t.name)));

    // The turn's tool pool: the 11 in-process servers + engine control tools,
    // the MCP host tools, web_fetch (always), and web_search when the provider
    // chain (Anthropic-direct / Tavily) has one — else it isn't registered.
    const webSearch = createWebSearchTool({ model: entry, env: options.webSearchEnv });
    const pool: HemiTool[] = [
      ...allHemiTools({ userRoot: options.userRoot }),
      ...mcpTools,
      createWebFetchTool(),
      ...(webSearch ? [webSearch] : []),
    ];

    // Delegation surface (main turn only): subagents fan out from `pool`, so
    // a subagent's tool set never contains delegate/parallel (depth 1).
    const subagentCtx: EngineSubagentContext = {
      tools: pool,
      sourceTools: opts.toolPatterns ?? activeNames.map((n) => `mcp__${n}__*`),
      registry,
      model: modelId,
      researchModel: opts.researchModel,
      userRoot: options.userRoot,
      policyRoot: options.policyRoot,
      budgetTokens: options.budgetTokens,
      maxSteps: options.maxSteps,
      resolve: options.resolve,
      runTurnImpl: options.runTurnImpl,
    };
    const tools = [
      ...pool,
      ...createOrchestratorTools(subagentCtx),
      createDelegateTool(subagentCtx),
    ];

    // The permission pipeline, with the turn's gates plumbed in. Plan-mode
    // tool filtering stays in the loop (recomputed per step).
    const executor = createPipeline(
      createHemiPipelineConfig({
        tools,
        canUseTool: opts.canUseTool,
        alwaysAllow: opts.alwaysAllow,
        autoAccept: opts.autoAccept,
        budgetTokens: options.budgetTokens,
        contextWindow: entry?.contextWindow,
        policyRoot: options.policyRoot,
      }),
    );

    const loop = options.runTurnImpl ?? engineRunTurn;
    yield* loop({
      prompt: opts.prompt,
      model: modelId,
      researchModel: opts.researchModel,
      // The caller (CLI/web) builds the base prompt; append the user's overlay
      // — context attachments and the custom-subagent roster — exactly as the
      // old SDK runtime did (agent.ts).
      systemPrompt:
        (opts.systemPrompt ?? DEFAULT_SOUL) +
        attachmentsBlock("main", options.userRoot) +
        customAgentsBlock(options.userRoot),
      resume: opts.resume,
      abortController: opts.abortController,
      workspace: opts.workspace,
      permissionMode: opts.permissionMode,
      tools,
      executor,
      transcript,
      registry,
      maxSteps: opts.maxSteps ?? options.maxSteps,
      compactionCheck: compactor.check,
      resolvedModel,
    });
  }

  return {
    runTurn,
    compactNow: (conversationId, model) => compactor.compactNow(conversationId, model),
    generateTitle: (firstMessage) => engineGenerateTitle(firstMessage, { registry }),
    mcpHost,
    transcript,
    async shutdown() {
      await mcpHost.close();
      transcript.close();
    },
  };
}
