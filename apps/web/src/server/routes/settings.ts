// Settings for the web UI. GET mirrors the CLI's /settings readout (booleans
// only — secrets never leave the worker). POST endpoints let the UI change the
// brain model and set the Anthropic key, persisting them to ~/.hemiunu/.env.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  configDir,
  currentTeam,
  githubViewer,
  hasApiKey,
  listTeams,
  resolveGithubToken,
  upsertUserEnv,
  vercelLoggedIn,
} from "@hemiunu/agent-core";
import { bootRuntime, setRuntimeModel } from "../runtime";

export const settingsRoute = new Hono();

/** A friendly name for the greeting: git user.name, else the first line of user.md. */
function userName(): string | null {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (name) return name.split(/\s+/)[0];
  } catch {
    /* no git / not set */
  }
  try {
    const userMd = join(configDir(), "user.md");
    if (existsSync(userMd)) {
      const first = readFileSync(userMd, "utf8")
        .split(/\r?\n/)
        .find((l) => l.trim());
      const m = first?.match(/(?:name is|i am|i'm|called)\s+([A-Z][a-zA-Z'-]+)/i);
      if (m) return m[1];
    }
  } catch {
    /* unreadable */
  }
  return null;
}

settingsRoute.get("/api/settings", async (c) => {
  const rt = bootRuntime();
  const token = resolveGithubToken();
  // The signed-in GitHub login powers the avatar (github.com/<login>.png).
  const githubLogin = token ? ((await githubViewer(token)) ?? null) : null;
  return c.json({
    model: rt.model,
    user: userName(),
    githubLogin,
    hasApiKey: hasApiKey(),
    github: !!token,
    vercel: vercelLoggedIn(),
    team: currentTeam() ?? null,
    teams: listTeams(),
    mcpServers: Object.keys(rt.registry.mcpServers),
    mcpSkipped: rt.registry.skipped,
  });
});

settingsRoute.post("/api/settings/model", async (c) => {
  const { model } = (await c.req.json().catch(() => ({}))) as { model?: string };
  if (!model?.trim()) return c.json({ error: "Missing model." }, 400);
  upsertUserEnv("HEMIUNU_MODEL", model.trim());
  setRuntimeModel(model.trim());
  return c.json({ model: model.trim() });
});

settingsRoute.post("/api/settings/anthropic-key", async (c) => {
  const { key } = (await c.req.json().catch(() => ({}))) as { key?: string };
  if (!key?.trim()) return c.json({ error: "Missing key." }, 400);
  upsertUserEnv("ANTHROPIC_API_KEY", key.trim());
  return c.json({ ok: true, hasApiKey: hasApiKey() });
});
