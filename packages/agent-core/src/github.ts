import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";
import { currentWorkspace } from "./workspace-context";

/**
 * Thin GitHub layer for the prototype team-knowledge path. It lets the agent
 * read and commit a SINGLE file via the Contents API — no clone required — so a
 * teammate can enrich a prototype's knowledge from anywhere. Auth is a token the
 * agent remembers (resolveGithubToken); the backing repo is resolved once
 * (resolveRepo). No extra dependency — just fetch + base64.
 */

const API = "https://api.github.com";

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "hemiunu",
  };
}

/**
 * Resolve a GitHub token without re-prompting: an explicit token in the env
 * (GITHUB_TOKEN / GH_TOKEN, which Hemiunu persists to ~/.hemiunu/.env), else the
 * locally-installed `gh` CLI if the user is already logged in there.
 */
export function resolveGithubToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (env) return env;
  try {
    const t = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

// --- OAuth device flow (connect a GitHub account entirely from the CLI) ------
// The same flow `gh auth login` uses: the agent shows a short code + URL, the
// user authorizes in a browser, and the agent polls for an access token — no
// `gh` install and no hand-made PAT. Requires a registered GitHub OAuth App;
// its client id is PUBLIC (safe to ship) and overridable via env.

/**
 * Client id of Hemiunu's GitHub OAuth App. Public, not a secret. Set the env
 * override, or paste your registered app's id into DEFAULT_GITHUB_CLIENT_ID
 * below (see the README "Connect GitHub" section for the 2-minute registration).
 */
const DEFAULT_GITHUB_CLIENT_ID = "Ov23liqKV4lFayi6GN8g";
/** OAuth scope: `repo` covers Contents read/write on the user's private repos. */
const DEVICE_SCOPE = "repo";

export function githubClientId(): string | undefined {
  return process.env.HEMIUNU_GITHUB_CLIENT_ID?.trim() || DEFAULT_GITHUB_CLIENT_ID || undefined;
}

export interface DeviceCode {
  deviceCode: string;
  /** Short code the user types at the verification URL. */
  userCode: string;
  verificationUri: string;
  /** Seconds to wait between polls. */
  interval: number;
  /** Seconds until the code expires. */
  expiresIn: number;
}

/** Start the device flow: get a user code + verification URL to show the user. */
export async function requestDeviceCode(scope: string = DEVICE_SCOPE): Promise<DeviceCode> {
  const clientId = githubClientId();
  if (!clientId) {
    throw new Error(
      "No GitHub OAuth client id. Register a GitHub OAuth App and set HEMIUNU_GITHUB_CLIENT_ID (see the README).",
    );
  }
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "hemiunu",
    },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  if (!res.ok) throw new Error(`device-code request failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  };
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    interval: j.interval ?? 5,
    expiresIn: j.expires_in ?? 900,
  };
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "authorized"; token: string }
  | { status: "error"; message: string };

/** Poll once for the access token after the user authorizes (or while pending). */
export async function pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
  const clientId = githubClientId();
  if (!clientId) return { status: "error", message: "No GitHub OAuth client id." };
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "hemiunu",
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const j = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };
  if (j.access_token) return { status: "authorized", token: j.access_token };
  switch (j.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", interval: j.interval ?? 10 };
    case "expired_token":
      return { status: "error", message: "the code expired — run /github again" };
    case "access_denied":
      return { status: "error", message: "authorization was denied" };
    default:
      return { status: "error", message: j.error_description || j.error || "unknown error" };
  }
}

/** Normalise any GitHub repo reference to `owner/name`. */
export function normalizeRepo(ref: string): string {
  return ref
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

// --- Teams ---------------------------------------------------------------
// A "team" is a backing prototype repo the user can switch between (usually one
// repo ≈ one prototype). They're kept in ~/.hemiunu/team.json with a `current`
// pointer, so the user can flip context (e.g. via Shift+Tab in the CLI).

export interface TeamsConfig {
  /** Saved team repos ("owner/name"), in display/cycle order. */
  teams: string[];
  /** The currently-selected repo. */
  current?: string;
}

function teamsPath(): string {
  return join(configDir(), "team.json");
}

/** Read saved teams, migrating the older single-repo `{ repo }` shape. */
export function loadTeams(): TeamsConfig {
  const path = teamsPath();
  if (!existsSync(path)) return { teams: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      teams?: unknown;
      current?: unknown;
      repo?: unknown;
    };
    if (Array.isArray(raw.teams)) {
      const teams = raw.teams.filter((t): t is string => typeof t === "string").map(normalizeRepo);
      // Preserve `current` verbatim ("" = explicit no-team); interpretation is
      // left to currentTeam()/cycleTeam() so the no-team selection survives.
      const current = typeof raw.current === "string" ? normalizeRepo(raw.current) : undefined;
      return { teams, current };
    }
    if (typeof raw.repo === "string") {
      const r = normalizeRepo(raw.repo); // migrate legacy { repo }
      return { teams: [r], current: r };
    }
  } catch {
    // malformed — treat as empty
  }
  return { teams: [] };
}

function saveTeams(cfg: TeamsConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(teamsPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/** All saved teams (repos), in order. */
export function listTeams(): string[] {
  return loadTeams().teams;
}

/**
 * The currently-selected team repo, or undefined for "no team" (local mode).
 * A blank/unset/stale `current` means no team — the user works locally until
 * they pick or create one.
 */
export function currentTeam(): string | undefined {
  const { teams, current } = loadTeams();
  return current && teams.includes(current) ? current : undefined;
}

/** Add a team (if new) and make it current. Returns the normalized repo. */
export function addTeam(ref: string): string {
  const repo = normalizeRepo(ref);
  const cfg = loadTeams();
  if (!cfg.teams.includes(repo)) cfg.teams.push(repo);
  cfg.current = repo;
  saveTeams(cfg);
  return repo;
}

/** Switch to an existing team. Returns false if it isn't in the list. */
export function switchTeam(ref: string): boolean {
  const repo = normalizeRepo(ref);
  const cfg = loadTeams();
  if (!cfg.teams.includes(repo)) return false;
  cfg.current = repo;
  saveTeams(cfg);
  return true;
}

/** Select a team, or `null` for "no team" (local mode). Persisted. */
export function setCurrentTeam(repo: string | null): void {
  const cfg = loadTeams();
  cfg.current = repo ? normalizeRepo(repo) : "";
  saveTeams(cfg);
}

/** Whether a repo exists and is accessible to the token (false on 404/403/401). */
export async function repoExists(token: string, repo: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/repos/${normalizeRepo(repo)}`, { headers: apiHeaders(token) });
    if (res.ok) return true;
    if (res.status === 404 || res.status === 403 || res.status === 401) return false;
    return true; // transient (5xx/other) → keep, don't prune on uncertainty
  } catch {
    return true; // network error → keep
  }
}

/**
 * Drop saved teams whose repos no longer exist / aren't accessible to the user,
 * and clear the current selection if it was removed. Returns the removed repos.
 */
export async function pruneTeams(token: string): Promise<string[]> {
  const cfg = loadTeams();
  if (!cfg.teams.length) return [];
  const kept: string[] = [];
  const removed: string[] = [];
  for (const repo of cfg.teams) {
    if (await repoExists(token, repo)) kept.push(repo);
    else removed.push(repo);
  }
  if (removed.length) {
    const current = cfg.current && kept.includes(cfg.current) ? cfg.current : "";
    saveTeams({ teams: kept, current });
  }
  return removed;
}

/**
 * Cycle through the selection ring [no-team, team1, team2, …] and persist it.
 * Returns the new selection: a repo, `""` for "no team" (local), or `null` when
 * there are no teams to cycle to (only "no team" exists).
 */
export function cycleTeam(direction: 1 | -1 = 1): string | null {
  const cfg = loadTeams();
  const ring = ["", ...cfg.teams]; // "" = no team
  if (ring.length < 2) return null;
  const curVal = cfg.current && cfg.teams.includes(cfg.current) ? cfg.current : "";
  const next = ring[(ring.indexOf(curVal) + direction + ring.length) % ring.length];
  cfg.current = next;
  saveTeams(cfg);
  return next;
}

/**
 * Resolve the active repo (`owner/name`): an explicit env override, else this
 * turn's bound workspace (when running inside a turn — see workspace-context),
 * else the persisted current team. Undefined means "no team" — work locally.
 *
 * The turn binding takes precedence over the global selection so that, when
 * several teams run concurrently, each turn's tools target its OWN repo even if
 * the foreground selection has since changed.
 */
export function resolveRepo(): string | undefined {
  const env = process.env.HEMIUNU_PROTOTYPE_REPO?.trim();
  if (env) return normalizeRepo(env);
  const ws = currentWorkspace();
  if (ws) return ws.repo ? normalizeRepo(ws.repo) : undefined;
  return currentTeam();
}

/** The authenticated user's login (for attribution), or undefined if the token is bad. */
export async function githubViewer(token: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${API}/user`, { headers: apiHeaders(token) });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { login?: string };
    return json.login;
  } catch {
    return undefined;
  }
}

/**
 * Create a repo and return its `owner/name`. `name` may be `repo` (created under
 * the authenticated user) or `org/repo` (created under that org). Private by
 * default. `auto_init` gives it an initial commit so the default branch exists
 * (needed for later Contents-API writes).
 */
export async function createRepo(
  token: string,
  name: string,
  opts?: { private?: boolean },
): Promise<{ repo: string } | { error: string }> {
  const isPrivate = opts?.private ?? true;
  let org: string | undefined;
  let repoName = name.trim();
  if (repoName.includes("/")) {
    const [o, r] = repoName.split("/");
    org = o;
    repoName = r;
  }
  repoName = repoName.replace(/\s+/g, "-");
  const viewer = await githubViewer(token);
  const url = org && org !== viewer ? `${API}/orgs/${org}/repos` : `${API}/user/repos`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...apiHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: true }),
  });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  const json = (await res.json()) as { full_name?: string };
  return { repo: json.full_name ?? `${org ?? viewer ?? "?"}/${repoName}` };
}

export interface RepoFile {
  content: string;
  sha: string;
}

/** Read a single file's content + blob sha, or null if it doesn't exist. */
export async function getFile(
  token: string,
  repo: string,
  path: string,
  branch?: string,
): Promise<RepoFile | null> {
  const url = `${API}/repos/${repo}/contents/${path}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`;
  const res = await fetch(url, { headers: apiHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { content?: string; sha: string };
  const content = json.content ? Buffer.from(json.content, "base64").toString("utf8") : "";
  return { content, sha: json.sha };
}

interface PutResult {
  commitUrl?: string;
}

/** Create or update a single file (Contents API PUT). `sha` is required to replace. */
async function putFile(
  token: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  sha?: string,
  branch?: string,
): Promise<PutResult> {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...apiHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
      ...(branch ? { branch } : {}),
    }),
  });
  if (!res.ok) {
    const err = new Error(`GitHub PUT ${path}: ${res.status} ${await res.text()}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  const json = (await res.json()) as { commit?: { html_url?: string } };
  return { commitUrl: json.commit?.html_url };
}

/**
 * Read a file, apply `transform` to its current content (null if absent), and
 * commit the result — retrying on a stale-sha conflict (409/422) by re-reading
 * the latest and re-applying. Append-style transforms re-apply cleanly, so
 * concurrent knowledge edits converge without a manual merge.
 */
export async function commitFile(
  token: string,
  repo: string,
  path: string,
  transform: (current: string | null) => string,
  message: string,
  branch?: string,
): Promise<PutResult> {
  for (let attempt = 0; ; attempt++) {
    const existing = await getFile(token, repo, path, branch);
    const next = transform(existing?.content ?? null);
    try {
      return await putFile(token, repo, path, next, message, existing?.sha, branch);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if ((status === 409 || status === 422) && attempt < 3) continue; // sha race — retry
      throw e;
    }
  }
}
