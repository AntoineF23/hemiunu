import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpHost, isUnauthorizedError, type McpClientLike } from "./mcp-host";
import { isJsonSchemaInput, validateToolInput } from "./tool";
import type { ToolContext } from "./tool";

// --- fixtures -------------------------------------------------------------------

const SEARCH_SCHEMA = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "number" } },
  required: ["query"],
};

interface MockClient extends McpClientLike {
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  closed: boolean;
}

function mockClient(opts: { failCallsWith?: unknown; tools?: unknown[] } = {}): MockClient {
  const client: MockClient = {
    calls: [],
    closed: false,
    async connect() {},
    async listTools() {
      return {
        tools: (opts.tools ?? [
          {
            name: "search",
            description: "Search things",
            inputSchema: SEARCH_SCHEMA,
            annotations: { readOnlyHint: true },
          },
          { name: "create-page", inputSchema: { type: "object" } },
        ]) as Awaited<ReturnType<McpClientLike["listTools"]>>["tools"],
      };
    },
    async callTool(params) {
      client.calls.push(params);
      if (opts.failCallsWith !== undefined) throw opts.failCallsWith;
      return { content: [{ type: "text", text: `ran ${params.name}` }] };
    },
    async close() {
      client.closed = true;
    },
  };
  return client;
}

const fakeTransport = () =>
  ({ start: async () => {}, close: async () => {}, send: async () => {} }) as unknown as Transport;

function ctx(): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "test",
    emit: () => {},
    mode: () => "default",
    setMode: () => {},
  };
}

// --- tool naming + JSON Schema seam ----------------------------------------------

test("McpHost.listTools: names tools mcp__<server>__<tool> and carries raw JSON Schema", async () => {
  const client = mockClient();
  const host = new McpHost({
    servers: { notion: { type: "http", url: "https://mcp.example/notion" } },
    clientFactory: () => client,
    transportFactory: fakeTransport,
  });

  const tools = await host.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["mcp__notion__search", "mcp__notion__create-page"],
  );

  const search = tools[0];
  assert.ok(isJsonSchemaInput(search.inputSchema), "MCP tools carry the raw-JSON-Schema variant");
  // The schema is passed through verbatim — never round-tripped through zod.
  assert.deepEqual(search.inputSchema.jsonSchema, SEARCH_SCHEMA);
  assert.equal(search.readOnly, true);
  assert.equal(search.permission, undefined, "external tools default to the pipeline's 'ask'");
  assert.equal(tools[1].readOnly, false);

  // execute routes to callTool with the BARE tool name.
  const out = await search.execute({ query: "hello" }, ctx());
  assert.deepEqual(client.calls, [{ name: "search", arguments: { query: "hello" } }]);
  assert.equal(out.content, "ran search");
  assert.equal(out.isError, undefined);
});

test("validateToolInput: raw JSON Schema checks object-ness and required keys only", () => {
  const schema = { jsonSchema: SEARCH_SCHEMA };
  const ok = validateToolInput(schema, { query: "x", extra: true });
  assert.deepEqual(ok, { ok: true, data: { query: "x", extra: true } });

  const missing = validateToolInput(schema, { limit: 3 });
  assert.equal(missing.ok, false);
  assert.match((missing as { issues: string }).issues, /query: required/);

  const notObject = validateToolInput(schema, "nope");
  assert.equal(notObject.ok, false);
  assert.match((notObject as { issues: string }).issues, /expected an object/);

  // A non-object top-level schema passes anything through.
  assert.equal(validateToolInput({ jsonSchema: { type: "string" } }, "fine").ok, true);
});

test("McpHost: panel enumeration reports transport, status, and tools", async () => {
  const host = new McpHost({
    servers: {
      files: { type: "stdio", command: "npx", args: ["files-mcp"] },
      figma: { type: "sse", url: "https://mcp.example/figma" },
    },
    clientFactory: () => mockClient(),
    transportFactory: fakeTransport,
  });

  assert.deepEqual(
    host.listServers().map((s) => [s.name, s.transport, s.state]),
    [
      ["files", "stdio", "disconnected"],
      ["figma", "sse", "disconnected"],
    ],
  );

  const tools = await host.listServerTools("figma");
  assert.deepEqual(
    tools.map((t) => t.name),
    ["search", "create-page"],
  );
  assert.equal(host.status("figma")?.state, "connected");
  assert.equal(host.status("files")?.state, "disconnected");
});

test("McpHost: a failing connect lands in status() as an error, connectAll never throws", async () => {
  const host = new McpHost({
    servers: { broken: { type: "http", url: "https://mcp.example/broken" } },
    clientFactory: () => ({
      ...mockClient(),
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    transportFactory: fakeTransport,
  });
  await host.connectAll();
  assert.equal(host.status("broken")?.state, "error");
  assert.match(host.status("broken")?.error ?? "", /ECONNREFUSED/);
  assert.deepEqual(await host.listTools(), []);
});

// --- bearer refresh per call ------------------------------------------------------

test("McpHost: the header supplier is consulted per call and updates the live headers", async () => {
  let token = "token-1";
  const seen: Array<Record<string, string>> = [];
  let liveHeaders: Record<string, string> | undefined;
  const client = mockClient();

  const host = new McpHost({
    servers: {
      figma: { type: "http", url: "https://mcp.example/figma", headers: { "X-Base": "1" } },
    },
    headers: async () => {
      seen.push({});
      return { Authorization: `Bearer ${token}` };
    },
    clientFactory: () => client,
    transportFactory: (_spec, headers) => {
      liveHeaders = headers; // the transport keeps this record by reference
      return fakeTransport();
    },
  });

  await host.connect("figma");
  assert.deepEqual(liveHeaders, { "X-Base": "1", Authorization: "Bearer token-1" });

  token = "token-2";
  await host.callTool("figma", "search", { query: "x" });
  // Refreshed IN PLACE before the call — no reconnect needed.
  assert.deepEqual(liveHeaders, { "X-Base": "1", Authorization: "Bearer token-2" });
  assert.equal(seen.length, 2, "supplier ran at connect and again before the call");
});

// --- reconnect on 401 --------------------------------------------------------------

test("isUnauthorizedError: matches HTTP 401 messages and code 401, nothing else", () => {
  assert.equal(isUnauthorizedError(new Error("Error POSTing to endpoint (HTTP 401): nope")), true);
  assert.equal(isUnauthorizedError(new Error("Unauthorized")), true);
  assert.equal(isUnauthorizedError({ code: 401, message: "SSE error" }), true);
  assert.equal(isUnauthorizedError(new Error("HTTP 500 server error")), false);
  assert.equal(isUnauthorizedError("401"), false);
});

test("McpHost: a 401 mid-session reconnects with fresh headers and retries once", async () => {
  const stale = mockClient({
    failCallsWith: new Error("Error POSTing to endpoint (HTTP 401): expired"),
  });
  const fresh = mockClient();
  const clients = [stale, fresh];
  let supplierRuns = 0;

  const host = new McpHost({
    servers: { figma: { type: "http", url: "https://mcp.example/figma" } },
    headers: async () => {
      supplierRuns++;
      return { Authorization: `Bearer t${supplierRuns}` };
    },
    clientFactory: () => clients.shift()!,
    transportFactory: fakeTransport,
  });

  const out = await host.callTool("figma", "search", { query: "x" });
  assert.equal(out.content, "ran search");
  assert.equal(stale.calls.length, 1, "first client got the failing call");
  assert.equal(stale.closed, true, "stale client was closed on reconnect");
  assert.equal(fresh.calls.length, 1, "retry ran on the reconnected client");
  // connect + pre-call refresh + reconnect + pre-retry... supplier ran on the new handshake too.
  assert.ok(supplierRuns >= 3, "supplier re-ran for the reconnect");
  assert.equal(host.status("figma")?.state, "connected");
});

test("McpHost: non-401 errors surface without a reconnect", async () => {
  const client = mockClient({ failCallsWith: new Error("HTTP 500 boom") });
  const host = new McpHost({
    servers: { figma: { type: "http", url: "https://mcp.example/figma" } },
    clientFactory: () => client,
    transportFactory: fakeTransport,
  });
  await assert.rejects(() => host.callTool("figma", "search", {}), /HTTP 500 boom/);
  assert.equal(client.closed, false);
});

test("McpHost: MCP error results map to isError ToolOutputs", async () => {
  const client = mockClient();
  client.callTool = async () => ({
    content: [{ type: "text", text: "tool exploded" }],
    isError: true,
  });
  const host = new McpHost({
    servers: { notion: { type: "http", url: "https://mcp.example/notion" } },
    clientFactory: () => client,
    transportFactory: fakeTransport,
  });
  const [search] = await host.listTools();
  const out = await search.execute({ query: "x" }, ctx());
  assert.equal(out.isError, true);
  assert.equal(out.content, "tool exploded");
});
