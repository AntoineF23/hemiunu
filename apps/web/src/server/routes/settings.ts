// Settings for the web UI. GET mirrors the CLI's /settings readout (booleans
// only — secrets never leave the worker). POST endpoints let the UI change the
// brain model and set the Anthropic key, persisting them to ~/.hemiunu/.env.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  configDir,
  currentGithubLogin,
  currentTeam,
  discardWorkspace,
  githubStatus,
  hasApiKey,
  listTeams,
  removeTeam,
  repoExists,
  resolveGithubToken,
  upsertUserEnv,
  cloudflareConfigured,
  fetchCloudflareAccountId,
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
  const status = githubStatus();
  // The active GitHub login powers the avatar (github.com/<login>.png) and the
  // profile switcher; currentGithubLogin() also covers an env/`gh` token.
  const githubLogin = (await currentGithubLogin()) ?? null;
  const token = resolveGithubToken();
  // Self-heal: if the active team's repo was deleted on GitHub, drop it so the
  // footer doesn't keep showing a team that no longer exists. repoExists only
  // reports false on a confirmed 404/403/401 (never on a network error/5xx), so
  // we won't drop a live team just because GitHub is briefly unreachable.
  let team = currentTeam();
  if (team && token && !(await repoExists(token, team))) {
    removeTeam(team);
    discardWorkspace(team, "team repo no longer on GitHub"); // clean its tmp workspace (binned)
    team = currentTeam();
  }
  return c.json({
    model: rt.model,
    user: userName(),
    githubLogin,
    githubAccounts: status.accounts,
    hasApiKey: hasApiKey(),
    github: !!token,
    cloudflare: cloudflareConfigured(),
    team: team ?? null,
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

// Connect Cloudflare (BYO account) for sharing prototypes. Takes a "Pages: Edit"
// API token; resolves the account ID from it (or accepts an explicit one if the
// token is too narrowly scoped to list accounts), then persists both.
settingsRoute.post("/api/settings/cloudflare", async (c) => {
  const { token, accountId } = (await c.req.json().catch(() => ({}))) as {
    token?: string;
    accountId?: string;
  };
  if (!token?.trim()) return c.json({ error: "Missing token." }, 400);
  let acct = accountId?.trim();
  if (!acct) {
    const res = await fetchCloudflareAccountId(token.trim());
    if ("error" in res) {
      return c.json(
        { error: `${res.error}. Add your account ID (dash.cloudflare.com/<account-id>).` },
        400,
      );
    }
    acct = res.accountId;
  }
  upsertUserEnv("CLOUDFLARE_API_TOKEN", token.trim());
  upsertUserEnv("CLOUDFLARE_ACCOUNT_ID", acct);
  return c.json({ ok: true, cloudflare: cloudflareConfigured() });
});
