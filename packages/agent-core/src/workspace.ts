import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { configDir } from "./config";
import { normalizeRepo, resolveRepo } from "./github";
import { currentWorkspace } from "./workspace-context";

/**
 * Per-team local working copy for FAST iteration (localhost dev server, slice 2)
 * — a throwaway git checkout under ~/.hemiunu/tmp/teams/<owner>/<repo>, always
 * synced to the latest remote when the user starts iterating. Nothing here is
 * ever hard-deleted: anything about to be discarded is first copied to a
 * recoverable recycle bin (~/.hemiunu/trash), so a forgotten/un-pushed change
 * can always be retrieved.
 */

const TRASH_META = "_hemiunu_trash.json";
const TRASH_KEEP = 12; // keep the most recent N snapshots
const TRASH_MAX_AGE_DAYS = 21;
// Hard cap on total recycle-bin size so 12 snapshots of a large repo can't
// quietly eat tens of GB. Newest snapshots are kept; older ones drop first.
const TRASH_MAX_TOTAL_MB = 500;

export function workspacesRoot(): string {
  return join(configDir(), "tmp", "teams");
}

/** Local checkout path for a repo ("owner/name"). */
export function workspacePath(repo: string): string {
  const [owner, name] = normalizeRepo(repo).split("/");
  return join(workspacesRoot(), owner, name ?? "repo");
}

export function trashRoot(): string {
  return join(configDir(), "trash");
}

// --- local (no-team) session workspace --------------------------------------
// When there's no team, prototype work lives in a per-session folder under
// ~/.hemiunu/tmp/local/<sessionId> (flat: PROTOTYPE.md + the prototype files at
// the same level), so it never touches the launch folder and migrates cleanly
// into a repo when the user creates a team.

// The team's living knowledge file, kept at the repo root. Duplicated as a
// literal (not imported from ./prototypes) to avoid an import cycle —
// prototypes.ts already imports localWorkspaceDir from here.
const PROTOTYPE_MD = "PROTOTYPE.md";

let localSessionId = "default";

/** Set the id for this run's local (no-team) workspace folder. */
export function setLocalSession(id: string): void {
  localSessionId = id?.trim() || "default";
}

/** The local (no-team) session workspace folder. */
export function localWorkspaceDir(): string {
  // A turn bound to a no-team workspace carries its own session id, so several
  // local sessions stay isolated; outside a turn, fall back to the run default.
  const id = currentWorkspace()?.localSessionId ?? localSessionId;
  return join(configDir(), "tmp", "local", id);
}

/**
 * The active prototype working directory — flat at its root. The team's checkout
 * when a team is selected, else the local session folder. This is where the
 * prototyper writes, where PROTOTYPE.md lives locally, and what the preview serves.
 */
export function activeProtoDir(): string {
  const repo = resolveRepo();
  return repo ? workspacePath(repo) : localWorkspaceDir();
}

// --- low-level git -----------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// The token is read from this env var by the credential helper below — NOT
// embedded in the command line, so it never appears in the process list (`ps`).
const GIT_TOKEN_ENV = "HEMIUNU_GIT_TOKEN";

/** Auth for network git ops without persisting the token anywhere on disk. The
 *  `-c` value carries only the env var NAME; the secret travels in the child's
 *  environment (see `git()`), keeping it out of argv. */
function authArgs(): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; }; f`,
  ];
}

function git(args: string[], opts: { cwd?: string; token?: string } = {}): Promise<GitResult> {
  const full = [...(opts.token ? authArgs() : []), ...args];
  const env = opts.token ? { ...process.env, [GIT_TOKEN_ENV]: opts.token } : process.env;
  return new Promise((resolve) => {
    execFile(
      "git",
      full,
      { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

async function gitOut(args: string[], cwd: string): Promise<string> {
  return (await git(args, { cwd })).stdout.trim();
}

// --- recycle bin -------------------------------------------------------------

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugRepo(repo: string): string {
  return normalizeRepo(repo).replace("/", "__");
}

/** Copy a directory tree, skipping node_modules / .git / the trash marker. */
function copyTree(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const b = basename(s);
      return b !== "node_modules" && b !== ".git" && b !== TRASH_META;
    },
  });
}

/**
 * Snapshot a working copy into the recycle bin (copy only — the caller decides
 * whether to also remove the original). Returns the bin entry path.
 */
export function binWorkspace(srcPath: string, repo: string, reason: string): string {
  const entry = join(trashRoot(), `${slugRepo(repo)}__${stamp()}`);
  mkdirSync(entry, { recursive: true });
  if (existsSync(srcPath)) copyTree(srcPath, entry);
  writeFileSync(
    join(entry, TRASH_META),
    `${JSON.stringify({ repo: normalizeRepo(repo), reason, time: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  pruneTrash();
  return entry;
}

export interface TrashEntry {
  id: string;
  repo: string;
  reason: string;
  time: string;
}

/** List recycle-bin snapshots, newest first. */
export function listTrash(): TrashEntry[] {
  const root = trashRoot();
  if (!existsSync(root)) return [];
  const out: TrashEntry[] = [];
  for (const id of readdirSync(root)) {
    const metaPath = join(root, id, TRASH_META);
    if (!existsSync(metaPath)) continue;
    try {
      const m = JSON.parse(readFileSync(metaPath, "utf8")) as {
        repo?: string;
        reason?: string;
        time?: string;
      };
      out.push({ id, repo: m.repo ?? "?", reason: m.reason ?? "", time: m.time ?? "" });
    } catch {
      // skip a malformed entry
    }
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

/**
 * Restore a bin snapshot to a fresh, clearly-named folder next to the workspace
 * (never clobbering an active checkout). Returns the restored path.
 */
export function restoreTrash(id: string): string {
  const entry = join(trashRoot(), id);
  if (!existsSync(entry)) throw new Error(`no recycle-bin entry '${id}'`);
  let repo = id.split("__").slice(0, 2).join("/");
  const metaPath = join(entry, TRASH_META);
  if (existsSync(metaPath)) {
    try {
      repo = (JSON.parse(readFileSync(metaPath, "utf8")) as { repo?: string }).repo ?? repo;
    } catch {
      // fall back to the id-derived repo
    }
  }
  const [owner, name] = normalizeRepo(repo).split("/");
  const dest = join(workspacesRoot(), owner, `${name ?? "repo"}__restored__${stamp()}`);
  mkdirSync(dirname(dest), { recursive: true });
  copyTree(entry, dest); // copyTree skips the trash marker
  return dest;
}

/** Total size of a directory tree in bytes (best-effort; skips unreadable files). */
function dirSize(p: string): number {
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, e.name);
    try {
      total += e.isDirectory() ? dirSize(full) : statSync(full).size;
    } catch {
      // skip a vanished/unreadable file
    }
  }
  return total;
}

/**
 * Keep the newest TRASH_KEEP entries, drop anything older than the max age, and
 * enforce a total-size budget (oldest survivors drop first; the newest snapshot
 * is always kept). Bounds disk use without ever touching an active checkout.
 */
function pruneTrash(): void {
  const entries = listTrash(); // newest first
  const cutoff = Date.now() - TRASH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const survivors: string[] = [];
  entries.forEach((e, i) => {
    const tooOld = e.time ? new Date(e.time).getTime() < cutoff : false;
    if (i >= TRASH_KEEP || tooOld) {
      rmSync(join(trashRoot(), e.id), { recursive: true, force: true });
    } else {
      survivors.push(e.id);
    }
  });

  const budget = TRASH_MAX_TOTAL_MB * 1024 * 1024;
  let used = 0;
  survivors.forEach((id, i) => {
    const entry = join(trashRoot(), id);
    if (!existsSync(entry)) return;
    used += dirSize(entry);
    if (i > 0 && used > budget) rmSync(entry, { recursive: true, force: true });
  });
}

// --- sync --------------------------------------------------------------------

export interface EnsureOptions {
  token?: string;
  /** Override the clone URL (tests use a local repo path). */
  cloneUrl?: string;
}

export interface EnsureResult {
  path: string;
  /** What happened: a fresh clone, fast-forward sync, reset-to-latest, kept local edits, or failure. */
  action: "cloned" | "synced" | "reset" | "kept" | "failed";
  note?: string;
  /** Recycle-bin entry path, if anything was snapshotted. */
  binned?: string;
}

async function isValidWorkspace(path: string, cloneUrl: string): Promise<boolean> {
  if (!existsSync(join(path, ".git"))) return false;
  return (await gitOut(["remote", "get-url", "origin"], path)) === cloneUrl;
}

/**
 * Guarantee the team's workspace is a git CHECKOUT we can write to and commit
 * from, cloning only if it's missing or not a valid clone. Unlike
 * ensureWorkspace it does NOT fetch/reset, so it never discards in-progress
 * edits — its only job is to make sure prototype files don't land in a bare,
 * un-committable directory (the cause of "fatal: not a git repository" on push).
 */
export async function ensureCloned(repo: string, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const norm = normalizeRepo(repo);
  const path = workspacePath(norm);
  const cloneUrl = opts.cloneUrl ?? `https://github.com/${norm}.git`;
  if (await isValidWorkspace(path, cloneUrl)) return { path, action: "kept" };
  // Missing or invalid (e.g. files were written without a clone) → snapshot any
  // leftovers, then clone fresh so the dir is a real, committable checkout.
  let binned: string | undefined;
  if (existsSync(path)) {
    binned = binWorkspace(path, norm, "replaced an un-initialised workspace before save");
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(dirname(path), { recursive: true });
  const r = await git(["clone", cloneUrl, path], { token: opts.token });
  if (!r.ok) return { path, action: "failed", note: r.stderr.trim().slice(0, 300), binned };
  return { path, action: "cloned", binned };
}

/**
 * Ensure the team's local checkout exists and equals the latest remote, ready to
 * iterate on. The invariant: after this returns "cloned" | "synced" | "reset",
 * the working tree is the latest remote; "kept" means your in-progress edits
 * were preserved because the remote hadn't moved. Anything discarded along the
 * way is snapshotted to the recycle bin first (see `binned`).
 */
export async function ensureWorkspace(
  repo: string,
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  const norm = normalizeRepo(repo);
  const path = workspacePath(norm);
  const cloneUrl = opts.cloneUrl ?? `https://github.com/${norm}.git`;
  const { token } = opts;

  // Missing or invalid (wrong remote / corrupt) → bin any leftovers, clone fresh.
  if (!(await isValidWorkspace(path, cloneUrl))) {
    let binned: string | undefined;
    if (existsSync(path)) {
      binned = binWorkspace(path, norm, "replaced an invalid/leftover workspace");
      rmSync(path, { recursive: true, force: true });
    }
    mkdirSync(dirname(path), { recursive: true });
    const r = await git(["clone", cloneUrl, path], { token });
    if (!r.ok) return { path, action: "failed", note: r.stderr.trim().slice(0, 300), binned };
    return { path, action: "cloned", binned };
  }

  // Valid checkout → fetch, then reconcile against the latest remote.
  const fetched = await git(["fetch", "origin"], { cwd: path, token });
  if (!fetched.ok) return { path, action: "failed", note: fetched.stderr.trim().slice(0, 300) };

  const main = await defaultBranch(path);
  const ident = ["-c", "user.name=Hemiunu", "-c", "user.email=hemiunu@users.noreply.github.com"];
  const dirty = (await gitOut(["status", "--porcelain"], path)).length > 0;

  // NEVER discard in-progress work on a sync. The deferred-publish model keeps
  // un-pushed prototype code locally until the user validates, so first commit
  // any working-tree edits onto the checkpoint branch — they must survive.
  if (dirty) {
    await git(["checkout", "-B", CHECKPOINT_BRANCH], { cwd: path });
    await git(["add", "-A"], { cwd: path });
    const staged = (await gitOut(["diff", "--cached", "--name-only"], path)).length > 0;
    if (staged)
      await git([...ident, "commit", "-m", "Auto-saved prototype work (pre-sync)"], { cwd: path });
  }

  // Does the checkout carry commits the default branch lacks (un-published code)?
  // main also gains PROTOTYPE.md note commits out-of-band, so REPLAY our work on
  // top of the latest main rather than resetting it away. Code and notes touch
  // different files → clean rebase; on a real conflict, keep our work untouched.
  const ahead = (await gitOut(["rev-list", "--count", `origin/${main}..HEAD`], path)) !== "0";
  if (ahead) {
    const rb = await git([...ident, "rebase", `origin/${main}`], { cwd: path });
    if (!rb.ok) {
      await git(["rebase", "--abort"], { cwd: path });
      return {
        path,
        action: "kept",
        note: "kept your work (couldn't auto-rebase onto the latest main)",
      };
    }
    return { path, action: "kept", note: "kept your work, rebased onto the latest main" };
  }

  // No local commits ahead of main → fast-forward the checkout to the latest main.
  await git(["reset", "--hard", `origin/${main}`], { cwd: path });
  await git(["clean", "-fd"], { cwd: path });
  return { path, action: "synced" };
}

// --- new-conversation reconciliation -----------------------------------------

export type ReconcileStatus = "clone" | "aligned" | "diverged" | "offline";

export interface ReconcileResult {
  path: string;
  /**
   * `clone`    — no workspace yet; the next iterate clones latest main (no prompt).
   * `aligned`  — workspace matched main (or was behind); brought to latest, no prompt.
   * `diverged` — un-published work differs from main; the caller should prompt.
   * `offline`  — couldn't reach the remote; left untouched, no prompt.
   */
  status: ReconcileStatus;
  /** True when origin/<default> advanced beyond this workspace's base (e.g. a teammate pushed). */
  mainMoved?: boolean;
  /** Short file-list of what diverges from main, for the prompt. */
  summary?: string;
}

/**
 * Inspect the team's workspace at the start of a NEW conversation and reconcile
 * it with main, by COMPARING CONTENT (not mere existence — a published workspace
 * is kept for further iteration and simply equals main). If the working tree
 * matches the latest main it silently fast-forwards (`aligned`, no prompt); if it
 * carries un-published work it reports `diverged` so the UI can offer Keep /
 * Fresh / Publish. It NEVER discards divergent work itself. No-team (local)
 * prototypes have no main and should not call this.
 */
export async function reconcileWorkspace(
  repo: string,
  opts: EnsureOptions = {},
): Promise<ReconcileResult> {
  const norm = normalizeRepo(repo);
  const path = workspacePath(norm);
  const cloneUrl = opts.cloneUrl ?? `https://github.com/${norm}.git`;
  const { token } = opts;

  if (!(await isValidWorkspace(path, cloneUrl))) return { path, status: "clone" };
  if (!(await git(["fetch", "origin"], { cwd: path, token })).ok)
    return { path, status: "offline" };

  const main = await defaultBranch(path);
  const mainRef = `origin/${main}`;
  // Working tree (incl. committed checkpoint work) vs latest main, plus untracked.
  const diff = await gitOut(["diff", "--name-only", mainRef], path);
  const dirty = (await gitOut(["status", "--porcelain"], path)).length > 0;

  if (!diff && !dirty) {
    // Equals main (possibly just behind) → fast-forward to latest, no prompt.
    await git(["reset", "--hard", mainRef], { cwd: path });
    await git(["clean", "-fd"], { cwd: path });
    return { path, status: "aligned" };
  }

  // Un-published work. Is main an ancestor of HEAD? If not, it moved beyond us.
  const mainMoved = !(await git(["merge-base", "--is-ancestor", mainRef, "HEAD"], { cwd: path }))
    .ok;
  const files = diff.split("\n").filter(Boolean);
  const summary =
    files.slice(0, 8).join(", ") + (files.length > 8 ? `, +${files.length - 8} more` : "");
  return { path, status: "diverged", mainMoved, summary };
}

/**
 * The "start fresh from main" reconcile action: snapshot the un-published work to
 * the recycle bin (recoverable via /restore), then hard-reset the checkout to the
 * latest default branch. Returns the bin entry path.
 */
export async function freshenWorkspace(
  repo: string,
  opts: EnsureOptions = {},
): Promise<{ path: string; binned: string }> {
  const norm = normalizeRepo(repo);
  const path = workspacePath(norm);
  const binned = binWorkspace(
    path,
    norm,
    "started fresh from main — prior un-published work snapshotted",
  );
  await git(["fetch", "origin"], { cwd: path, token: opts.token });
  const main = await defaultBranch(path);
  await git(["checkout", "-B", main, `origin/${main}`], { cwd: path });
  await git(["reset", "--hard", `origin/${main}`], { cwd: path });
  await git(["clean", "-fd"], { cwd: path });
  return { path, binned };
}

/**
 * The "publish" reconcile action: commit + push the workspace to main (rebasing
 * onto the latest first). The workspace is KEPT so the user can keep iterating —
 * publishing is a checkpoint, not the end; it's only cleared on leaving the team
 * (see `discardWorkspace`). Same publish path as `commit_prototype(to='main')`.
 */
export async function publishWorkspace(
  repo: string,
  opts: { token?: string; login?: string; message?: string } = {},
): Promise<PushResult> {
  return commitAndPush(repo, {
    message: opts.message || "Published prototype to main",
    token: opts.token,
    login: opts.login,
    toMain: true,
  });
}

export interface PushResult {
  ok: boolean;
  branch?: string;
  note: string;
}

/** The stable branch auto-checkpoints push to when NOT pushing straight to main. */
export const CHECKPOINT_BRANCH = "hemiunu/checkpoint";

/**
 * Auto-saves commit each turn to a LOCAL CHECKPOINT_BRANCH (`hemiunu/checkpoint`)
 * and do NOT push — so in-progress work is kept in a local commit (surviving the
 * next turn's workspace sync, and keeping the live preview intact) while GitHub
 * only ever sees `main`. `main` updates only when the user ships: the agent runs
 * `commit_prototype(to='main')` or `deploy_prototype` (which publishes + deploys).
 * This matches the "work locally, ship on deploy" flow — no stray branches on
 * GitHub. Flip CHECKPOINT_REMOTE_BACKUP to also push the checkpoint branch to
 * origin as an off-machine backup (e.g. a hosted, ephemeral-workspace setup).
 */
const CHECKPOINT_REMOTE_BACKUP = false;

/** The repo's default branch (what we publish to), from the remote; "main" if unknown. */
async function defaultBranch(path: string): Promise<string> {
  // Prefer the remote's advertised default via origin/HEAD. But not every
  // clone/git version sets origin/HEAD — when it's missing, `rev-parse` echoes
  // the literal "origin/HEAD" (→ "HEAD"), which is NOT a real branch and would
  // make every `rebase origin/HEAD` fail. Fall back to the conventional names
  // (verified to exist on the remote) so a sync never targets a bogus ref.
  const ref = (await gitOut(["rev-parse", "--abbrev-ref", "origin/HEAD"], path))
    .replace(/^origin\//, "")
    .trim();
  if (ref && ref !== "HEAD") return ref;
  for (const cand of ["main", "master"]) {
    const ok = await git(["rev-parse", "--verify", "--quiet", `origin/${cand}`], { cwd: path });
    if (ok.ok) return cand;
  }
  return "main";
}

/**
 * Stage, commit, and push the current workspace. `toMain` pushes the default
 * branch (the "done" action — the caller then discards the workspace); otherwise
 * it pushes a checkpoint branch you can review/preview. Identity is the
 * signed-in GitHub user; auth uses the token (omit for a local remote in tests).
 */
export async function commitAndPush(
  repo: string,
  opts: { message: string; token?: string; login?: string; toMain?: boolean; branch?: string },
): Promise<PushResult> {
  const path = workspacePath(repo);
  if (!existsSync(path)) return { ok: false, note: "No local workspace — run iterate first." };
  // Publishing targets the repo's DEFAULT branch, resolved from the remote — not
  // the current local branch, which auto-checkpoints leave on hemiunu/checkpoint.
  const branch = opts.toMain ? await defaultBranch(path) : (opts.branch ?? `hemiunu/${stamp()}`);
  if (!opts.toMain) await git(["checkout", "-B", branch], { cwd: path });

  await git(["add", "-A"], { cwd: path });
  // Identity for any commit-creating git op (commit AND rebase replay). git
  // refuses to create a commit without one, and the CI runner / fresh clones
  // have no global identity to fall back on.
  const ident = [
    "-c",
    `user.name=${opts.login ?? "Hemiunu"}`,
    "-c",
    `user.email=${opts.login ? `${opts.login}@users.noreply.github.com` : "hemiunu@users.noreply.github.com"}`,
  ];
  const dirty = (await gitOut(["status", "--porcelain"], path)).length > 0;
  if (dirty) {
    const c = await git([...ident, "commit", "-m", opts.message], { cwd: path });
    if (!c.ok)
      return { ok: false, branch, note: `commit failed: ${c.stderr.trim().slice(0, 200)}` };
  }

  // Publishing to main is often non-fast-forward: PROTOTYPE.md notes are committed
  // to main out-of-band (the GitHub Contents API), so main gains commits the local
  // branch lacks. Replay our work on top of the latest main first — code and notes
  // touch different files, so it's a clean rebase — then the push fast-forwards
  // instead of being rejected.
  if (opts.toMain) {
    await git(["fetch", "origin", branch], { cwd: path, token: opts.token });
    const behind = (await gitOut(["rev-list", "--count", `HEAD..origin/${branch}`], path)) !== "0";
    if (behind) {
      const rb = await git([...ident, "rebase", `origin/${branch}`], { cwd: path });
      if (!rb.ok) {
        await git(["rebase", "--abort"], { cwd: path });
        return {
          ok: false,
          branch,
          note: `couldn't auto-merge with the latest ${branch} (a real conflict in the same files) — resolve it manually.`,
        };
      }
    }
  }

  const p = await git(["push", "-u", "origin", `HEAD:${branch}`], { cwd: path, token: opts.token });
  if (!p.ok) return { ok: false, branch, note: `push failed: ${p.stderr.trim().slice(0, 200)}` };
  return {
    ok: true,
    branch,
    note: dirty ? `committed and pushed to ${branch}` : `pushed ${branch} (nothing new)`,
  };
}

/**
 * Auto-save the team's prototype workspace after a turn: stage any changes,
 * commit them to a LOCAL checkpoint branch — so prototype work is preserved
 * across the next turn's workspace sync (which rebases onto latest main and
 * never discards local commits) and the live preview keeps rendering. By default
 * nothing is pushed: GitHub only sees `main`, on publish/deploy. Flip
 * CHECKPOINT_REMOTE_BACKUP to also push the branch to origin as a backup.
 *
 * Best-effort: never throws; a no-op when there's no team, no checkout, or
 * nothing changed since the last save.
 */
export async function checkpointWorkspace(
  repo: string | null,
  opts: { token?: string; login?: string; message?: string } = {},
): Promise<{ pushed: boolean; branch?: string; note: string }> {
  try {
    if (!repo) return { pushed: false, note: "no team" };
    const path = workspacePath(normalizeRepo(repo));
    if (!existsSync(join(path, ".git"))) return { pushed: false, note: "no checkout" };
    // Auto-checkpoints live on their own branch; ensure we're on it (harmless if
    // already there — resets it to HEAD, keeping the working-tree changes).
    await git(["checkout", "-B", CHECKPOINT_BRANCH], { cwd: path });
    await git(["add", "-A"], { cwd: path });
    // Skip entirely when the tree is clean — avoids a needless empty commit.
    if ((await gitOut(["status", "--porcelain"], path)).length === 0) {
      return { pushed: false, branch: CHECKPOINT_BRANCH, note: "nothing changed" };
    }
    // Identity for the commit — git refuses to commit without one, and fresh
    // clones / CI runners have no global identity to fall back on.
    const ident = [
      "-c",
      `user.name=${opts.login ?? "Hemiunu"}`,
      "-c",
      `user.email=${opts.login ? `${opts.login}@users.noreply.github.com` : "hemiunu@users.noreply.github.com"}`,
    ];
    const c = await git([...ident, "commit", "-m", opts.message || "Auto-saved prototype work"], {
      cwd: path,
    });
    if (!c.ok)
      return {
        pushed: false,
        branch: CHECKPOINT_BRANCH,
        note: `commit failed: ${c.stderr.trim().slice(0, 200)}`,
      };
    // Local-only by default — nothing reaches GitHub until publish/deploy.
    if (!CHECKPOINT_REMOTE_BACKUP) {
      return { pushed: false, branch: CHECKPOINT_BRANCH, note: "saved locally" };
    }
    const p = await git(["push", "-u", "origin", `HEAD:${CHECKPOINT_BRANCH}`], {
      cwd: path,
      token: opts.token,
    });
    return {
      pushed: p.ok,
      branch: CHECKPOINT_BRANCH,
      note: p.ok ? "backed up to origin" : `push failed: ${p.stderr.trim().slice(0, 200)}`,
    };
  } catch (e) {
    return { pushed: false, note: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Best-effort restore of a prototype for VIEWING when the local workspace is
 * gone or was reset: ensure a checkout exists, then check out the checkpoint
 * branch if it was ever pushed (only when CHECKPOINT_REMOTE_BACKUP is on).
 * Auto-checkpoints are local by default, so if the workspace is gone this falls
 * back to whatever is on main (the last published version). Returns the
 * workspace path if an index.html is present afterward, else null.
 */
export async function restoreCheckpoint(
  repo: string,
  opts: EnsureOptions = {},
): Promise<string | null> {
  try {
    const cloned = await ensureCloned(normalizeRepo(repo), opts);
    if (cloned.action === "failed") return null;
    const path = cloned.path;
    const fetched = await git(["fetch", "origin", CHECKPOINT_BRANCH], {
      cwd: path,
      token: opts.token,
    });
    if (fetched.ok)
      await git(["checkout", "-B", CHECKPOINT_BRANCH, `origin/${CHECKPOINT_BRANCH}`], {
        cwd: path,
      });
    return existsSync(join(path, "index.html")) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Carry local (no-team) prototype work into a freshly-created team repo: clone
 * the repo, copy the launch folder's PROTOTYPE.md and prototypes/ into the
 * workspace, and push to main — so creating a team instantly brings the local
 * work along instead of starting fresh. Returns what was migrated.
 */
export async function migrateLocalIntoTeam(
  repo: string,
  opts: {
    token?: string;
    login?: string;
    cwd?: string;
    cloneUrl?: string;
    /**
     * Smart-merge two PROTOTYPE.md versions when the adopted repo already has one.
     * Receives both bodies; returns the final file content, or null to fall back
     * to the safe textual concat (so a failed/empty model response never loses data).
     */
    reconcile?: (parts: { local: string; remote: string }) => Promise<string | null>;
  } = {},
): Promise<{ migrated: string[]; pushed: boolean; note: string }> {
  const src = opts.cwd ?? localWorkspaceDir();
  const synced = await ensureWorkspace(repo, { token: opts.token, cloneUrl: opts.cloneUrl });
  if (synced.action === "failed")
    return { migrated: [], pushed: false, note: synced.note ?? "sync failed" };
  const dir = synced.path;
  if (!existsSync(src)) return { migrated: [], pushed: false, note: "no local work to migrate" };
  // PROTOTYPE.md is the team's living knowledge file — never clobber a remote
  // one; it's merged explicitly below. Everything else copies FLAT into the repo
  // root, so the prototype files end up at the same level.
  const skip = (s: string) => {
    const b = basename(s);
    return b !== "node_modules" && b !== ".git" && b !== PROTOTYPE_MD;
  };
  const entries = readdirSync(src).filter((n) => n !== ".git" && n !== "node_modules");
  if (!entries.length) return { migrated: [], pushed: false, note: "no local work to migrate" };
  cpSync(src, dir, { recursive: true, filter: skip });

  // Bring the local PROTOTYPE.md across: take it as-is when the repo has none,
  // else merge — smart reconcile if provided, falling back to a lossless concat.
  const localProto = join(src, PROTOTYPE_MD);
  const remoteProto = join(dir, PROTOTYPE_MD);
  if (existsSync(localProto)) {
    const local = readFileSync(localProto, "utf8");
    if (!existsSync(remoteProto)) {
      writeFileSync(remoteProto, local, "utf8");
    } else {
      const remote = readFileSync(remoteProto, "utf8");
      let merged: string | null = null;
      if (opts.reconcile) {
        try {
          merged = await opts.reconcile({ local, remote });
        } catch {
          merged = null;
        }
      }
      if (!merged || !merged.trim()) {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        merged = `${remote.trimEnd()}\n\n<!-- merged from local session ${day} -->\n\n${local.trim()}\n`;
      }
      writeFileSync(remoteProto, merged, "utf8");
    }
  }

  const pr = await commitAndPush(repo, {
    message: "Import local prototype work",
    token: opts.token,
    login: opts.login,
    toMain: true,
  });
  return { migrated: entries, pushed: pr.ok, note: pr.note };
}

/**
 * Send a team's checkout to the recycle bin and remove it from the workspace
 * area (used after a push to main). Returns the bin entry, or "" if there was
 * nothing to remove.
 */
export function discardWorkspace(repo: string, reason = "removed after push to main"): string {
  const path = workspacePath(repo);
  if (!existsSync(path)) return "";
  const binned = binWorkspace(path, repo, reason);
  rmSync(path, { recursive: true, force: true });
  return binned;
}

/**
 * Move a team's local checkout to its new path after the repo was renamed, and
 * repoint its `origin` to the new URL so iteration/pushes keep working without a
 * re-clone. Best-effort: a no-op when there's no local checkout yet.
 */
export async function renameWorkspace(oldRepo: string, newRepo: string): Promise<void> {
  const from = workspacePath(oldRepo);
  const to = workspacePath(newRepo);
  if (from === to || !existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
  await git(["remote", "set-url", "origin", `https://github.com/${normalizeRepo(newRepo)}.git`], {
    cwd: to,
  });
}
