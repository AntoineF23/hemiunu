// The Hemiunu web worker: a long-lived local Node process that wraps the engine
// and streams to a browser client. Bound to 127.0.0.1 only — the OS user is the
// auth boundary; there is no login. Run via bin/hemiunu-web.mjs (or `pnpm dev`).
import "./env-first"; // MUST be first — sets HEMIUNU_HOME before the engine loads .env
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { registerControlHandler } from "./control";
import { originGuard } from "./origin-guard";
import { bootRuntime } from "./runtime";
import { atlasRoute } from "./routes/atlas";
import { conversationsRoute } from "./routes/conversations";
import { mcpRoute } from "./routes/mcp";
import { mcpOAuthRoute } from "./routes/mcp-oauth";
import { memoryRoute } from "./routes/memory";
import { prototypeRoute } from "./routes/prototype";
import { reconcileRoute } from "./routes/reconcile";
import { settingsRoute } from "./routes/settings";
import { skillsRoute } from "./routes/skills";
import { teammatesRoute } from "./routes/teammates";
import { teamsRoute } from "./routes/teams";
import { turnRoute } from "./routes/turn";

const HOST = "127.0.0.1";
const PORT = Number(process.env.HEMIUNU_WEB_PORT ?? 4317);

const app = new Hono();

// DNS-rebinding / cross-origin guard: a malicious web page must not be able to
// POST to this local worker. The Vite dev client on :5173 proxies through to us,
// so its requests carry no cross-site Origin. See ./origin-guard for the policy.
app.use("/api/*", originGuard);

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/", settingsRoute);
app.route("/", teamsRoute);
app.route("/", teammatesRoute);
app.route("/", prototypeRoute);
app.route("/", conversationsRoute);
app.route("/", atlasRoute);
app.route("/", skillsRoute);
app.route("/", memoryRoute);
app.route("/", mcpRoute);
app.route("/", mcpOAuthRoute);
app.route("/", reconcileRoute);
app.route("/", turnRoute);

// In production the worker also serves the built SPA. In dev the client is
// served by Vite (port 5173), which proxies /api here — so this is a no-op then.
const clientDir = join(import.meta.dirname, "..", "..", "dist", "client");
if (existsSync(clientDir)) {
  app.use("/*", serveStatic({ root: clientDir }));
  app.get("/*", serveStatic({ path: join(clientDir, "index.html") }));
}

// Fail fast with a clear message if the engine can't boot (e.g. bad config dir).
bootRuntime();
// Let the agent drive team create/switch/rename (the no-team onboarding flow)
// via the control bridge — without this, those tools return "No interactive
// session is available to do that." in the web app.
registerControlHandler();

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Hemiunu web worker → http://${HOST}:${info.port}`);
  console.log(`Dev client (Vite) → http://${HOST}:5173`);
});

// A raw EADDRINUSE stack trace is meaningless to a non-coder. The usual cause is
// a previous Hemiunu web worker still running on this port — say so, plainly,
// with how to fix it.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nHemiunu web is already running (port ${PORT} is in use).\n\n` +
        `Just open it in your browser:  http://${HOST}:5173\n\n` +
        `If it's stuck, stop the old one and try again:\n` +
        `  lsof -ti tcp:${PORT} | xargs kill        (macOS / Linux)\n` +
        `or start this one on a different port:\n` +
        `  HEMIUNU_WEB_PORT=4318 hemiunu-web\n`,
    );
  } else {
    console.error(`\nHemiunu web couldn't start: ${err.message}\n`);
  }
  process.exit(1);
});
