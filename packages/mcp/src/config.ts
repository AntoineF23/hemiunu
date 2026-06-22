import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

const ServerConfig = z.discriminatedUnion("type", [StdioServer, RemoteServer]);
const McpFile = z.object({
  mcpServers: z.record(z.string(), ServerConfig).default({}),
});

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
    const v =
      name === "CWD" || name === "PWD" ? process.cwd() : process.env[name];
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
