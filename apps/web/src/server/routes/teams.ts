// Team management for the web UI: list/switch/add/create/remove the backing
// prototype repos, plus the GitHub OAuth device flow to connect an account.
// Team selection is persisted to ~/.hemiunu/team.json; the next turn picks it up
// via currentTeam()/resolveRepo() — no runtime mutation needed.
import { Hono } from "hono";
import {
  addTeam,
  connectGithubAccount,
  createRepo,
  currentTeam,
  discardWorkspace,
  disconnectGithub,
  syncGithubStatus,
  githubViewer,
  listTeams,
  pollDeviceToken,
  pruneTeams,
  removeGithubAccount,
  removeTeam,
  repoExists,
  requestDeviceCode,
  resolveGithubToken,
  setCurrentTeam,
  switchGithubAccount,
  switchTeam,
  upsertUserEnv,
} from "@hemiunu/agent-core";

export const teamsRoute = new Hono();

// Teams are scoped to the active GitHub account, so include the account in the
// snapshot — switching account changes both the team list and `account`.
// syncGithubStatus() adopts an existing env/`gh` identity into the store so a
// previously-connected user shows up (and is switchable) instead of "not
// connected". It's async, so snapshot() is too.
// pruneTeams makes one GitHub API round-trip per saved team, and snapshot()
// runs on every panel open / mutation. Gone-repo cleanup doesn't need to be
// that fresh — rate-limit it to once a minute and let the interim snapshots
// serve the (still-correct) local team list.
const PRUNE_TTL_MS = 60_000;
let lastPrune = 0;

const snapshot = async () => {
  const s = await syncGithubStatus();
  const token = resolveGithubToken();
  if (token && Date.now() - lastPrune >= PRUNE_TTL_MS) {
    lastPrune = Date.now();
    await pruneTeams(token); // drop teams whose repos are gone
  }
  return {
    teams: listTeams(),
    current: currentTeam() ?? null,
    github: s.connected,
    account: s.login ?? null,
    accounts: s.accounts,
  };
};

teamsRoute.get("/api/teams", async (c) => c.json(await snapshot()));

// --- GitHub accounts (the profile switcher) ----------------------------------
teamsRoute.get("/api/github", async (c) => c.json(await syncGithubStatus()));

teamsRoute.post("/api/github/switch", async (c) => {
  const { login } = (await c.req.json().catch(() => ({}))) as { login?: string };
  if (!login || !switchGithubAccount(login)) return c.json({ error: "Unknown account." }, 400);
  return c.json(await snapshot());
});

teamsRoute.post("/api/github/disconnect", async (c) => {
  disconnectGithub();
  return c.json(await snapshot());
});

teamsRoute.delete("/api/github/account/:login", async (c) => {
  removeGithubAccount(c.req.param("login"));
  return c.json(await snapshot());
});

// Switch to a team, or "" / null for local (no-team) mode.
teamsRoute.post("/api/teams/switch", async (c) => {
  const { repo } = (await c.req.json().catch(() => ({}))) as { repo?: string | null };
  if (!repo) {
    setCurrentTeam(null);
  } else if (!switchTeam(repo)) {
    addTeam(repo); // not in the list yet — add + select
  }
  return c.json(await snapshot());
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
  return c.json(await snapshot());
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
  return c.json({ ...(await snapshot()), created: res.repo });
});

teamsRoute.post("/api/teams/remove", async (c) => {
  const { ref } = (await c.req.json().catch(() => ({}))) as { ref?: string };
  if (!ref?.trim()) return c.json({ error: "Missing repo." }, 400);
  removeTeam(ref);
  discardWorkspace(ref, "left the team"); // clean its tmp workspace (binned, recoverable via /restore)
  return c.json(await snapshot());
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
  // On success, register it as a connected account (login + token) and make it
  // active — so it joins the profile switcher and scopes its own teams.
  if (res.status === "authorized") {
    const login = await githubViewer(res.token);
    if (login) connectGithubAccount(login, res.token);
    else upsertUserEnv("GITHUB_TOKEN", res.token); // viewer lookup failed — keep token usable
    return c.json({ status: "authorized", login: login ?? null });
  }
  return c.json(res);
});
