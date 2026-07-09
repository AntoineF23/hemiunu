export { withWorkspace, currentWorkspace } from "./workspace-context";
export type { WorkspaceContext } from "./workspace-context";
export { loadConfig, configDir, hasApiKey, writeUserEnv, contextWindowFor } from "./config";
export type { HemiunuConfig, UserEnv } from "./config";
export {
  REMEMBER_TOOL_ID,
  ASK_MODEL_TOOL_ID,
  askModel,
  askAnthropic,
  generateTitle,
} from "./tools";
export type { AskModelOptions, AskAnthropicOptions } from "./tools";
export { PROVIDERS, PROVIDER_NAMES, resolveProvider } from "./providers";
export type { ProviderSpec } from "./providers";
export { SAVE_PROTOTYPE_TOOL_ID, savePrototype, slugify } from "./prototype";
export type { PrototypeFile, SavePrototypeOptions, SavedPrototype } from "./prototype";
export { PARALLEL_TOOL_ID, pool, validateParallelTasks } from "./orchestrator";
export { loadSkills, loadSkill, saveSkill, deleteSkill, expandSkill, skillsDir } from "./skills";
export type { Skill, SkillMeta, SaveSkillOptions, SavedSkill } from "./skills";
export { upsertUserEnv, removeUserEnv } from "./config";
export { parseFrontmatter, renderFrontmatter } from "./frontmatter";
export { explainError } from "./explain";
export { fetchTimeoutMs, timeoutSignal, isTimeoutError } from "./net";
export {
  resolveGithubToken,
  resolveRepo,
  normalizeRepo,
  githubViewer,
  githubClientId,
  requestDeviceCode,
  pollDeviceToken,
  loadTeams,
  listTeams,
  currentTeam,
  addTeam,
  switchTeam,
  removeTeam,
  renameTeam,
  setCurrentTeam,
  cycleTeam,
  createRepo,
  renameRepo,
  repoExists,
  pruneTeams,
  repoAccess,
  addCollaborator,
  removeCollaborator,
  listCollaborators,
  listOrgMembers,
  githubStatus,
  syncGithubStatus,
  currentGithubLogin,
  connectGithubAccount,
  switchGithubAccount,
  disconnectGithub,
  removeGithubAccount,
} from "./github";
export type {
  TeamsConfig,
  DeviceCode,
  DevicePoll,
  RepoAccess,
  Collaborator,
  GithubStatus,
} from "./github";
export {
  addPrototypeNote,
  getPrototypeKnowledge,
  updatePrototype,
  appendKnowledge,
  prototypePath,
  PROTOTYPE_FILE,
} from "./prototypes";
export type { NoteKind } from "./prototypes";
export {
  ensureWorkspace,
  ensureCloned,
  reconcileWorkspace,
  freshenWorkspace,
  publishWorkspace,
  discardWorkspace,
  binWorkspace,
  listTrash,
  restoreTrash,
  workspacePath,
  workspacesRoot,
  trashRoot,
  setLocalSession,
  localWorkspaceDir,
  activeProtoDir,
} from "./workspace";
export type {
  EnsureOptions,
  EnsureResult,
  TrashEntry,
  ReconcileResult,
  ReconcileStatus,
} from "./workspace";
export { startPreview, stopPreview, previewStatus, hasDevScript } from "./preview";
export { verifyPrototype, capOutput } from "./verify";
export type { VerifyResult } from "./verify";
export { WORKSPACE_TOOLS, readWindow, searchRegex, spilledResult } from "./iterate";
export {
  commitAndPush,
  migrateLocalIntoTeam,
  renameWorkspace,
  checkpointWorkspace,
  restoreCheckpoint,
  CHECKPOINT_BRANCH,
} from "./workspace";
export type { PushResult } from "./workspace";
export {
  MONUMENTS,
  TIERS,
  TIER_ORDER,
  TIER_FLAVOR,
  atlasPath,
  atlasUrl,
  loadAtlas,
  recordDiscovery,
  discoveryLine,
} from "./atlas";
export type { Tier, TierMeta, Monument, Discovery, DiscoveryResult } from "./atlas";
export {
  loadSourceMaps,
  loadSourceMap,
  saveSourceMap,
  deleteSourceMap,
  sourceMapsDir,
  SOURCE_TOOLS,
  SAVE_SOURCE_MAP_TOOL_ID,
  GET_SOURCE_MAP_TOOL_ID,
} from "./sources";
export type { SourceMap, SourceMapMeta, SaveSourceMapOptions } from "./sources";
export { runScan, SCANNER_PROMPT, scanInstruction } from "./scan";
export type { ScanOptions } from "./scan";
export { resultBudgetTokens, DEFAULT_RESULT_BUDGET_TOKENS } from "./toolcap";
export {
  loadToolPolicy,
  setServerPolicy,
  setToolPolicy,
  resolveToolPolicy,
  recordSeenTool,
  setSeenTools,
  serverOf,
} from "./toolpolicy";
export type { ToolPolicy, ToolPolicyFile } from "./toolpolicy";
export { enumerateServerTools } from "./mcp-tools";
export type { McpToolInfo } from "./mcp-tools";
export {
  resolveCloudflareCreds,
  cloudflareConfigured,
  cloudflareDeploy,
  fetchCloudflareAccountId,
  projectNameFor,
  cloudflareProvider,
} from "./cloudflare";
export type { CloudflareCreds } from "./cloudflare";
export { activeProvider, activeProviderId, listDeployProviders } from "./deploy";
export type { DeployProvider, DeployResult } from "./deploy";
export { setControlHandler, requestControl, addTeammate, removeTeammate } from "./control";
export type { ControlEvent, AskQuestion } from "./control";
export { ASK_USER_TOOL_ID } from "./ask";
export { subagentPrompt, SUBAGENTS, SUBAGENT_NAMES } from "./subagents";
export type { SubagentName, SubagentSpec } from "./subagents";
export {
  startMcpAuth,
  completeMcpAuth,
  applyMcpOAuth,
  bearerFor,
  mcpOAuthHeaders,
  probeMcpServer,
  mcpOAuthStatus,
  removeMcpOAuth,
  discoverMcpAuth,
  pkceChallenge,
  parseWwwAuthenticate,
} from "./mcp-oauth";
export type { McpOAuthRecord, DiscoveredAuth, McpProbe } from "./mcp-oauth";
export {
  listAttachments,
  loadAttachment,
  attachmentsFor,
  attachmentsBlock,
  saveAttachment,
  deleteAttachment,
  knowledgeDoc,
  hasKnowledgeOverride,
  shippedKnowledge,
  saveKnowledgeOverride,
  deleteKnowledgeOverride,
  listShippedKnowledge,
  readSoul,
  readUserMemory,
  writeUserMemory,
} from "./overlay";
export type { Attachment, AttachmentMeta, SaveAttachmentOptions } from "./overlay";
export { openExternal } from "./open";
export { buildMemoryGraph } from "./memorygraph";
export type { MemoryGraph, MemoryNode, MemoryLink, MemoryNodeKind } from "./memorygraph";
export {
  listCustomAgents,
  loadCustomAgent,
  saveCustomAgent,
  deleteCustomAgent,
  isBuiltinAgent,
  customAgentsBlock,
} from "./agents";
export type { CustomAgent, CustomAgentMeta, SaveCustomAgentOptions } from "./agents";

// --- Engine (P2): HemiTool ports + permission-pipeline wiring ----------------
export {
  allHemiTools,
  createAskTools,
  createMemoryTools,
  createModelsTools,
  createOrchestratorTools,
  createPrototypeKnowledgeTools,
  createPrototypeTools,
  createShareTools,
  createSkillsTools,
  createSourcesTools,
  createTeamControlTools,
  createWorkspaceTools,
  defineTool,
} from "./hemitools";
export type { HemiToolsOptions } from "./hemitools";
export {
  confineWriteDestinations,
  createHemiPipelineConfig,
  createWriteScopeCheck,
} from "./pipeline-wiring";
export type { HemiPipelineOptions } from "./pipeline-wiring";

// --- Engine (P6): the drop-in runtime composition ----------------------------
export { createEngineRuntime } from "./runtime";
export type { EngineRuntime, EngineRuntimeOptions, EngineTurnOptions } from "./runtime";

// --- Engine (P4): subagents on the engine loop -------------------------------
export {
  DELEGATE_TOOL_NAME,
  availableEngineAgents,
  createDelegateTool,
  runEngineSubagent,
} from "./engine-subagents";
export type { EngineSubagentContext, EngineSubagentRunOptions } from "./engine-subagents";
