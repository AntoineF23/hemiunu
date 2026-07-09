// @hemiunu/engine — the multi-provider runtime foundation. This is the ONLY
// package allowed to import `ai` / `@ai-sdk/*`; everything else consumes the
// provider-neutral surface re-exported here.

export type { TurnUsage, TodoItem, ToolOutput, StopReason, TurnEvent } from "./events";
export { isDeltaEvent, isTurnFinish, isToolEvent, emptyUsage, addUsage } from "./events";

export type {
  PermissionMode,
  ToolContext,
  HemiTool,
  JsonSchemaInput,
  ToolInputSchema,
  ToolInputValidation,
} from "./tool";
export { isJsonSchemaInput, validateToolInput } from "./tool";

export type { ModelTag, ModelEntry, ResolvedModel } from "./models";
export {
  defaultModels,
  loadModelRegistry,
  resolveModel,
  modelForTag,
  costUsd,
  promptHintsBlock,
  keyEnvFor,
  modelAvailable,
  anyModelAvailable,
  keylessEndpointUp,
  registryReady,
  resolveDefaultModel,
} from "./models";

export type { GatewayModelInput, GatewayPreset } from "./gateway";
export {
  GATEWAY_PRESETS,
  normalizeGatewayBase,
  parseDiscoveredModels,
  addGatewayModels,
  contextWindowForId,
  parseModelInfoWindows,
  fetchModelInfoWindows,
  KNOWN_CONTEXT_WINDOWS,
  FALLBACK_CONTEXT_WINDOW,
} from "./gateway";

export type { TranscriptMessage, LoadedTranscript } from "./transcript";
export { TranscriptStore } from "./transcript";

export type { ToolCall, ToolExecutor, PermissionDecision, CanUseTool } from "./executor";
export { DirectExecutor } from "./executor";

export type { WorkspaceContext } from "./workspace";
export { withWorkspace, currentWorkspace } from "./workspace";

export type { RunTurnOptions, CompactionCheck, CompactionOutcome } from "./loop";
export { runTurn, PLAN_EXIT_TOOL } from "./loop";

export type { CompactorOptions } from "./compactor";
export {
  Compactor,
  COMPACT_PROMPT,
  TRUNCATION_NOTE,
  compactAt,
  summaryNote,
  estimateContextTokens,
  estimateToolTokens,
  truncateToFit,
} from "./compactor";

export type { GenerateTitleOptions } from "./title";
export { generateTitle, titleModelEntry, TITLE_SYSTEM_PROMPT } from "./title";

export type { PolicyDecision, CanUseToolResult, PipelineConfig, ToolNameMatch } from "./pipeline";
export { createPipeline, MAX_SELF_REPAIR_ATTEMPTS, matchToolName } from "./pipeline";

export { todoWriteTool, enterPlanModeTool, exitPlanModeTool, controlTools } from "./control-tools";

export type {
  McpHostOptions,
  McpClientLike,
  McpServerStatus,
  McpToolInfo,
  McpTransportKind,
  McpConnectionState,
} from "./mcp-host";
export { McpHost, isUnauthorizedError } from "./mcp-host";

export type { WebSearchOptions, WebSearchProvider } from "./web-search";
export { createWebSearchTool, selectWebSearchProvider } from "./web-search";

export type { WebFetchOptions } from "./web-fetch";
export { createWebFetchTool, extractReadableMarkdown, isPrivateAddress } from "./web-fetch";

export type { PlanDecision, PlanDecisionEffects } from "./plan";
export { PLAN_DECISIONS, PLAN_REFINE_MESSAGE, isPlanDecision, applyPlanDecision } from "./plan";
