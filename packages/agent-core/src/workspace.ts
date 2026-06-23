import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { configDir } from "./config";
import { normalizeRepo } from "./github";

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

// --- low-level git -----------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Auth for network git ops without persisting the token anywhere on disk. */
function authArgs(token: string): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=${token}"; }; f`,
  ];
}

function git(args: string[], opts: { cwd?: string; token?: string } = {}): Promise<GitResult> {
  const full = [...(opts.token ? authArgs(opts.token) : []), ...args];
  return new Promise((resolve) => {
    execFile("git", full, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
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
      const m = JSON.parse(readFileSync(metaPath, "utf8")) as { repo?: string; reason?: string; time?: string };
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

/** Keep the newest TRASH_KEEP entries and drop anything older than the max age. */
function pruneTrash(): void {
  const entries = listTrash();
  const cutoff = Date.now() - TRASH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  entries.forEach((e, i) => {
    const tooOld = e.time ? new Date(e.time).getTime() < cutoff : false;
    if (i >= TRASH_KEEP || tooOld) {
      rmSync(join(trashRoot(), e.id), { recursive: true, force: true });
    }
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
 * Ensure the team's local checkout exists and equals the latest remote, ready to
 * iterate on. The invariant: after this returns "cloned" | "synced" | "reset",
 * the working tree is the latest remote; "kept" means your in-progress edits
 * were preserved because the remote hadn't moved. Anything discarded along the
 * way is snapshotted to the recycle bin first (see `binned`).
 */
export async function ensureWorkspace(repo: string, opts: EnsureOptions = {}): Promise<EnsureResult> {
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

  const branch = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], path)) || "HEAD";
  const dirty = (await gitOut(["status", "--porcelain"], path)).length > 0;
  const localSha = await gitOut(["rev-parse", "HEAD"], path);
  const remoteSha = await gitOut(["rev-parse", `origin/${branch}`], path);
  const moved = !!remoteSha && localSha !== remoteSha;

  // In-progress edits on an unchanged remote → keep them (safe, latest base).
  if (dirty && !moved) {
    return { path, action: "kept", note: "kept your in-progress edits (remote unchanged)" };
  }

  // Otherwise bring the tree to the latest remote, binning edits we'd discard.
  let binned: string | undefined;
  if (dirty && moved) {
    binned = binWorkspace(path, norm, "reset to latest — prior un-pushed edits snapshotted");
  }
  await git(["reset", "--hard", `origin/${branch}`], { cwd: path });
  await git(["clean", "-fd"], { cwd: path });
  return { path, action: moved ? "reset" : "synced", binned };
}

/**
 * Send a team's checkout to the recycle bin and remove it from the workspace
 * area (used after a push to main — slice 3). Returns the bin entry, or "" if
 * there was nothing to remove.
 */
export function discardWorkspace(repo: string, reason = "removed after push to main"): string {
  const path = workspacePath(repo);
  if (!existsSync(path)) return "";
  const binned = binWorkspace(path, repo, reason);
  rmSync(path, { recursive: true, force: true });
  return binned;
}
