import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";
import { timeoutSignal } from "./net";
import { currentWorkspace } from "./workspace-context";

/**
 * Thin GitHub layer for the prototype team-knowledge path. It lets the agent
 * read and commit a SINGLE file via the Contents API — no clone required — so a
 * teammate can enrich a prototype's knowledge from anywhere. Auth is a token the
 * agent remembers (resolveGithubToken); the backing repo is resolved once
 * (resolveRepo). No extra dependency — just fetch + base64.
 */

const API = "https://api.github.com";

// GitHub REST calls are small and normally finish in 1–3s, so they get a much
// tighter timeout than the 60s we allow slow AI-model calls — a stalled commit
// surfaces as an error in ~20s instead of looking frozen for a full minute.
// Override with HEMIUNU_GITHUB_TIMEOUT_MS.
function githubTimeout(): number {
  const n = Number(process.env.HEMIUNU_GITHUB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "hemiunu",
  };
}

// --- GitHub accounts (connect / switch / disconnect) -------------------------
// Hemiunu can hold several connected GitHub identities and switch between them
// instantly. Stored in ~/.hemiunu/github.json; the token travels with each
// account. `disconnected` is an explicit "use no GitHub" state the user sets
// from /github. Once this file exists it is AUTHORITATIVE (the UI is then fully
// predictable); with no file we fall back to env/`gh` as before (fresh user, CI).

interface GithubAccount {
  login: string;
  token: string;
}
interface GithubAuthFile {
  accounts: GithubAccount[];
  active?: string;
  disconnected?: boolean;
}

function githubAuthPath(): string {
  return join(configDir(), "github.json");
}

function loadGithubAuth(): GithubAuthFile {
  try {
    const raw = JSON.parse(readFileSync(githubAuthPath(), "utf8")) as Partial<GithubAuthFile>;
    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts.filter(
          (a): a is GithubAccount =>
            !!a && typeof a.login === "string" && typeof a.token === "string",
        )
      : [];
    return {
      accounts,
      active: typeof raw.active === "string" ? raw.active : undefined,
      disconnected: !!raw.disconnected,
    };
  } catch {
    return { accounts: [] };
  }
}

function saveGithubAuth(f: GithubAuthFile): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(githubAuthPath(), `${JSON.stringify(f, null, 2)}\n`, "utf8");
}

function activeAccountToken(): string | undefined {
  const f = loadGithubAuth();
  if (f.disconnected) return undefined;
  return f.accounts.find((a) => a.login === f.active)?.token;
}

export interface GithubStatus {
  /** The active account's login, or undefined when not connected. */
  login?: string;
  /** Whether Hemiunu currently has a usable GitHub identity. */
  connected: boolean;
  /** All known account logins (for the switcher). */
  accounts: string[];
}

/**
 * GitHub status for the UI footer/picker (synchronous). `connected` is honest
 * about ANY usable token — store account OR an env/`gh` token — so a user who
 * signed in the old way isn't shown as "not connected". `login` is only known
 * synchronously for a store account; call syncGithubStatus() to resolve+adopt
 * an env/`gh` identity so its name shows and it becomes switchable.
 */
export function githubStatus(): GithubStatus {
  const f = loadGithubAuth();
  if (f.disconnected) {
    return { login: undefined, connected: false, accounts: f.accounts.map((a) => a.login) };
  }
  const storeLogin = f.accounts.some((a) => a.login === f.active) ? f.active : undefined;
  return {
    login: storeLogin,
    connected: !!storeLogin || !!resolveGithubToken(),
    accounts: f.accounts.map((a) => a.login),
  };
}

/**
 * Like githubStatus(), but first ADOPTS an existing env/`gh` identity into the
 * store (looks up its login and saves it as an account) when there's a usable
 * token but no active store account. This migrates a previously-connected user
 * into the managed model so their account shows up and can be switched. Honors
 * an explicit disconnect (won't re-adopt).
 */
export async function syncGithubStatus(): Promise<GithubStatus> {
  const f = loadGithubAuth();
  if (!f.disconnected && !activeAccountToken()) {
    const token = resolveGithubToken();
    if (token) {
      const login = await githubViewer(token);
      if (login) connectGithubAccount(login, token);
    }
  }
  return githubStatus();
}

/** Add or update a connected account and make it active (clears 'disconnected'). */
export function connectGithubAccount(login: string, token: string): void {
  const f = loadGithubAuth();
  const i = f.accounts.findIndex((a) => a.login === login);
  if (i >= 0) f.accounts[i] = { login, token };
  else f.accounts.push({ login, token });
  f.active = login;
  f.disconnected = false;
  saveGithubAuth(f);
}

/** Switch the active account (reconnecting if disconnected). False if unknown. */
export function switchGithubAccount(login: string): boolean {
  const f = loadGithubAuth();
  if (!f.accounts.some((a) => a.login === login)) return false;
  f.active = login;
  f.disconnected = false;
  saveGithubAuth(f);
  return true;
}

/** Disconnect: stop using GitHub. Accounts are kept so the user can reconnect. */
export function disconnectGithub(): void {
  const f = loadGithubAuth();
  // Only persist a store if there's something to disconnect from (an account,
  // or a pre-existing store); otherwise leave env/gh fallback untouched.
  f.disconnected = true;
  saveGithubAuth(f);
}

/** Forget a stored account entirely (used for a hard sign-out). */
export function removeGithubAccount(login: string): void {
  const f = loadGithubAuth();
  f.accounts = f.accounts.filter((a) => a.login !== login);
  if (f.active === login) f.active = f.accounts[0]?.login;
  saveGithubAuth(f);
}

/**
 * Resolve a GitHub token. Once the user has used Hemiunu's connect/disconnect
 * (a github.json exists) that store is authoritative — including an explicit
 * disconnect. With no store, fall back to an env token (GITHUB_TOKEN / GH_TOKEN)
 * or the locally-installed `gh` CLI, as before.
 */
export function resolveGithubToken(): string | undefined {
  if (existsSync(githubAuthPath())) {
    const f = loadGithubAuth();
    if (f.disconnected) return undefined; // explicit "no GitHub" — honor it
    const t = activeAccountToken();
    if (t) return t;
    // Store exists but no usable account → fall through to env/gh.
  }
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

/**
 * The login Hemiunu is currently acting as: the active account (sync, from the
 * store) or — when relying on an env/`gh` token — looked up via the API. Returns
 * undefined when not connected.
 */
export async function currentGithubLogin(): Promise<string | undefined> {
  const s = githubStatus();
  if (s.login) return s.login;
  const token = resolveGithubToken();
  return token ? await githubViewer(token) : undefined;
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
    signal: timeoutSignal(githubTimeout()),
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
    signal: timeoutSignal(githubTimeout()),
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

// Teams are scoped to the active GitHub account, so switching account switches
// the visible team list. On disk: { accounts: { <login>: { teams, current } } },
// with a "(local)" bucket used when no GitHub account is connected. The login
// can't collide with that sentinel (GitHub logins are alphanumeric + hyphens).
const LOCAL_TEAMS_KEY = "(local)";

interface TeamsFile {
  accounts: Record<string, TeamsConfig>;
}

/** The bucket key for the currently-active account (or local when none). */
function activeTeamsKey(): string {
  return githubStatus().login ?? LOCAL_TEAMS_KEY;
}

function normalizeTeamsConfig(v: unknown): TeamsConfig {
  const o = (v ?? {}) as { teams?: unknown; current?: unknown };
  const teams = Array.isArray(o.teams)
    ? o.teams.filter((t): t is string => typeof t === "string").map(normalizeRepo)
    : [];
  // Preserve `current` verbatim ("" = explicit no-team); interpretation is left
  // to currentTeam()/cycleTeam() so the no-team selection survives.
  const current = typeof o.current === "string" ? normalizeRepo(o.current) : undefined;
  return { teams, current };
}

/** Read the whole per-account file, migrating legacy flat shapes into the
 *  currently-active account's bucket (and persisting that migration). */
function loadTeamsFile(): TeamsFile {
  const path = teamsPath();
  if (!existsSync(path)) return { accounts: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.accounts && typeof raw.accounts === "object") {
      const accounts: Record<string, TeamsConfig> = {};
      for (const [k, v] of Object.entries(raw.accounts as Record<string, unknown>)) {
        accounts[k] = normalizeTeamsConfig(v);
      }
      return { accounts };
    }
    // Legacy: flat { teams, current } or single { repo } → migrate under the
    // active account so existing users keep their teams after the upgrade.
    let legacy: TeamsConfig | undefined;
    if (Array.isArray(raw.teams)) legacy = normalizeTeamsConfig(raw);
    else if (typeof raw.repo === "string") {
      const r = normalizeRepo(raw.repo);
      legacy = { teams: [r], current: r };
    }
    if (legacy) {
      const file: TeamsFile = { accounts: { [activeTeamsKey()]: legacy } };
      saveTeamsFile(file);
      return file;
    }
  } catch {
    // malformed — treat as empty
  }
  return { accounts: {} };
}

function saveTeamsFile(file: TeamsFile): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(teamsPath(), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Saved teams for the active account (or the local bucket when not connected). */
export function loadTeams(): TeamsConfig {
  return loadTeamsFile().accounts[activeTeamsKey()] ?? { teams: [] };
}

function saveTeams(cfg: TeamsConfig): void {
  const file = loadTeamsFile();
  file.accounts[activeTeamsKey()] = cfg;
  saveTeamsFile(file);
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

/**
 * Remove a team from the saved list. If it was the current selection, fall back
 * to "no team" (local mode). Returns true if it was present and removed.
 */
export function removeTeam(ref: string): boolean {
  const repo = normalizeRepo(ref);
  const cfg = loadTeams();
  if (!cfg.teams.includes(repo)) return false;
  cfg.teams = cfg.teams.filter((t) => t !== repo);
  if (cfg.current && normalizeRepo(cfg.current) === repo) cfg.current = "";
  saveTeams(cfg);
  return true;
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

/**
 * Replace a team's repo id after a rename (`oldRepo` → `newRepo`), preserving its
 * position in the list and updating the `current` pointer if it was selected.
 */
export function renameTeam(oldRepo: string, newRepo: string): void {
  const oldN = normalizeRepo(oldRepo);
  const newN = normalizeRepo(newRepo);
  const cfg = loadTeams();
  cfg.teams = cfg.teams.map((t) => (t === oldN ? newN : t));
  if (cfg.current && normalizeRepo(cfg.current) === oldN) cfg.current = newN;
  saveTeams(cfg);
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
    const res = await fetch(`${API}/repos/${normalizeRepo(repo)}`, {
      headers: apiHeaders(token),
      signal: timeoutSignal(githubTimeout()),
    });
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
    const res = await fetch(`${API}/user`, {
      headers: apiHeaders(token),
      signal: timeoutSignal(githubTimeout()),
    });
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
    signal: timeoutSignal(githubTimeout()),
  });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  const json = (await res.json()) as { full_name?: string };
  return { repo: json.full_name ?? `${org ?? viewer ?? "?"}/${repoName}` };
}

/**
 * Rename a repo on GitHub (owner unchanged — only the name part). GitHub keeps
 * redirecting the old URL afterwards, so existing clones/remotes still work.
 * Returns the new `owner/name`, or an error message.
 */
export async function renameRepo(
  token: string,
  repo: string,
  newName: string,
): Promise<{ repo: string } | { error: string }> {
  const norm = normalizeRepo(repo);
  const [owner] = norm.split("/");
  const name = newName.trim().replace(/\s+/g, "-");
  if (!name) return { error: "empty name" };
  const res = await fetch(`${API}/repos/${norm}`, {
    method: "PATCH",
    headers: { ...apiHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: timeoutSignal(githubTimeout()),
  });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  const json = (await res.json()) as { full_name?: string };
  return { repo: json.full_name ?? `${owner}/${name}` };
}

// --- Collaborators / teammates ----------------------------------------------

export interface RepoAccess {
  /** Whether the repo is owned by a user or an organization. */
  ownerType: "User" | "Organization" | "unknown";
  /** The token holder has admin (owner) rights — required to remove people. */
  admin: boolean;
  /** The token holder has push (write) rights. */
  push: boolean;
}

/** The token holder's access to a repo (owner type + admin/push rights). */
export async function repoAccess(
  token: string,
  repo: string,
): Promise<RepoAccess | { error: string }> {
  try {
    const res = await fetch(`${API}/repos/${normalizeRepo(repo)}`, {
      headers: apiHeaders(token),
      signal: timeoutSignal(githubTimeout()),
    });
    if (!res.ok) return { error: `${res.status} ${await res.text()}` };
    const j = (await res.json()) as {
      owner?: { type?: string };
      permissions?: { admin?: boolean; push?: boolean };
    };
    const t = j.owner?.type;
    return {
      ownerType: t === "Organization" ? "Organization" : t === "User" ? "User" : "unknown",
      admin: !!j.permissions?.admin,
      push: !!j.permissions?.push,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Add a collaborator to a repo (write access by default). On an org/private repo
 * GitHub creates an INVITATION the person must accept (201); a direct add or an
 * existing collaborator returns 204.
 */
export async function addCollaborator(
  token: string,
  repo: string,
  username: string,
  permission: "pull" | "push" | "admin" = "push",
): Promise<{ ok: true; status: "invited" | "added" } | { error: string }> {
  const res = await fetch(
    `${API}/repos/${normalizeRepo(repo)}/collaborators/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ permission }),
      signal: timeoutSignal(githubTimeout()),
    },
  );
  if (res.status === 201) return { ok: true, status: "invited" };
  if (res.status === 204) return { ok: true, status: "added" };
  return { error: `${res.status} ${await res.text()}` };
}

/** Remove a collaborator from a repo (requires admin rights → 204 on success). */
export async function removeCollaborator(
  token: string,
  repo: string,
  username: string,
): Promise<{ ok: true } | { error: string }> {
  const res = await fetch(
    `${API}/repos/${normalizeRepo(repo)}/collaborators/${encodeURIComponent(username)}`,
    { method: "DELETE", headers: apiHeaders(token), signal: timeoutSignal(githubTimeout()) },
  );
  if (res.status === 204) return { ok: true };
  return { error: `${res.status} ${await res.text()}` };
}

export interface Collaborator {
  login: string;
  /** Has admin (owner) rights on the repo. */
  admin: boolean;
  /** Has push (write) rights on the repo. */
  push: boolean;
}

/** Current collaborators on a repo (login + rights). Empty if not accessible. */
export async function listCollaborators(token: string, repo: string): Promise<Collaborator[]> {
  try {
    const res = await fetch(`${API}/repos/${normalizeRepo(repo)}/collaborators?per_page=100`, {
      headers: apiHeaders(token),
      signal: timeoutSignal(githubTimeout()),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      login?: string;
      permissions?: { admin?: boolean; push?: boolean };
    }[];
    return j
      .filter((m): m is { login: string; permissions?: { admin?: boolean; push?: boolean } } =>
        Boolean(m.login),
      )
      .map((m) => ({ login: m.login, admin: !!m.permissions?.admin, push: !!m.permissions?.push }));
  } catch {
    return [];
  }
}

/** Members of an organization (logins), for teammate autocomplete. Empty when
 *  the owner isn't an org or the token can't list its members. */
export async function listOrgMembers(token: string, org: string): Promise<string[]> {
  try {
    const res = await fetch(`${API}/orgs/${encodeURIComponent(org)}/members?per_page=100`, {
      headers: apiHeaders(token),
      signal: timeoutSignal(githubTimeout()),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { login?: string }[];
    return j.map((m) => m.login).filter((l): l is string => !!l);
  } catch {
    return [];
  }
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
  const res = await fetch(url, {
    headers: apiHeaders(token),
    signal: timeoutSignal(githubTimeout()),
  });
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
    signal: timeoutSignal(githubTimeout()),
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
