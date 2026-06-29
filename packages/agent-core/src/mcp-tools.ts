import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Enumerate the FULL tool list a configured MCP server exposes, WITHOUT running
 * an agent turn — so the MCP panel can show every tool up front (not just the
 * ones that happen to have been called) and the user can set allow/block/ask on
 * each. Opens a short-lived MCP client, calls `tools/list`, and closes it.
 *
 * Token-free and deterministic (no model call). Returns `null` on any failure
 * (unreachable, needs-auth, cold-start timeout) rather than throwing — the panel
 * treats that as "couldn't list yet" and offers a manual retry.
 */

/** One tool as reported by an MCP server's `tools/list`. */
export interface McpToolInfo {
  /** Bare tool name as the server reports it (e.g. "notion-search"). */
  name: string;
  description?: string;
  /** Server hint: the tool may make irreversible changes. */
  destructive?: boolean;
  /** Server hint: the tool only reads, never writes. */
  readOnly?: boolean;
}

/** Cold `npx` downloads can be slow on first run — give enumeration room. */
const DEFAULT_ENUMERATE_TIMEOUT_MS = 90_000;

/** A clean string-only env (process.env minus undefined) merged with the server's own env. */
function mergedEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return { ...out, ...(extra ?? {}) };
}

/** Build the right transport for a server config (the registry's SDK-ready shape). */
function transportFor(config: unknown): Transport | null {
  const c = (config ?? {}) as {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  // stdio (a local command) — use the config exactly as the SDK would run it,
  // including the cwd-sandbox shim already applied in the registry.
  if (typeof c.command === "string") {
    return new StdioClientTransport({
      command: c.command,
      args: Array.isArray(c.args) ? c.args : [],
      env: mergedEnv(c.env),
      stderr: "ignore",
    });
  }
  // remote (http/sse) — pass any headers (incl. an injected OAuth bearer).
  if (typeof c.url === "string") {
    const url = new URL(c.url);
    const opts = c.headers ? { requestInit: { headers: c.headers } } : undefined;
    return c.type === "sse"
      ? new SSEClientTransport(url, opts)
      : new StreamableHTTPClientTransport(url, opts);
  }
  return null;
}

export async function enumerateServerTools(
  config: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<McpToolInfo[] | null> {
  const transport = transportFor(config);
  if (!transport) return null;
  const timeout = opts.timeoutMs ?? DEFAULT_ENUMERATE_TIMEOUT_MS;
  const client = new Client({ name: "hemiunu-tool-lister", version: "0" });
  try {
    await client.connect(transport, { timeout });
    const res = await client.listTools(undefined, { timeout });
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      destructive: t.annotations?.destructiveHint,
      readOnly: t.annotations?.readOnlyHint,
    }));
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
