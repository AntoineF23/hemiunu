// Team management for the web UI: list/switch/add/create/remove the backing
// prototype repos, plus the GitHub OAuth device flow to connect an account.
// Team selection is persisted to ~/.hemiunu/team.json; the next turn picks it up
// via currentTeam()/resolveRepo() — no runtime mutation needed.
import { Hono } from "hono";
import {
  addTeam,
  createRepo,
  currentTeam,
  listTeams,
  pollDeviceToken,
  removeTeam,
  repoExists,
  requestDeviceCode,
  resolveGithubToken,
  setCurrentTeam,
  switchTeam,
  upsertUserEnv,
} from "@hemiunu/agent-core";

export const teamsRoute = new Hono();

const snapshot = () => ({ teams: listTeams(), current: currentTeam() ?? null });

teamsRoute.get("/api/teams", (c) => c.json({ ...snapshot(), github: !!resolveGithubToken() }));

// Switch to a team, or "" / null for local (no-team) mode.
teamsRoute.post("/api/teams/switch", async (c) => {
  const { repo } = (await c.req.json().catch(() => ({}))) as { repo?: string | null };
  if (!repo) {
    setCurrentTeam(null);
  } else if (!switchTeam(repo)) {
    addTeam(repo); // not in the list yet — add + select
  }
  return c.json(snapshot());
});

// Add an existing repo by owner/name (validated against GitHub when signed in).
teamsRoute.post("/api/teams/add", async (c) => {
  const { ref } = (await c.req.json().catch(() => ({}))) as { ref?: string };
  if (!ref?.trim()) return c.json({ error: "Missing repo (owner/name)." }, 400);
  const token = resolveGithubToken();
  if (token && !(await repoExists(token, ref))) {
    return c.json({ error: `Repo ${ref} not found or not accessible.` }, 404);
  }
  addTeam(ref);
  return c.json(snapshot());
});

// Create a new GitHub repo (private) and select it as the current team.
teamsRoute.post("/api/teams/create", async (c) => {
  const { name } = (await c.req.json().catch(() => ({}))) as { name?: string };
  if (!name?.trim()) return c.json({ error: "Missing repo name." }, 400);
  const token = resolveGithubToken();
  if (!token) return c.json({ error: "Not connected to GitHub." }, 401);
  const res = await createRepo(token, name);
  if ("error" in res) return c.json({ error: res.error }, 502);
  addTeam(res.repo);
  return c.json({ ...snapshot(), created: res.repo });
});

teamsRoute.post("/api/teams/remove", async (c) => {
  const { ref } = (await c.req.json().catch(() => ({}))) as { ref?: string };
  if (!ref?.trim()) return c.json({ error: "Missing repo." }, 400);
  removeTeam(ref);
  return c.json(snapshot());
});

// --- GitHub OAuth device flow -------------------------------------------------
teamsRoute.post("/api/github/auth/start", async (c) => {
  try {
    const code = await requestDeviceCode();
    return c.json(code);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

teamsRoute.post("/api/github/auth/poll", async (c) => {
  const { deviceCode } = (await c.req.json().catch(() => ({}))) as { deviceCode?: string };
  if (!deviceCode) return c.json({ error: "Missing deviceCode." }, 400);
  const res = await pollDeviceToken(deviceCode);
  // On success, persist the token so resolveGithubToken() finds it from now on.
  if (res.status === "authorized") upsertUserEnv("GITHUB_TOKEN", res.token);
  return c.json(res.status === "authorized" ? { status: "authorized" } : res);
});
