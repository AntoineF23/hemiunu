// Boot-time engine state, assembled once and shared by all routes. Mirrors the
// CLI's main() bootstrap (apps/cli/src/index.tsx:1812) — same files, same dirs —
// so the web worker and the CLI read identical config/state.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir, currentTeam, setLocalSession } from "@hemiunu/agent-core";
import { loadMcpRegistry } from "@hemiunu/mcp";
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
  model: string;
  /** The filesystem MCP server name, if one is configured (gated by folder trust). */
  fsName: string | undefined;
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
  const model = process.env.HEMIUNU_MODEL ?? "claude-opus-4.8";
  const contextRoots = { appRoot: home, userRoot: dataDir };
  seedContextFiles(contextRoots);
  const baseSystemPrompt = buildSystemPrompt(loadContext(contextRoots));

  const servers = registry.mcpServers as Record<string, { args?: unknown[] }>;
  const fsName = Object.keys(servers).find(
    (n) =>
      n === "filesystem" ||
      ((servers[n]?.args ?? []) as unknown[]).some(
        (a) => typeof a === "string" && a.includes("server-filesystem"),
      ),
  );

  rt = { store, registry, baseSystemPrompt, model, fsName };
  return rt;
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
