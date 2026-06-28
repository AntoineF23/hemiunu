import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

// --- mcp.json schema (standard `mcpServers` shape) ---

const StdioServer = z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
});

const RemoteServer = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
});

/**
 * Infer a missing `type` from the config shape, matching the de-facto standard
 * MCP config (Claude Desktop, and what every server's docs paste): a `command`
 * means stdio, a `url` means http. Without this, pasting a normal config like
 * `{ "command": "npx", "args": ["@playwright/mcp@latest"] }` would be rejected
 * for lacking an explicit `type`.
 */
function inferType(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (o.type === undefined) {
      if (typeof o.command === "string") return { ...o, type: "stdio" };
      if (typeof o.url === "string") return { ...o, type: "http" };
    }
  }
  return raw;
}

const ServerConfig = z.preprocess(
  inferType,
  z.discriminatedUnion("type", [StdioServer, RemoteServer]),
);
const McpFile = z.object({
  mcpServers: z.record(z.string(), ServerConfig).default({}),
});

/** A single MCP server entry (stdio or http/sse), as stored in mcp.json. */
export type McpServerConfig = z.infer<typeof ServerConfig>;

export interface LoadedRegistry {
  /** Server configs ready to pass to the SDK `mcpServers` option. */
  mcpServers: Record<string, unknown>;
  /** Tool-availability wildcards, one per enabled server: `mcp__<name>__*`. */
  toolPatterns: string[];
  /** Servers that were skipped, with the reason (disabled / missing env). */
  skipped: { name: string; reason: string }[];
}

const ENV_RE = /\$\{([A-Za-z0-9_]+)\}/g;

/** Replace ${VAR} in a string; record any unresolved vars. */
function interpolate(value: string, missing: Set<string>): string {
  return value.replace(ENV_RE, (_, name: string) => {
    // ${CWD} / ${PWD} resolve to the directory Hemiunu was launched in.
    const v = name === "CWD" || name === "PWD" ? process.cwd() : process.env[name];
    if (v === undefined || v === "") {
      missing.add(name);
      return "";
    }
    return v;
  });
}

/** Deep-interpolate ${VAR} across strings/arrays/objects. */
function interpolateDeep<T>(node: T, missing: Set<string>): T {
  if (typeof node === "string") return interpolate(node, missing) as T;
  if (Array.isArray(node)) {
    return node.map((n) => interpolateDeep(n, missing)) as T;
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = interpolateDeep(v, missing);
    }
    return out as T;
  }
  return node;
}

/**
 * Load mcp.json from the project root into SDK-ready server configs.
 * Servers are skipped if `disabled` or if any referenced ${ENV} var is unset.
 */
function readServers(path: string): Record<string, z.infer<typeof ServerConfig>> {
  if (!existsSync(path)) return {};
  return McpFile.parse(JSON.parse(readFileSync(path, "utf8"))).mcpServers;
}

/**
 * Load the MCP registry from `<root>/mcp.json` (the app default), optionally
 * merged with a user overlay (`userMcpPath`, e.g. `~/.hemiunu/mcp.json`). User
 * entries override/extend the defaults by name — so updates to the app never
 * clobber a user's own servers, and users add servers without touching the code.
 */
export function loadMcpRegistry(
  root: string = process.cwd(),
  userMcpPath?: string,
): LoadedRegistry {
  const result: LoadedRegistry = { mcpServers: {}, toolPatterns: [], skipped: [] };
  const merged = {
    ...readServers(join(root, "mcp.json")),
    ...(userMcpPath ? readServers(userMcpPath) : {}),
  };

  for (const [name, raw] of Object.entries(merged)) {
    if (raw.disabled) {
      result.skipped.push({ name, reason: "disabled" });
      continue;
    }
    const missing = new Set<string>();
    const { disabled: _omit, ...rest } = raw;
    const config = interpolateDeep(rest, missing);
    if (missing.size > 0) {
      result.skipped.push({
        name,
        reason: `missing env: ${[...missing].join(", ")}`,
      });
      continue;
    }
    result.mcpServers[name] = config;
    result.toolPatterns.push(`mcp__${name}__*`);
  }

  return result;
}

// --- Working-directory sandbox for spawned stdio servers ---

export interface SandboxCwdOptions {
  /** Absolute path to the node shim (bin/mcp-in-dir.mjs) that chdir's then execs. */
  shimPath: string;
  /** Root under which each server gets its own throwaway cwd (rootDir/<name>). */
  rootDir: string;
  /** Extra server names to leave rooted at the launch dir (the filesystem server is always exempt). */
  exclude?: string[];
}

/**
 * The filesystem server is the one server meant to touch the launch folder
 * (reading the user's project is its job), so it's never sandboxed. Detect it
 * by the standard name or by the `server-filesystem` package in its args — the
 * same test the web runtime uses to gate it behind folder-trust.
 */
function isFilesystemServer(name: string, args: unknown[]): boolean {
  return (
    name === "filesystem" ||
    args.some((a) => typeof a === "string" && a.includes("server-filesystem"))
  );
}

/**
 * Confine each spawned stdio MCP server to a throwaway working directory so any
 * files it writes with relative paths (e.g. Playwright's `.playwright-mcp/`)
 * land in `rootDir/<name>` — never the user's launch folder. The SDK exposes no
 * per-server `cwd`, so we rewrite the command to launch via a node shim that
 * chdir's first (see bin/mcp-in-dir.mjs). Remote (http/sse) servers aren't
 * spawned and pass through unchanged; so do the filesystem server and anything
 * named in `exclude`.
 */
export function sandboxStdioCwd(
  servers: Record<string, unknown>,
  { shimPath, rootDir, exclude = [] }: SandboxCwdOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const c = cfg as Record<string, unknown>;
    const realArgs = Array.isArray(c.args) ? (c.args as string[]) : [];
    const isStdio = typeof c.command === "string";
    if (!isStdio || exclude.includes(name) || isFilesystemServer(name, realArgs)) {
      out[name] = cfg;
      continue;
    }
    out[name] = {
      ...c,
      command: process.execPath,
      args: [shimPath, join(rootDir, name), c.command as string, ...realArgs],
    };
  }
  return out;
}

// --- User overlay editing (so a UI can add servers without hand-editing JSON) ---

/** Validate one server config; throws a readable error if it's malformed. */
export function parseServerConfig(raw: unknown): McpServerConfig {
  return ServerConfig.parse(raw);
}

/**
 * The filesystem server is a BUILT-IN capability (it grants the agent access to
 * the launch folder), not a user-added integration. Detect it — by name or by
 * the `server-filesystem` package in its args — so the UI can treat it as a
 * built-in: gate it behind folder-trust and hide it from the "connected MCP
 * servers" list, where it would only confuse non-technical users.
 */
export function isBuiltinServer(name: string, config?: unknown): boolean {
  if (name === "filesystem") return true;
  const args = (config as { args?: unknown[] } | undefined)?.args;
  return (
    Array.isArray(args) &&
    args.some((a) => typeof a === "string" && a.includes("server-filesystem"))
  );
}

/** Read the raw (un-interpolated) server map from a user mcp.json overlay. */
export function readUserServers(path: string): Record<string, McpServerConfig> {
  return readServers(path);
}

function writeUserServers(path: string, servers: Record<string, McpServerConfig>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
}

/** Add or replace a server in the user overlay (creates the file if needed). */
export function upsertUserServer(path: string, name: string, config: McpServerConfig): void {
  const servers = readUserServers(path);
  servers[name] = config;
  writeUserServers(path, servers);
}

/** Remove a server from the user overlay. Returns false if it wasn't there. */
export function removeUserServer(path: string, name: string): boolean {
  const servers = readUserServers(path);
  if (!(name in servers)) return false;
  delete servers[name];
  writeUserServers(path, servers);
  return true;
}
