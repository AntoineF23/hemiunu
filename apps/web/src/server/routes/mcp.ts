// MCP control for the web UI: list every configured MCP server (connected +
// skipped), read/set the per-server and per-tool permission policy (allow / ask
// / block), and view or refresh each server's /scan source-map (.md).
import { Hono } from "hono";
import {
  loadSourceMap,
  loadSourceMaps,
  loadToolPolicy,
  runScan,
  setServerPolicy,
  setToolPolicy,
  type ToolPolicy,
} from "@hemiunu/agent-core";
import { bootRuntime } from "../runtime";

export const mcpRoute = new Hono();

const POLICIES = new Set<ToolPolicy>(["allow", "ask", "block"]);

mcpRoute.get("/api/mcp", (c) => {
  const rt = bootRuntime();
  const policy = loadToolPolicy();
  const maps = new Map(loadSourceMaps().map((m) => [m.mcp, m]));
  const connected = Object.keys(rt.registry.mcpServers).sort();
  // `skipped` is `{ name, reason }[]` (servers omitted for missing env / disabled).
  const skipped = (rt.registry.skipped ?? []) as { name: string; reason?: string }[];

  const describe = (name: string, isConnected: boolean, reason?: string) => {
    const sm = maps.get(name);
    return {
      name,
      connected: isConnected,
      reason: reason ?? null,
      serverPolicy: policy.servers[name] ?? "ask",
      tools: (policy.seen[name] ?? []).map((id) => ({
        id,
        policy: policy.tools[id] ?? "ask",
      })),
      sourceMap: sm ? { description: sm.description, scanned: sm.scanned ?? null } : null,
    };
  };

  return c.json({
    servers: [
      ...connected.map((n) => describe(n, true)),
      ...skipped.map((s) => describe(s.name, false, s.reason)),
    ],
  });
});

// Set a server-default or single-tool policy. scope: "server" | "tool".
mcpRoute.post("/api/mcp/policy", async (c) => {
  const { scope, key, policy } = (await c.req.json().catch(() => ({}))) as {
    scope?: string;
    key?: string;
    policy?: ToolPolicy;
  };
  if (!key || !policy || !POLICIES.has(policy)) return c.json({ error: "Bad request." }, 400);
  if (scope === "server") setServerPolicy(key, policy);
  else if (scope === "tool") setToolPolicy(key, policy);
  else return c.json({ error: "scope must be 'server' or 'tool'." }, 400);
  return c.json({ ok: true });
});

mcpRoute.get("/api/mcp/:name/sourcemap", (c) => {
  const m = loadSourceMap(c.req.param("name"));
  if (!m) return c.json({ exists: false, body: "" });
  return c.json({ exists: true, description: m.description, scanned: m.scanned ?? null, body: m.body });
});

// Re-scan a connected server (runs the scanner subagent — costs a turn).
mcpRoute.post("/api/mcp/:name/scan", async (c) => {
  const rt = bootRuntime();
  const name = c.req.param("name");
  if (!(name in rt.registry.mcpServers)) {
    return c.json({ error: `${name} isn't a connected MCP server.` }, 400);
  }
  try {
    const summary = await runScan({ mcp: name, mcpServers: rt.registry.mcpServers });
    return c.json({ summary });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
