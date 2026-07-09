// OAuth for remote MCP servers (web side). Three endpoints:
//   POST /api/mcp/oauth/start    → discover + register + return the auth URL
//   GET  /api/mcp/oauth/status   → has the user finished authorizing?
//   GET  /oauth/mcp/callback     → the browser redirect lands here (NOT under
//                                  /api, so it bypasses the same-origin guard —
//                                  a top-level redirect carries no Origin anyway)
import { Hono } from "hono";
import { completeMcpAuth, mcpOAuthStatus, startMcpAuth } from "@hemiunu/agent-core";
import { bootRuntime, reloadRegistry } from "../runtime";

export const mcpOAuthRoute = new Hono();

const PORT = Number(process.env.HEMIUNU_WEB_PORT ?? 4317);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/mcp/callback`;

/** The configured URL of a remote MCP server, or undefined if it isn't remote. */
function serverUrl(name: string): string | undefined {
  const cfg = bootRuntime().registry.mcpServers[name] as { url?: unknown } | undefined;
  return typeof cfg?.url === "string" ? cfg.url : undefined;
}

/** Escape text for safe interpolation into HTML. `message` includes
 *  attacker-controllable OAuth error params and raw exception text, so it must
 *  never be treated as markup — otherwise a malicious site could top-level
 *  navigate here and run a same-origin script against the local API. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resultPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hemiunu</title></head>
<body style="font:16px/1.5 system-ui;background:#1a1714;color:#eadfd0;display:grid;place-items:center;height:100vh;margin:0">
<p style="max-width:32rem;padding:0 1.5rem;text-align:center">${escapeHtml(message)}</p></body></html>`;
}

mcpOAuthRoute.post("/api/mcp/oauth/start", async (c) => {
  const { server } = (await c.req.json().catch(() => ({}))) as { server?: string };
  if (!server?.trim()) return c.json({ error: "Missing server." }, 400);
  const url = serverUrl(server);
  if (!url) return c.json({ error: `${server} isn't a remote (http/sse) server.` }, 400);
  try {
    const { authUrl, state } = await startMcpAuth(server, url, REDIRECT_URI);
    return c.json({ authUrl, state });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

mcpOAuthRoute.get("/api/mcp/oauth/status", (c) => {
  const server = c.req.query("server");
  if (!server) return c.json({ error: "Missing server." }, 400);
  return c.json(mcpOAuthStatus(server));
});

mcpOAuthRoute.get("/oauth/mcp/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  if (error) return c.html(resultPage(`Authorization failed: ${error}`), 400);
  if (!code || !state) return c.html(resultPage("Missing authorization code."), 400);
  try {
    await completeMcpAuth(state, code);
    reloadRegistry(); // pick the server up immediately
    return c.html(resultPage("✓ Connected. You can close this tab and return to Hemiunu."));
  } catch (e) {
    return c.html(
      resultPage(`Authorization failed: ${e instanceof Error ? e.message : String(e)}`),
      400,
    );
  }
});
