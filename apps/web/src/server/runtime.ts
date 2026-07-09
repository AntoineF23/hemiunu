// Boot-time engine state, assembled once and shared by all routes. Mirrors the
// CLI's main() bootstrap (apps/cli/src/index.tsx:1812) — same files, same dirs —
// so the web worker and the CLI read identical config/state.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  configDir,
  createEngineRuntime,
  currentTeam,
  setLocalSession,
  type EngineRuntime,
} from "@hemiunu/agent-core";
import { loadMcpRegistry, sandboxStdioCwd } from "@hemiunu/mcp";
import { loadModelRegistry, resolveDefaultModel } from "@hemiunu/engine";
import {
  buildSystemPrompt,
  ConversationStore,
  loadContext,
  seedContextFiles,
} from "@hemiunu/memory";

export interface Runtime {
  store: ConversationStore;
  registry: ReturnType<typeof loadMcpRegistry>;
  baseSystemPrompt: string;
  /** Active main/synthesis model — a model-registry id. */
  model: string;
  /** Active retrieval-tier model (the researcher subagent) — a registry id. */
  researchModel: string;
  /** The filesystem MCP server name, if one is configured (gated by folder trust). */
  fsName: string | undefined;
  /** The composed engine runtime: turn loop, compaction, titles, MCP host. */
  engine: EngineRuntime;
}

let rt: Runtime | undefined;

export function bootRuntime(): Runtime {
  if (rt) return rt;
  // HEMIUNU_HOME = install dir (soul.md, mcp.json, repo-root .env). The bin
  // launcher sets it; when the worker is run directly from apps/web (e.g.
  // `pnpm --filter @hemiunu/web dev`), fall back to the repo root resolved from
  // this file's location — apps/web/src/server → up four = repo root. We set it
  // on process.env (not just a local) so the engine's loadConfig/loadMcpRegistry,
  // which read process.env.HEMIUNU_HOME themselves, resolve the same root.
  // configDir() = ~/.hemiunu (keys, db, overlays) is independent of this.
  if (!process.env.HEMIUNU_HOME) {
    process.env.HEMIUNU_HOME = join(import.meta.dirname, "..", "..", "..", "..");
  }
  const home = process.env.HEMIUNU_HOME;
  const dataDir = configDir();
  mkdirSync(dataDir, { recursive: true });
  setLocalSession(`${Date.now().toString(36)}-web`);

  const store = new ConversationStore(join(dataDir, "hemiunu.db"));
  const registry = loadMcpRegistry(home, join(dataDir, "mcp.json"));
  sandboxRegistry(registry, home, dataDir);
  // Model ids resolve through the registry: honor a persisted HEMIUNU_MODEL /
  // HEMIUNU_MODEL_RESEARCH when it names a USABLE entry, else start on the
  // first available model (any provider — nothing Anthropic-specific).
  const modelRegistry = loadModelRegistry();
  const model = resolveDefaultModel(modelRegistry, process.env, process.env.HEMIUNU_MODEL);
  const researchModel = resolveDefaultModel(
    modelRegistry,
    process.env,
    process.env.HEMIUNU_MODEL_RESEARCH,
    "research",
  );
  const contextRoots = { appRoot: home, userRoot: dataDir };
  seedContextFiles(contextRoots);
  const baseSystemPrompt = buildSystemPrompt(loadContext(contextRoots));

  const fsName = findFsName(registry.mcpServers);

  // The engine runtime shares the same SQLite file as the ConversationStore
  // (its TranscriptStore adds transcript/compactions tables alongside the
  // conversations/messages the history routes read). Compaction happens
  // engine-side automatically; the MCP host refreshes OAuth bearers itself.
  const engine = createEngineRuntime({ mcpServers: registry.mcpServers });

  rt = { store, registry, baseSystemPrompt, model, researchModel, fsName, engine };
  return rt;
}

function findFsName(mcpServers: Record<string, unknown>): string | undefined {
  const servers = mcpServers as Record<string, { args?: unknown[] }>;
  return Object.keys(servers).find(
    (n) =>
      n === "filesystem" ||
      ((servers[n]?.args ?? []) as unknown[]).some(
        (a) => typeof a === "string" && a.includes("server-filesystem"),
      ),
  );
}

/**
 * Re-read mcp.json (app default + ~/.hemiunu overlay) and swap it into the live
 * runtime, rebuilding the engine runtime so its MCP host knows the new server
 * set — a server added via the UI takes effect on the NEXT turn, no worker
 * restart needed. The old runtime is shut down in the background (its transcript
 * store is a separate connection to the same SQLite file, so closing it never
 * affects the new one). Also used after gateway models are added to
 * ~/.hemiunu/models.json — createEngineRuntime re-reads the model registry, so
 * the new entries are selectable on the next turn. When nothing has booted yet
 * this is a no-op: the eventual boot reads fresh config anyway.
 */
export function reloadRegistry(): void {
  if (!rt) return;
  const r = rt;
  const home = process.env.HEMIUNU_HOME ?? join(import.meta.dirname, "..", "..", "..", "..");
  r.registry = loadMcpRegistry(home, join(configDir(), "mcp.json"));
  sandboxRegistry(r.registry, home, configDir());
  r.fsName = findFsName(r.registry.mcpServers);
  const old = r.engine;
  r.engine = createEngineRuntime({ mcpServers: r.registry.mcpServers });
  void old.shutdown().catch(() => {});
}

/**
 * Confine spawned stdio MCP servers to ~/.hemiunu/tmp/mcp/<name> so a server
 * that writes relative files (e.g. Playwright snapshots) can't litter the
 * user's launch folder. Mutates the registry in place. Mirrors the CLI.
 */
function sandboxRegistry(
  registry: ReturnType<typeof loadMcpRegistry>,
  home: string,
  dataDir: string,
): void {
  registry.mcpServers = sandboxStdioCwd(registry.mcpServers, {
    shimPath: join(home, "bin", "mcp-in-dir.mjs"),
    rootDir: join(dataDir, "tmp", "mcp"),
  });
}

/**
 * Change the brain model for subsequent turns (turn.ts reads `rt.model`), so a
 * model switch from the UI takes effect immediately — no worker restart. The
 * persisted HEMIUNU_MODEL (written by the settings route) keeps it across boots.
 */
export function setRuntimeModel(model: string): void {
  bootRuntime().model = model;
}

/**
 * Change the research-tier model (researcher subagent) for subsequent turns.
 * Persisted as HEMIUNU_MODEL_RESEARCH by the settings route.
 */
export function setRuntimeResearchModel(model: string): void {
  bootRuntime().researchModel = model;
}

/**
 * Servers + tool patterns active for this turn. The filesystem server is only
 * exposed once the launch folder is trusted (mirrors the CLI's fsOn gate); trust
 * defaults to off (null → excluded) until the user allows it.
 */
export function activeMcp(r: Runtime): {
  servers: Record<string, unknown>;
  patterns: string[];
} {
  const trusted = r.fsName ? r.store.getFolderTrust(process.cwd()) === true : true;
  if (trusted || !r.fsName) {
    return { servers: r.registry.mcpServers, patterns: r.registry.toolPatterns };
  }
  return {
    servers: Object.fromEntries(
      Object.entries(r.registry.mcpServers).filter(([n]) => n !== r.fsName),
    ),
    patterns: r.registry.toolPatterns.filter((p) => !p.startsWith(`mcp__${r.fsName}__`)),
  };
}

/**
 * System prompt for a turn = base (soul + user) + a note of the data sources
 * connected right now, so the agent grounds answers in them. (Skills, source
 * maps and compacted summary — present in the CLI's effectiveSystem — are
 * deferred to a later increment.)
 */
export function effectiveSystem(r: Runtime, serverNames: string[]): string {
  if (!serverNames.length) return r.baseSystemPrompt;
  const sources = `\n\n## Connected data sources\nThese tools/data sources are connected right now: ${serverNames.join(
    ", ",
  )}. When asked about anything you can't answer from general knowledge, search them before responding, and ground your answer in what you find.`;
  return r.baseSystemPrompt + sources;
}

/** The team this turn pins to (the persisted global selection). */
export function turnRepo(): string | null {
  return currentTeam() || null;
}
