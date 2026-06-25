// MCP control for the web UI: list every configured MCP server (connected +
// skipped), read/set the per-server and per-tool permission policy (allow / ask
// / block), and view or refresh each server's /scan source-map (.md).
import { join } from "node:path";
import { Hono } from "hono";
import {
  configDir,
  loadSourceMap,
  loadSourceMaps,
  loadToolPolicy,
  runScan,
  setServerPolicy,
  setToolPolicy,
  type ToolPolicy,
} from "@hemiunu/agent-core";
import {
  parseServerConfig,
  readUserServers,
  removeUserServer,
  upsertUserServer,
} from "@hemiunu/mcp";
import { bootRuntime, reloadRegistry } from "../runtime";

export const mcpRoute = new Hono();

const POLICIES = new Set<ToolPolicy>(["allow", "ask", "block"]);
const userMcpPath = () => join(configDir(), "mcp.json");

// Known server names → brand domain, for servers without a usable URL (stdio).
const KNOWN_DOMAINS: Record<string, string> = {
  notion: "notion.so",
  tavily: "tavily.com",
  slack: "slack.com",
  github: "github.com",
  linear: "linear.app",
  figma: "figma.com",
  vercel: "vercel.com",
  gmail: "google.com",
  atlassian: "atlassian.com",
  jira: "atlassian.com",
  confluence: "atlassian.com",
  hubspot: "hubspot.com",
  intercom: "intercom.com",
  asana: "asana.com",
  monday: "monday.com",
  miro: "miro.com",
  canva: "canva.com",
  sentry: "sentry.io",
  stripe: "stripe.com",
};

/** Best brand domain for a server's favicon: its own URL host first (so ANY
 *  remote server resolves automatically), else a known-name match, else none. */
function iconDomain(name: string, config: unknown): string | null {
  const url = (config as { url?: unknown })?.url;
  if (typeof url === "string") {
    try {
      const host = new URL(url).hostname;
      if (host && host !== "localhost" && !/^\d/.test(host)) {
        return host.replace(/^(mcp|api|www|app)\./, ""); // prefer the brand root
      }
    } catch {
      /* not a URL — fall through */
    }
  }
  const key = name.toLowerCase();
  if (KNOWN_DOMAINS[key]) return KNOWN_DOMAINS[key];
  const fuzzy = Object.keys(KNOWN_DOMAINS).find((k) => key.includes(k));
  return fuzzy ? KNOWN_DOMAINS[fuzzy] : null;
}

mcpRoute.get("/api/mcp", (c) => {
  const rt = bootRuntime();
  const policy = loadToolPolicy();
  const maps = new Map(loadSourceMaps().map((m) => [m.mcp, m]));
  const userServers = readUserServers(userMcpPath());
  const userAdded = new Set(Object.keys(userServers));
  const connected = Object.keys(rt.registry.mcpServers).sort();
  // `skipped` is `{ name, reason }[]` (servers omitted for missing env / disabled).
  const skipped = (rt.registry.skipped ?? []) as { name: string; reason?: string }[];

  const describe = (name: string, isConnected: boolean, reason?: string) => {
    const sm = maps.get(name);
    const config = rt.registry.mcpServers[name] ?? userServers[name];
    return {
      name,
      connected: isConnected,
      reason: reason ?? null,
      userAdded: userAdded.has(name),
      iconDomain: iconDomain(name, config),
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

// Add (or replace) a user MCP server in ~/.hemiunu/mcp.json. Takes effect on the
// next turn (the registry is hot-reloaded — no worker restart).
mcpRoute.post("/api/mcp/server", async (c) => {
  const { name, config } = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    config?: unknown;
  };
  if (!name?.trim() || !/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
    return c.json({ error: "Use a simple name (letters, numbers, - or _)." }, 400);
  }
  let parsed;
  try {
    parsed = parseServerConfig(config);
  } catch (e) {
    return c.json({ error: `Invalid server config: ${e instanceof Error ? e.message : e}` }, 400);
  }
  upsertUserServer(userMcpPath(), name.trim(), parsed);
  reloadRegistry();
  return c.json({ ok: true });
});

mcpRoute.delete("/api/mcp/server/:name", (c) => {
  const ok = removeUserServer(userMcpPath(), c.req.param("name"));
  if (ok) reloadRegistry();
  return ok ? c.json({ ok: true }) : c.json({ error: "Not a user-added server." }, 404);
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
  return c.json({
    exists: true,
    description: m.description,
    scanned: m.scanned ?? null,
    body: m.body,
  });
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
