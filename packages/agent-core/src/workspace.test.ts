import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_BRANCH,
  checkpointWorkspace,
  commitAndPush,
  discardWorkspace,
  ensureWorkspace,
  freshenWorkspace,
  listTrash,
  localWorkspaceDir,
  migrateLocalIntoTeam,
  reconcileWorkspace,
  renameWorkspace,
  restoreTrash,
  setLocalSession,
  workspacePath,
  workspacesRoot,
} from "./workspace";

// All tests are fully offline: "origin" is a local bare repo, and every
// workspace/trash path lives under a per-test HEMIUNU_CONFIG_DIR temp dir.

const REPO = "acme/app";

function sh(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run `fn` with an isolated config dir, restoring the env var afterwards. */
async function withConfigDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const prev = process.env.HEMIUNU_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-ws-"));
  process.env.HEMIUNU_CONFIG_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
    else process.env.HEMIUNU_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A throwaway "GitHub": a local bare repo seeded with one commit on main. */
function makeOrigin(
  root: string,
  files: Record<string, string> = { "index.html": "<h1>v1</h1>" },
): { bare: string; seed: string } {
  const seed = join(root, "_fixtures", "seed");
  mkdirSync(seed, { recursive: true });
  sh(["init", "-b", "main", "."], seed);
  sh(["config", "user.email", "seed@example.com"], seed);
  sh(["config", "user.name", "Seed"], seed);
  sh(["config", "commit.gpgsign", "false"], seed);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(seed, name), body);
  sh(["add", "-A"], seed);
  sh(["commit", "-m", "seed"], seed);
  const bare = join(root, "_fixtures", "origin.git");
  sh(["clone", "--bare", seed, bare], root);
  return { bare, seed };
}

/** Land a teammate commit on origin/main (via the seed clone). */
function pushToOrigin(seed: string, bare: string, file: string, body: string, msg: string): void {
  writeFileSync(join(seed, file), body);
  sh(["add", "-A"], seed);
  sh(["commit", "-m", msg], seed);
  sh(["push", bare, "main:main"], seed);
}

test("workspacePath resolves under the config dir and normalizes repo forms", async () => {
  await withConfigDir((dir) => {
    const expected = join(dir, "tmp", "teams", "acme", "widget");
    assert.equal(workspacePath("acme/widget"), expected);
    assert.equal(workspacePath("https://github.com/acme/widget.git"), expected);
    assert.equal(workspacePath("git@github.com:acme/widget.git"), expected);
    assert.ok(expected.startsWith(workspacesRoot()));
  });
});

test("localWorkspaceDir is per-session and falls back to 'default' on a blank id", async () => {
  await withConfigDir((dir) => {
    try {
      setLocalSession("abc123");
      assert.equal(localWorkspaceDir(), join(dir, "tmp", "local", "abc123"));
      setLocalSession("   ");
      assert.equal(localWorkspaceDir(), join(dir, "tmp", "local", "default"));
    } finally {
      setLocalSession("default");
    }
  });
});

test("ensureWorkspace clones a missing workspace from origin", async () => {
  await withConfigDir(async (dir) => {
    const { bare } = makeOrigin(dir);
    const r = await ensureWorkspace(REPO, { cloneUrl: bare });
    assert.equal(r.action, "cloned");
    assert.equal(r.path, workspacePath(REPO));
    assert.ok(existsSync(join(r.path, ".git")));
    assert.equal(readFileSync(join(r.path, "index.html"), "utf8"), "<h1>v1</h1>");
    // Idempotent when already at the latest main.
    const again = await ensureWorkspace(REPO, { cloneUrl: bare });
    assert.equal(again.action, "synced");
  });
});

test("ensureWorkspace fast-forwards a clean checkout when main moved", async () => {
  await withConfigDir(async (dir) => {
    const { bare, seed } = makeOrigin(dir);
    await ensureWorkspace(REPO, { cloneUrl: bare });
    pushToOrigin(seed, bare, "index.html", "<h1>v2</h1>", "teammate edit");
    const r = await ensureWorkspace(REPO, { cloneUrl: bare });
    assert.equal(r.action, "synced");
    assert.equal(readFileSync(join(r.path, "index.html"), "utf8"), "<h1>v2</h1>");
    assert.equal(sh(["status", "--porcelain"], r.path), "");
  });
});

test("ensureWorkspace never discards edits: auto-commits them and rebases onto latest main", async () => {
  await withConfigDir(async (dir) => {
    const { bare, seed } = makeOrigin(dir);
    const first = await ensureWorkspace(REPO, { cloneUrl: bare });
    writeFileSync(join(first.path, "app.js"), "local work");
    // main gains an out-of-band commit touching a DIFFERENT file → clean rebase.
    pushToOrigin(seed, bare, "notes.md", "note", "out-of-band note");
    const r = await ensureWorkspace(REPO, { cloneUrl: bare });
    assert.equal(r.action, "kept");
    assert.match(r.note ?? "", /rebased onto the latest main/);
    // Both the local edit and the teammate's commit are present…
    assert.equal(readFileSync(join(r.path, "app.js"), "utf8"), "local work");
    assert.equal(readFileSync(join(r.path, "notes.md"), "utf8"), "note");
    // …the edit lives in a commit on the checkpoint branch, not floating dirty.
    assert.equal(sh(["rev-parse", "--abbrev-ref", "HEAD"], r.path), CHECKPOINT_BRANCH);
    assert.match(sh(["log", "--format=%s"], r.path), /Auto-saved prototype work \(pre-sync\)/);
    assert.equal(sh(["status", "--porcelain"], r.path), "");
  });
});

test("ensureWorkspace serializes concurrent same-repo calls (no git race)", async () => {
  await withConfigDir(async (dir) => {
    const { bare } = makeOrigin(dir);
    // Fire several overlapping ensureWorkspace calls for the SAME repo. Without
    // the per-repo lock these would race on one checkout dir (clone into a
    // half-populated tree, competing fetch/reset) and throw or corrupt it.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureWorkspace(REPO, { cloneUrl: bare })),
    );
    // Every call resolves to a real, non-failed checkout at the same path…
    for (const r of results) {
      assert.notEqual(r.action, "failed");
      assert.equal(r.path, workspacePath(REPO));
    }
    // …and the final tree is a clean, valid clone of origin.
    const path = workspacePath(REPO);
    assert.ok(existsSync(join(path, ".git")));
    assert.equal(readFileSync(join(path, "index.html"), "utf8"), "<h1>v1</h1>");
    assert.equal(sh(["status", "--porcelain"], path), "");
    // Exactly one clone happened; the rest saw a valid checkout and synced.
    assert.equal(results.filter((r) => r.action === "cloned").length, 1);
  });
});

test("reconcileWorkspace: 'clone' when missing, 'aligned' when the tree equals main", async () => {
  await withConfigDir(async (dir) => {
    const { bare } = makeOrigin(dir);
    const missing = await reconcileWorkspace(REPO, { cloneUrl: bare });
    assert.equal(missing.status, "clone");
    await ensureWorkspace(REPO, { cloneUrl: bare });
    const r = await reconcileWorkspace(REPO, { cloneUrl: bare });
    assert.equal(r.status, "aligned");
    assert.equal(sh(["status", "--porcelain"], r.path), "");
  });
});

test("reconcileWorkspace: 'diverged' reports un-published work and whether main moved", async () => {
  await withConfigDir(async (dir) => {
    const { bare, seed } = makeOrigin(dir);
    const ws = await ensureWorkspace(REPO, { cloneUrl: bare });
    writeFileSync(join(ws.path, "index.html"), "<h1>wip</h1>");

    const r = await reconcileWorkspace(REPO, { cloneUrl: bare });
    assert.equal(r.status, "diverged");
    assert.equal(r.mainMoved, false);
    assert.match(r.summary ?? "", /index\.html/);
    // It must NOT have touched the divergent work.
    assert.equal(readFileSync(join(ws.path, "index.html"), "utf8"), "<h1>wip</h1>");

    // A teammate pushes → same divergence now also flags mainMoved.
    pushToOrigin(seed, bare, "notes.md", "note", "teammate push");
    const moved = await reconcileWorkspace(REPO, { cloneUrl: bare });
    assert.equal(moved.status, "diverged");
    assert.equal(moved.mainMoved, true);
  });
});

test("commitAndPush(toMain) publishes the workspace to the default branch on origin", async () => {
  await withConfigDir(async (dir) => {
    // No workspace yet → a clear failure, no throw.
    const none = await commitAndPush(REPO, { message: "x", toMain: true });
    assert.equal(none.ok, false);
    assert.match(none.note, /No local workspace/);

    const { bare } = makeOrigin(dir);
    const ws = await ensureWorkspace(REPO, { cloneUrl: bare });
    writeFileSync(join(ws.path, "feature.js"), "shipped");
    const r = await commitAndPush(REPO, { message: "Ship feature", toMain: true, login: "alice" });
    assert.equal(r.ok, true);
    assert.equal(r.branch, "main");
    assert.equal(sh(["log", "-1", "--format=%s", "main"], bare), "Ship feature");
    assert.equal(sh(["log", "-1", "--format=%ae", "main"], bare), "alice@users.noreply.github.com");
  });
});

test("commitAndPush(toMain) replays local work on top of a moved main instead of failing", async () => {
  await withConfigDir(async (dir) => {
    const { bare, seed } = makeOrigin(dir);
    const ws = await ensureWorkspace(REPO, { cloneUrl: bare });
    writeFileSync(join(ws.path, "feature.js"), "shipped");
    // main moves out-of-band (e.g. a PROTOTYPE.md note) before we publish.
    pushToOrigin(seed, bare, "notes.md", "note", "out-of-band note");
    const r = await commitAndPush(REPO, { message: "Ship feature", toMain: true });
    assert.equal(r.ok, true);
    const subjects = sh(["log", "--format=%s", "main"], bare).split("\n");
    assert.deepEqual(subjects, ["Ship feature", "out-of-band note", "seed"]);
  });
});

test("checkpointWorkspace saves to a local checkpoint branch and keeps artifacts out of git", async () => {
  await withConfigDir(async (dir) => {
    assert.equal((await checkpointWorkspace(null)).note, "no team");
    assert.equal((await checkpointWorkspace(REPO)).note, "no checkout");

    const { bare } = makeOrigin(dir);
    const ws = await ensureWorkspace(REPO, { cloneUrl: bare });
    writeFileSync(join(ws.path, "app.js"), "work in progress");
    mkdirSync(join(ws.path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(ws.path, "node_modules", "pkg", "index.js"), "junk");
    mkdirSync(join(ws.path, "dist"), { recursive: true });
    writeFileSync(join(ws.path, "dist", "bundle.js"), "junk");

    const r = await checkpointWorkspace(REPO);
    assert.equal(r.pushed, false);
    assert.equal(r.branch, CHECKPOINT_BRANCH);
    assert.equal(r.note, "saved locally");
    assert.equal(sh(["rev-parse", "--abbrev-ref", "HEAD"], ws.path), CHECKPOINT_BRANCH);
    assert.equal(sh(["log", "-1", "--format=%s"], ws.path), "Auto-saved prototype work");
    const tracked = sh(["ls-files"], ws.path);
    assert.ok(tracked.includes("app.js"));
    assert.ok(!tracked.includes("node_modules"));
    assert.ok(!tracked.includes("dist/"));
    assert.match(readFileSync(join(ws.path, ".gitignore"), "utf8"), /node_modules\//);
    // Local-only: GitHub (the bare origin) never sees the checkpoint branch.
    assert.ok(!sh(["for-each-ref", "--format=%(refname)"], bare).includes(CHECKPOINT_BRANCH));
    // Clean tree → no needless empty commit.
    assert.equal((await checkpointWorkspace(REPO)).note, "nothing changed");
  });
});

test("discardWorkspace bins the checkout and restoreTrash brings it back beside the workspace", async () => {
  await withConfigDir(async () => {
    const path = workspacePath(REPO);
    mkdirSync(join(path, "node_modules"), { recursive: true });
    writeFileSync(join(path, "index.html"), "precious");
    writeFileSync(join(path, "node_modules", "junk.js"), "junk");

    const binned = discardWorkspace(REPO, "left the team");
    assert.ok(!existsSync(path)); // removed from the workspace area…
    assert.equal(readFileSync(join(binned, "index.html"), "utf8"), "precious");
    assert.ok(!existsSync(join(binned, "node_modules"))); // …snapshotted minus artifacts

    const entries = listTrash();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].repo, REPO);
    assert.equal(entries[0].reason, "left the team");

    const restored = restoreTrash(entries[0].id);
    assert.notEqual(restored, path); // never clobbers the active checkout path
    assert.match(restored, /__restored__/);
    assert.equal(readFileSync(join(restored, "index.html"), "utf8"), "precious");
    assert.ok(!existsSync(join(restored, "_hemiunu_trash.json"))); // marker stays in the bin

    assert.equal(discardWorkspace(REPO), ""); // nothing left to remove
    assert.throws(() => restoreTrash("no-such-entry"), /no recycle-bin entry/);
  });
});

test("freshenWorkspace snapshots un-published work then hard-resets to the latest main", async () => {
  await withConfigDir(async (dir) => {
    const { bare } = makeOrigin(dir);
    const ws = await ensureWorkspace(REPO, { cloneUrl: bare });
    writeFileSync(join(ws.path, "index.html"), "<h1>wip</h1>");
    writeFileSync(join(ws.path, "extra.js"), "untracked");

    const { path, binned } = await freshenWorkspace(REPO, { cloneUrl: bare });
    // The abandoned work is recoverable from the bin…
    assert.equal(readFileSync(join(binned, "index.html"), "utf8"), "<h1>wip</h1>");
    assert.equal(readFileSync(join(binned, "extra.js"), "utf8"), "untracked");
    // …and the checkout is exactly the latest main again.
    assert.equal(readFileSync(join(path, "index.html"), "utf8"), "<h1>v1</h1>");
    assert.ok(!existsSync(join(path, "extra.js")));
    assert.equal(sh(["rev-parse", "--abbrev-ref", "HEAD"], path), "main");
    assert.equal(sh(["status", "--porcelain"], path), "");
  });
});

test("renameWorkspace moves the checkout to the new path and repoints origin", async () => {
  await withConfigDir(async () => {
    const from = workspacePath("acme/old-name");
    mkdirSync(from, { recursive: true });
    sh(["init", "-b", "main", "."], from);
    sh(["remote", "add", "origin", "https://github.com/acme/old-name.git"], from);
    writeFileSync(join(from, "index.html"), "keep me");

    await renameWorkspace("acme/old-name", "acme/new-name");
    const to = workspacePath("acme/new-name");
    assert.ok(!existsSync(from));
    assert.equal(readFileSync(join(to, "index.html"), "utf8"), "keep me");
    assert.equal(sh(["remote", "get-url", "origin"], to), "https://github.com/acme/new-name.git");

    // No-ops: nothing at the old path / old and new resolve to the same path.
    await renameWorkspace("acme/ghost", "acme/other");
    await renameWorkspace("acme/new-name", "https://github.com/acme/new-name.git");
    assert.ok(existsSync(join(to, "index.html")));
  });
});

test("migrateLocalIntoTeam carries local work into the repo and merges PROTOTYPE.md losslessly", async () => {
  await withConfigDir(async (dir) => {
    const { bare } = makeOrigin(dir, {
      "index.html": "<h1>v1</h1>",
      "PROTOTYPE.md": "# Remote notes\n",
    });
    const local = join(dir, "_fixtures", "local-session");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "app.js"), "local work");
    writeFileSync(join(local, "PROTOTYPE.md"), "# Local notes\n");

    const r = await migrateLocalIntoTeam(REPO, { cwd: local, cloneUrl: bare });
    assert.equal(r.pushed, true);
    assert.ok(r.migrated.includes("app.js"));

    const ws = workspacePath(REPO);
    assert.equal(readFileSync(join(ws, "app.js"), "utf8"), "local work");
    const proto = readFileSync(join(ws, "PROTOTYPE.md"), "utf8");
    assert.match(proto, /Remote notes/); // the repo's copy was never clobbered
    assert.match(proto, /Local notes/); // and the local copy was carried along
    assert.match(proto, /merged from local session/);
    assert.equal(sh(["log", "-1", "--format=%s", "main"], bare), "Import local prototype work");
  });
});
