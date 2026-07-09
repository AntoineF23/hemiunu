// McpHost — the engine's MCP client host, built directly on
// @modelcontextprotocol/sdk (one `Client` per registry server, stdio/http/sse
// transports). It consumes the @hemiunu/mcp registry's SDK-ready server map
// (structurally — the engine imports nothing from the workspace) and exposes
// every remote tool as a HemiTool named `mcp__<server>__<tool>`, carrying the
// server's RAW JSON Schema (never round-tripped through zod — see tool.ts's
// JsonSchemaInput seam). External tools run through the same permission
// pipeline as everything else, defaulting to "ask".
//
// Auth: an injectable async `headers` supplier (agent-core wires its
// mcp-oauth bearerFor here) is consulted at connect time AND before every
// tool call — the transport reads the shared mutable headers record per
// request, so a refreshed bearer applies without reconnecting. A call that
// still fails with 401 triggers one reconnect (fresh headers, fresh
// transport) and a single retry.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolOutput } from "./events";
import type { HemiTool } from "./tool";

/** One MCP server config, structurally matching @hemiunu/mcp's registry output. */
interface ServerSpec {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type McpTransportKind = "stdio" | "http" | "sse";
export type McpConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** One tool as reported by a server's `tools/list` (panel-friendly shape). */
export interface McpToolInfo {
  /** Bare tool name as the server reports it (e.g. "notion-search"). */
  name: string;
  description?: string;
  /** The tool's input schema, raw JSON Schema off the wire. */
  inputSchema?: Record<string, unknown>;
  /** Server hint: the tool may make irreversible changes. */
  destructive?: boolean;
  /** Server hint: the tool only reads, never writes. */
  readOnly?: boolean;
}

/** Panel/registry view of one configured server. */
export interface McpServerStatus {
  name: string;
  transport: McpTransportKind;
  state: McpConnectionState;
  /** Why the connection failed (state "error"). */
  error?: string;
  /** The server's tools, once listed (undefined until connected). */
  tools?: McpToolInfo[];
}

/** The subset of the SDK Client the host uses — injectable for tests. */
export interface McpClientLike {
  connect(transport: Transport, options?: { timeout?: number }): Promise<void>;
  listTools(
    params?: undefined,
    options?: { timeout?: number },
  ): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
    }>;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpHostOptions {
  /** SDK-ready server map — @hemiunu/mcp's LoadedRegistry.mcpServers. */
  servers: Record<string, unknown>;
  /**
   * Extra headers for a remote server (OAuth bearer). Consulted at connect
   * time and refreshed before EVERY tool call — the supplier owns caching and
   * token refresh (agent-core's mcp-oauth bearerFor refreshes near expiry).
   */
  headers?: (server: string) => Promise<Record<string, string> | undefined>;
  /** Connect + tools/list timeout (cold `npx` downloads are slow). */
  connectTimeoutMs?: number;
  /** Per tool call timeout. */
  callTimeoutMs?: number;
  /** Test seam: build the MCP client (default: the real SDK Client). */
  clientFactory?: (server: string) => McpClientLike;
  /** Test seam: build the transport (default: stdio/http/sse per config). */
  transportFactory?: (spec: unknown, headers: Record<string, string>) => Transport;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 90_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** A clean string-only env (process.env minus undefined) merged with the server's own. */
function mergedEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return { ...out, ...(extra ?? {}) };
}

function transportKind(spec: ServerSpec): McpTransportKind {
  if (typeof spec.command === "string") return "stdio";
  return spec.type === "sse" ? "sse" : "http";
}

/** Does this error look like an HTTP 401 (expired/revoked bearer)? Covers the
 *  SDK's SseError (`code`) and the StreamableHTTP "(HTTP 401)" messages. */
export function isUnauthorizedError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (code === 401) return true;
  return typeof message === "string" && (/\b401\b/.test(message) || /unauthorized/i.test(message));
}

/** Flatten an MCP CallToolResult into the engine's ToolOutput. */
function toToolOutput(result: unknown): ToolOutput {
  const r = (result ?? {}) as { content?: unknown; isError?: unknown };
  const blocks = Array.isArray(r.content) ? r.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const b = (block ?? {}) as { type?: unknown; text?: unknown; data?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (typeof b.type === "string") parts.push(`[${b.type} content]`);
  }
  return { content: parts.join("\n"), isError: r.isError === true || undefined };
}

interface Connection {
  spec: ServerSpec;
  kind: McpTransportKind;
  state: McpConnectionState;
  error?: string;
  client?: McpClientLike;
  /** Mutable headers record shared with the transport's requestInit — updating
   *  it in place applies a refreshed bearer to the NEXT request, no reconnect. */
  headers: Record<string, string>;
  tools?: McpToolInfo[];
  /** In-flight connect, so concurrent calls share one handshake. */
  connecting?: Promise<void>;
}

export class McpHost {
  private readonly opts: McpHostOptions;
  private readonly connections = new Map<string, Connection>();

  constructor(opts: McpHostOptions) {
    this.opts = opts;
    for (const [name, raw] of Object.entries(opts.servers)) {
      const spec = (raw ?? {}) as ServerSpec;
      this.connections.set(name, {
        spec,
        kind: transportKind(spec),
        state: "disconnected",
        headers: {},
      });
    }
  }

  /** Panel/registry enumeration: every configured server with its status. */
  listServers(): McpServerStatus[] {
    return [...this.connections.entries()].map(([name, c]) => ({
      name,
      transport: c.kind,
      state: c.state,
      error: c.error,
      tools: c.tools,
    }));
  }

  /** One server's status (undefined if not configured). */
  status(name: string): McpServerStatus | undefined {
    return this.listServers().find((s) => s.name === name);
  }

  /** Connect one server (idempotent; concurrent callers share the handshake). */
  async connect(name: string): Promise<void> {
    const conn = this.mustHave(name);
    if (conn.state === "connected") return;
    if (!conn.connecting) {
      conn.connecting = this.doConnect(name, conn).finally(() => {
        conn.connecting = undefined;
      });
    }
    return conn.connecting;
  }

  /** Connect every configured server; failures land in status(), never throw. */
  async connectAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((name) => this.connect(name)));
  }

  /**
   * Every connected server's tools as HemiTools named `mcp__<server>__<tool>`,
   * carrying the server's raw JSON Schema. No `permission` is set, so the
   * pipeline's default — "ask" — gates every external tool.
   */
  async listTools(): Promise<HemiTool[]> {
    await this.connectAll();
    const tools: HemiTool[] = [];
    for (const [server, conn] of this.connections) {
      if (conn.state !== "connected" || !conn.tools) continue;
      for (const info of conn.tools) {
        tools.push(this.toHemiTool(server, info));
      }
    }
    return tools;
  }

  /** One server's tools (connecting on demand) — for the MCP panel. */
  async listServerTools(name: string): Promise<McpToolInfo[]> {
    await this.connect(name);
    return this.mustHave(name).tools ?? [];
  }

  /** Call a tool on a server: bearer refresh first, one reconnect+retry on 401. */
  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<ToolOutput> {
    await this.connect(server);
    const conn = this.mustHave(server);
    if (conn.state !== "connected" || !conn.client) {
      throw new Error(
        `MCP server '${server}' is not connected${conn.error ? `: ${conn.error}` : ""}.`,
      );
    }
    await this.refreshHeaders(server, conn);
    const timeout = this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      const result = await conn.client.callTool({ name: tool, arguments: args }, undefined, {
        timeout,
      });
      return toToolOutput(result);
    } catch (e) {
      if (!isUnauthorizedError(e)) throw e;
      // The bearer was refused mid-session (refresh alone wasn't enough — the
      // stream itself may be dead): reconnect with fresh headers, retry once.
      await this.reconnect(server);
      const retry = this.mustHave(server);
      if (retry.state !== "connected" || !retry.client) throw e;
      const result = await retry.client.callTool({ name: tool, arguments: args }, undefined, {
        timeout,
      });
      return toToolOutput(result);
    }
  }

  /** Drop a server's connection and connect from scratch (fresh headers). */
  async reconnect(name: string): Promise<void> {
    const conn = this.mustHave(name);
    await conn.client?.close().catch(() => {});
    conn.client = undefined;
    conn.state = "disconnected";
    conn.error = undefined;
    await this.connect(name);
  }

  /** Close every client (shutdown). */
  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.client?.close().catch(() => {});
      conn.client = undefined;
      if (conn.state === "connected" || conn.state === "connecting") conn.state = "disconnected";
    }
  }

  // --- internals --------------------------------------------------------------

  private mustHave(name: string): Connection {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`Unknown MCP server '${name}'.`);
    return conn;
  }

  /** Re-consult the header supplier and update the shared record IN PLACE, so
   *  the live transport's next request carries the fresh bearer. */
  private async refreshHeaders(name: string, conn: Connection): Promise<void> {
    if (!this.opts.headers || conn.kind === "stdio") return;
    const fresh = { ...(conn.spec.headers ?? {}), ...((await this.opts.headers(name)) ?? {}) };
    for (const k of Object.keys(conn.headers)) {
      if (!(k in fresh)) delete conn.headers[k];
    }
    Object.assign(conn.headers, fresh);
  }

  private async doConnect(name: string, conn: Connection): Promise<void> {
    conn.state = "connecting";
    conn.error = undefined;
    try {
      conn.headers = { ...(conn.spec.headers ?? {}) };
      await this.refreshHeaders(name, conn);
      const transport = (this.opts.transportFactory ?? defaultTransport)(conn.spec, conn.headers);
      const client =
        this.opts.clientFactory?.(name) ??
        (new Client({ name: "hemiunu", version: "0" }) as McpClientLike);
      const timeout = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      await client.connect(transport, { timeout });
      const listed = await client.listTools(undefined, { timeout });
      conn.client = client;
      conn.tools = listed.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema:
          typeof t.inputSchema === "object" && t.inputSchema !== null
            ? (t.inputSchema as Record<string, unknown>)
            : undefined,
        destructive: t.annotations?.destructiveHint,
        readOnly: t.annotations?.readOnlyHint,
      }));
      conn.state = "connected";
    } catch (e) {
      conn.state = "error";
      conn.error = e instanceof Error ? e.message : String(e);
      conn.client = undefined;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private toHemiTool(server: string, info: McpToolInfo): HemiTool {
    return {
      name: `mcp__${server}__${info.name}`,
      description: info.description ?? `${info.name} (MCP tool on ${server})`,
      inputSchema: { jsonSchema: info.inputSchema ?? { type: "object" } },
      readOnly: info.readOnly === true,
      execute: (input): Promise<ToolOutput> => {
        const args =
          typeof input === "object" && input !== null && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        return this.callTool(server, info.name, args);
      },
    };
  }
}

/** Build the real SDK transport for a server spec (stdio / http / sse). The
 *  `headers` record is shared by reference: McpHost mutates it per call, and
 *  the transports read requestInit.headers per request. */
function defaultTransport(rawSpec: unknown, headers: Record<string, string>): Transport {
  const spec = (rawSpec ?? {}) as ServerSpec;
  if (typeof spec.command === "string") {
    return new StdioClientTransport({
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args : [],
      env: mergedEnv(spec.env),
      stderr: "ignore",
    });
  }
  if (typeof spec.url === "string") {
    const url = new URL(spec.url);
    const opts = { requestInit: { headers } };
    return spec.type === "sse"
      ? new SSEClientTransport(url, opts)
      : new StreamableHTTPClientTransport(url, opts);
  }
  throw new Error("MCP server config needs either a `command` (stdio) or a `url` (http/sse).");
}
