// MCP control for the web UI: list every configured MCP server (connected +
// skipped), read/set the per-server and per-tool permission policy (allow / ask
// / block), and view or refresh each server's /scan source-map (.md).
import { join } from "node:path";
import { Hono } from "hono";
import {
  applyMcpOAuth,
  configDir,
  deleteSourceMap,
  enumerateServerTools,
  loadSourceMap,
  loadSourceMaps,
  loadToolPolicy,
  mcpOAuthStatus,
  probeMcpServer,
  runScan,
  saveSourceMap,
  setSeenTools,
  setServerPolicy,
  setToolPolicy,
  slugify,
  type ToolPolicy,
} from "@hemiunu/agent-core";
import {
  isBuiltinServer,
  parseServerConfig,
  readUserServers,
  removeUserServer,
  upsertUserServer,
} from "@hemiunu/mcp";
import { bootRuntime, reloadRegistry } from "../runtime";

export const mcpRoute = new Hono();

const POLICIES = new Set<ToolPolicy>(["allow", "ask", "block"]);
const userMcpPath = () => join(configDir(), "mcp.json");

/**
 * List every tool a connected server exposes and record the full inventory in
 * the tool-policy so the panel shows them all (each with allow/ask/block) — not
 * just the lazily-observed subset. Uses the registry's already-sandboxed config
 * and injects any OAuth token (remote servers). Best-effort: returns 0 and
 * records nothing if the server is unreachable / needs auth / cold-starts slowly.
 */
async function discoverTools(name: string): Promise<number> {
  const rt = bootRuntime();
  const config = rt.registry.mcpServers[name];
  if (!config) return 0;
  const withAuth = await applyMcpOAuth({ [name]: config });
  const tools = await enumerateServerTools(withAuth[name]);
  if (!tools) return 0;
  setSeenTools(
    name,
    tools.map((t) => t.name),
  );
  return tools.length;
}

// Known server names → brand domain, for servers without a usable URL (stdio).
const KNOWN_DOMAINS: Record<string, string> = {
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
  playwright: "playwright.dev",
  puppeteer: "pptr.dev",
  supabase: "supabase.com",
  cloudflare: "cloudflare.com",
};

/** Best brand domain for a server's favicon: its own URL host first (so ANY
 *  remote server resolves automatically), else a keyword match against the
 *  server name AND its stdio command/args (so `npx @playwright/mcp` resolves). */
function iconDomain(name: string, config: unknown): string | null {
  const cfg = (config ?? {}) as { url?: unknown; command?: unknown; args?: unknown };
  if (typeof cfg.url === "string") {
    try {
      const host = new URL(cfg.url).hostname;
      if (host && host !== "localhost" && !/^\d/.test(host)) {
        return host.replace(/^(mcp|api|www|app)\./, ""); // prefer the brand root
      }
    } catch {
      /* not a URL — fall through */
    }
  }
  const args = Array.isArray(cfg.args) ? cfg.args.join(" ") : "";
  const haystack =
    `${name} ${typeof cfg.command === "string" ? cfg.command : ""} ${args}`.toLowerCase();
  const key = Object.keys(KNOWN_DOMAINS).find((k) => haystack.includes(k));
  return key ? KNOWN_DOMAINS[key] : null;
}

mcpRoute.get("/api/mcp", async (c) => {
  const rt = bootRuntime();
  const policy = loadToolPolicy();
  const maps = new Map(loadSourceMaps().map((m) => [m.mcp, m]));
  const userServers = readUserServers(userMcpPath());
  const userAdded = new Set(Object.keys(userServers));
  // Hide the built-in filesystem server: it's a launch-folder capability, not a
  // user-added integration, so it doesn't belong in the connected-servers list.
  const connected = Object.keys(rt.registry.mcpServers)
    .filter((n) => !isBuiltinServer(n, rt.registry.mcpServers[n]))
    .sort();
  // `skipped` is `{ name, reason }[]` (servers omitted for missing env / disabled).
  const skipped = ((rt.registry.skipped ?? []) as { name: string; reason?: string }[]).filter(
    (s) => !isBuiltinServer(s.name),
  );

  const describe = async (name: string, isConnected: boolean, reason?: string) => {
    // Source maps are saved under the slugified name (e.g. "Playwright" →
    // playwright.md), so match on the slug, not the raw server name.
    const sm = maps.get(slugify(name));
    const config = rt.registry.mcpServers[name] ?? userServers[name];
    const url =
      typeof (config as { url?: unknown } | undefined)?.url === "string"
        ? (config as { url: string }).url
        : undefined;
    // Remote (http/sse) servers get a reachability/auth probe so the panel can
    // explain why a server has no tools (offline vs. needs authorizing).
    let reachable: boolean | null = null;
    let needsAuth = false;
    let oauthAuthorized = false;
    if (url) {
      oauthAuthorized = mcpOAuthStatus(name).authorized;
      const probe = await probeMcpServer(url);
      reachable = probe !== "unreachable";
      needsAuth = probe === "needs-auth" && !oauthAuthorized;
    }
    return {
      name,
      connected: isConnected,
      reason: reason ?? null,
      userAdded: userAdded.has(name),
      // Raw overlay config for the edit form — only for user-added servers, so
      // app-default servers' interpolated secrets never reach the browser.
      config: userServers[name] ?? null,
      iconDomain: iconDomain(name, config),
      serverPolicy: policy.servers[name] ?? "ask",
      tools: (policy.seen[name] ?? []).map((id) => ({
        id,
        policy: policy.tools[id] ?? "ask",
      })),
      sourceMap: sm ? { description: sm.description, scanned: sm.scanned ?? null } : null,
      // Remote-auth diagnostic (null reachable = not a remote server).
      remote: !!url,
      reachable,
      needsAuth,
      oauthAuthorized,
    };
  };

  const servers = await Promise.all([
    ...connected.map((n) => describe(n, true)),
    ...skipped.map((s) => describe(s.name, false, s.reason)),
  ]);
  return c.json({ servers });
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
  // Enumerate the new server's tools in the background so the panel can show
  // every tool (with allow/ask/block) — without blocking this response on a
  // cold `npx` boot. The user can also hit "Discover tools" to force a refresh.
  void discoverTools(name.trim()).catch(() => {});
  return c.json({ ok: true });
});

mcpRoute.delete("/api/mcp/server/:name", (c) => {
  const name = c.req.param("name");
  const ok = removeUserServer(userMcpPath(), name);
  if (ok) reloadRegistry();
  // Remove the scan map too, regardless — a deleted server shouldn't leave its
  // source map behind. (deleteSourceMap is a no-op if there isn't one.)
  deleteSourceMap(name);
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

// Save a hand-edited source map (.md). Preserves the existing one-line
// description unless a new one is supplied.
mcpRoute.put("/api/mcp/:name/sourcemap", async (c) => {
  const name = c.req.param("name");
  const { body, description } = (await c.req.json().catch(() => ({}))) as {
    body?: string;
    description?: string;
  };
  if (typeof body !== "string") return c.json({ error: "Missing body." }, 400);
  const existing = loadSourceMap(name);
  saveSourceMap({
    mcp: name,
    description: description ?? existing?.description ?? "",
    body,
  });
  return c.json({ ok: true });
});

mcpRoute.delete("/api/mcp/:name/sourcemap", (c) => {
  deleteSourceMap(c.req.param("name"));
  return c.json({ ok: true });
});

// List (or refresh) a connected server's full tool inventory and record it, so
// the panel shows every tool with an allow/ask/block control. No LLM turn, no
// cost — just an MCP `tools/list`.
mcpRoute.post("/api/mcp/:name/tools", async (c) => {
  const rt = bootRuntime();
  const name = c.req.param("name");
  if (!(name in rt.registry.mcpServers)) {
    return c.json({ error: `${name} isn't a connected MCP server.` }, 400);
  }
  const count = await discoverTools(name);
  if (count === 0) {
    return c.json(
      {
        error:
          "Couldn't list this server's tools — it may be offline, need authorizing, or still starting up. Try again in a moment.",
      },
      502,
    );
  }
  return c.json({ count });
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
