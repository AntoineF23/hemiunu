/**
 * Hemiunu smoke / eval harness — the MVP "is it alive?" gate.
 *
 *   corepack pnpm smoke            # offline checks + one live turn (M0 gate)
 *   corepack pnpm smoke --offline  # structural checks only, no API calls, no cost
 *
 * Offline checks are deterministic and free (config, context, MCP registry,
 * memory append). The live section runs one real turn through the proxy to
 * prove the engine end-to-end, then a couple of lightweight behavioural evals.
 * Exits non-zero if any check fails, so it doubles as a CI/pre-push gate.
 */
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runTurn,
  loadConfig,
  askModel,
  savePrototype,
  pool,
  subagentPrompt,
  writeUserEnv,
  hasApiKey,
  saveSkill,
  loadSkills,
  loadSkill,
  expandSkill,
  saveSourceMap,
  loadSourceMaps,
  loadSourceMap,
  appendKnowledge,
  normalizeRepo,
  prototypePath,
  upsertUserEnv,
  resolveGithubToken,
  resolveRepo,
  activeProtoDir,
  withWorkspace,
  addTeam,
  switchTeam,
  setCurrentTeam,
  cycleTeam,
  listTeams,
  currentTeam,
  githubClientId,
  requestDeviceCode,
  ensureWorkspace,
  listTrash,
  restoreTrash,
  startPreview,
  stopPreview,
  previewStatus,
  commitAndPush,
  migrateLocalIntoTeam,
  resolveVercelToken,
  setControlHandler,
  requestControl,
} from "@hemiunu/agent-core";
import { execFileSync } from "node:child_process";
import {
  loadContext,
  buildSystemPrompt,
  remember,
  seedContextFiles,
} from "@hemiunu/memory";
import { loadMcpRegistry } from "@hemiunu/mcp";
import { check, assert, collectTurn, report } from "./harness";

const OFFLINE = process.argv.includes("--offline");
// Live gate uses the configured model by default (known-good with the proxy's
// `effort` param — some models, e.g. haiku-4.5, reject it). Override with
// HEMIUNU_EVAL_MODEL to run the gate against a cheaper/different model.
const EVAL_MODEL = process.env.HEMIUNU_EVAL_MODEL ?? loadConfig().model;

async function main() {
  console.log("\n\x1b[1mHemiunu smoke harness\x1b[0m");

  // ---- Offline: structural checks (free, deterministic) ----
  console.log("\n\x1b[2mOffline checks\x1b[0m");

  await check("config loads (model, key; base URL optional)", () => {
    const cfg = loadConfig();
    // baseUrl is optional now (undefined = Anthropic direct).
    assert(cfg.baseUrl === undefined || cfg.baseUrl.startsWith("http"), "baseUrl, if set, should be a URL");
    assert(cfg.model.length > 0, "model id should be set");
    assert(cfg.apiKey.length > 0, "ANTHROPIC_API_KEY should be set");
  });

  await check("context builds the system prompt from soul + global user memory", () => {
    const ctx = loadContext();
    assert(ctx.soul.length > 0, "soul.md should not be empty");
    const sys = buildSystemPrompt(ctx);
    assert(/hemiunu/i.test(sys), "system prompt should name Hemiunu");
    if (ctx.user) assert(sys.includes(ctx.user), "user facts should be included");
  });

  await check("MCP registry parses mcp.json into tool patterns", () => {
    const reg = loadMcpRegistry();
    const known = [...Object.keys(reg.mcpServers), ...reg.skipped.map((s) => s.name)];
    assert(known.length > 0, "mcp.json should declare at least one server");
    for (const name of Object.keys(reg.mcpServers)) {
      assert(
        reg.toolPatterns.includes(`mcp__${name}__*`),
        `enabled server '${name}' should get a wildcard tool pattern`,
      );
    }
  });

  await check("MCP registry skips servers with unset env vars", () => {
    // notion needs NOTION_TOKEN; if unset it must be skipped, not connected.
    const had = process.env.NOTION_TOKEN;
    delete process.env.NOTION_TOKEN;
    try {
      const reg = loadMcpRegistry();
      const notion = reg.skipped.find((s) => s.name === "notion");
      assert(notion !== undefined, "notion should be skipped without NOTION_TOKEN");
      assert(/missing env/.test(notion.reason), "skip reason should cite missing env");
    } finally {
      if (had !== undefined) process.env.NOTION_TOKEN = had;
    }
  });

  await check("remember() writes a user-global note (never the launch folder)", () => {
    const userRoot = mkdtempSync(join(tmpdir(), "hemiunu-user-"));
    try {
      remember("A user fact.", userRoot);
      const user = readFileSync(join(userRoot, "user.md"), "utf8");
      assert(user.includes("A user fact."), "note should land in the global user.md");
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
    }
  });

  await check("fresh install seeds an EMPTY global user.md from the template", () => {
    // Simulate an install: the committed template ships in the app's context/;
    // the live user.md is seeded into a separate user data dir.
    const appRoot = mkdtempSync(join(tmpdir(), "hemiunu-app-"));
    const userRoot = mkdtempSync(join(tmpdir(), "hemiunu-userdir-"));
    const ctx = join(appRoot, "context");
    mkdirSync(ctx, { recursive: true });
    // Resolve from this file (apps/eval/src/) → repo root → context/.
    const repoCtx = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "context");
    try {
      copyFileSync(join(repoCtx, "user.md.example"), join(ctx, "user.md.example"));
      seedContextFiles({ appRoot, userRoot });
      // remember() appends facts as lines starting with "- "; a fresh template has none.
      const user = loadContext({ appRoot, userRoot }).user;
      assert(!/^- \S/m.test(user), `seeded user.md should carry no learned facts, got: ${user.slice(0, 80)}`);
      assert(
        buildSystemPrompt(loadContext({ appRoot, userRoot })).includes("Hemiunu"),
        "persona still wires through on a fresh install",
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
      rmSync(userRoot, { recursive: true, force: true });
    }
  });

  await check("savePrototype writes files FLAT into the dir and blocks traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-proto-"));
    try {
      const saved = savePrototype({
        dir,
        files: [{ path: "index.html", content: "<!doctype html><title>x</title>" }],
      });
      // index.html sits at the dir root (same level as PROTOTYPE.md would).
      assert(saved.indexPath === join(dir, "index.html"), `index.html should be at the root, got: ${saved.indexPath}`);
      assert(existsSync(join(dir, "index.html")), "index.html should be written");
      let threw = false;
      try {
        savePrototype({ dir, files: [{ path: "../../escape.html", content: "x" }] });
      } catch {
        threw = true;
      }
      assert(threw, "writing outside the prototype dir must throw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("pool runs tasks concurrently, capped, and preserves order", async () => {
    let active = 0;
    let maxActive = 0;
    const delays = [40, 20, 30, 10, 25];
    const t0 = Date.now();
    const out = await pool(delays, 3, async (d, i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, d));
      active--;
      return i;
    });
    const elapsed = Date.now() - t0;
    assert(out.join(",") === "0,1,2,3,4", `order must be preserved, got ${out}`);
    assert(maxActive > 1, "tasks should overlap (run concurrently)");
    assert(maxActive <= 3, `concurrency cap of 3 should hold, saw ${maxActive}`);
    assert(elapsed < 110, `concurrent run should beat the 125ms serial sum, took ${elapsed}ms`);
  });

  await check("prototyper prompt carries the design guideline; researcher doesn't", () => {
    const proto = subagentPrompt("prototyper");
    assert(/design principles to apply/i.test(proto), "prototyper prompt should inject the design knowledge");
    assert(/Purpose|Familiarity|earn its place/i.test(proto), "design principles should be present");
    const researcher = subagentPrompt("researcher");
    assert(!/design principles to apply/i.test(researcher), "researcher should NOT carry the design guideline");
  });

  await check("writeUserEnv writes ~/.hemiunu/.env and a user mcp.json overlay merges", () => {
    // Snapshot every env var writeUserEnv may mutate — the live checks below
    // need the real key restored.
    const snap: Record<string, string | undefined> = {
      HEMIUNU_CONFIG_DIR: process.env.HEMIUNU_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      NOTION_TOKEN: process.env.NOTION_TOKEN,
      TAVILY_API_KEY: process.env.TAVILY_API_KEY,
      HEMIUNU_MODEL: process.env.HEMIUNU_MODEL,
    };
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-cfg-"));
    try {
      process.env.HEMIUNU_CONFIG_DIR = dir;
      const p = writeUserEnv({ apiKey: "sk-test-123", notionToken: "ntn_test" });
      assert(p === join(dir, ".env"), `should write to the config dir, got ${p}`);
      const content = readFileSync(p, "utf8");
      assert(/ANTHROPIC_API_KEY=sk-test-123/.test(content), "key should be written");
      assert(/NOTION_TOKEN=ntn_test/.test(content), "notion token should be written");
      assert(hasApiKey(), "hasApiKey() should be true after writing a real key");

      // A user overlay server merges on top of the app's mcp.json defaults.
      const userMcp = join(dir, "mcp.json");
      writeFileSync(
        userMcp,
        JSON.stringify({ mcpServers: { myfs: { type: "stdio", command: "echo", args: ["hi"] } } }),
      );
      const reg = loadMcpRegistry(process.cwd(), userMcp);
      const names = [...Object.keys(reg.mcpServers), ...reg.skipped.map((s) => s.name)];
      assert(names.includes("myfs"), `user overlay server should appear, got: ${names.join(",")}`);
      assert(reg.toolPatterns.includes("mcp__myfs__*"), "user server should get a tool pattern");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  await check("ask_model reports a missing provider key without a network call", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const msg = await askModel({ provider: "openai", model: "gpt-4o", prompt: "hi" });
      assert(/OPENAI_API_KEY/.test(msg), `should name the missing key, got: ${msg.slice(0, 120)}`);
      const unknown = await askModel({ provider: "nope", model: "x", prompt: "hi" });
      assert(/unknown provider/i.test(unknown), `should reject unknown provider, got: ${unknown.slice(0, 80)}`);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  await check("skills: save, list, load, expand $ARGUMENTS, reject reserved names", () => {
    const root = mkdtempSync(join(tmpdir(), "hemiunu-skills-"));
    try {
      const saved = saveSkill({
        name: "Weekly Report!",
        description: "Draft the weekly status report.",
        body: "Write a status report for $ARGUMENTS.",
        root,
      });
      assert(saved.name === "weekly-report", `name should be slugified, got: ${saved.name}`);

      const list = loadSkills(root);
      assert(list.some((s) => s.name === "weekly-report"), "saved skill should be listed");
      assert(
        list[0].description === "Draft the weekly status report.",
        "frontmatter description should round-trip",
      );

      const skill = loadSkill("weekly-report", root);
      assert(!!skill && /status report/.test(skill.body), "skill body should load");
      const expanded = expandSkill(skill!, "Q3 churn");
      assert(
        expanded === "Write a status report for Q3 churn.",
        `$ARGUMENTS should expand, got: ${expanded}`,
      );

      let threw = false;
      try {
        saveSkill({ name: "clear", description: "x", body: "y", root });
      } catch {
        threw = true;
      }
      assert(threw, "a reserved command name must be rejected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await check("source maps: saveSourceMap writes a per-mcp file; load round-trips frontmatter + body", () => {
    const root = mkdtempSync(join(tmpdir(), "hemiunu-sources-"));
    try {
      const saved = saveSourceMap({
        mcp: "Notion",
        description: "Product workspace — roadmap, specs (viewer).",
        body: "## Key locations\n- **Roadmap** — page id `abc123` — quarterly OKRs.",
        root,
      });
      assert(saved.mcp === "notion", `mcp name should be slugified, got: ${saved.mcp}`);

      const list = loadSourceMaps(root);
      assert(list.some((m) => m.mcp === "notion"), "saved map should be listed");
      assert(
        list[0].description === "Product workspace — roadmap, specs (viewer).",
        "frontmatter description should round-trip",
      );
      assert(!!list[0].scanned, "a scanned date should be recorded in frontmatter");

      const full = loadSourceMap("notion", root);
      assert(!!full && /abc123/.test(full.body), "full map body should load on demand");

      assert(loadSourceMap("missing", root) === undefined, "absent map returns undefined");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await check("prototype knowledge: appendKnowledge builds & appends sections", () => {
    // From scratch → frontmatter + a Decisions section.
    const v1 = appendKnowledge(null, "Churn Dashboard", "decision", "Tabs over wizard.", "antoine", "2026-06-23");
    assert(/title: Churn Dashboard/.test(v1), `should set a title, got:\n${v1}`);
    assert(/feature: churn-dashboard/.test(v1), "should set the feature slug");
    assert(/## Decisions\n- 2026-06-23 \(antoine\): Tabs over wizard\./.test(v1), `decision should be appended, got:\n${v1}`);

    // Append a question → new section, existing one preserved, checkbox bullet.
    const v2 = appendKnowledge(v1, "churn-dashboard", "question", "Empty state range?", "marie", "2026-06-24");
    assert(/## Decisions\n- 2026-06-23 \(antoine\): Tabs over wizard\./.test(v2), "prior decision preserved");
    assert(/## Open questions\n- \[ \] Empty state range\? \(marie, 2026-06-24\)/.test(v2), `question appended as a checkbox, got:\n${v2}`);
    assert(/updated: 2026-06-24/.test(v2), "updated date should advance");

    // A second decision lands under the existing Decisions heading.
    const v3 = appendKnowledge(v2, "churn-dashboard", "decision", "Add cohort filter.", "antoine", "2026-06-25");
    const decBlock = v3.slice(v3.indexOf("## Decisions"));
    assert(/Tabs over wizard[\s\S]*Add cohort filter\./.test(decBlock), "second decision appends under Decisions");
  });

  await check("github helpers: repo normalize + path + token resolution", () => {
    assert(normalizeRepo("https://github.com/Acme/proto.git") === "Acme/proto", "https url should normalize");
    assert(normalizeRepo("git@github.com:Acme/proto.git") === "Acme/proto", "ssh url should normalize");
    assert(prototypePath() === "PROTOTYPE.md", `knowledge file should be at the repo root, got ${prototypePath()}`);

    // Explicit env token takes precedence and is found without a network call.
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_smoke";
    try {
      assert(resolveGithubToken() === "ghp_smoke", "env token should resolve");
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
  });

  await check("upsertUserEnv adds & updates a key without clobbering others", () => {
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-env-"));
    const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
    const prevTok = process.env.GITHUB_TOKEN;
    try {
      process.env.HEMIUNU_CONFIG_DIR = dir;
      writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-keep\n");
      upsertUserEnv("GITHUB_TOKEN", "ghp_one");
      let env = readFileSync(join(dir, ".env"), "utf8");
      assert(/ANTHROPIC_API_KEY=sk-keep/.test(env), "existing key must be preserved");
      assert(/GITHUB_TOKEN=ghp_one/.test(env), "new key should be added");
      upsertUserEnv("GITHUB_TOKEN", "ghp_two");
      env = readFileSync(join(dir, ".env"), "utf8");
      assert(/GITHUB_TOKEN=ghp_two/.test(env) && !/ghp_one/.test(env), "key should be updated in place");
      assert((env.match(/GITHUB_TOKEN=/g) ?? []).length === 1, "no duplicate key lines");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
      if (prevTok === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevTok;
    }
  });

  await check("teams: add, switch, cycle (persisted, legacy-migrated)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-team-"));
    const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
    const prevRepo = process.env.HEMIUNU_PROTOTYPE_REPO;
    try {
      process.env.HEMIUNU_CONFIG_DIR = dir;
      delete process.env.HEMIUNU_PROTOTYPE_REPO;
      assert(listTeams().length === 0, "starts with no teams");
      addTeam("https://github.com/Acme/alpha.git");
      addTeam("Acme/beta");
      assert(JSON.stringify(listTeams()) === '["Acme/alpha","Acme/beta"]', `two teams, got ${listTeams()}`);
      assert(currentTeam() === "Acme/beta", "the latest added becomes current");
      // The cycle ring includes a "no team" slot: beta → (no team) → alpha → beta.
      assert(cycleTeam() === "", "cycles past the last team to 'no team' (local)");
      assert(currentTeam() === undefined, "'no team' means undefined (local)");
      assert(cycleTeam() === "Acme/alpha", "then on to the first team");
      assert(switchTeam("Acme/beta") === true, "switch to an existing team");
      assert(currentTeam() === "Acme/beta", "current reflects the switch");
      assert(switchTeam("Acme/nope") === false, "switching to an unknown team fails");
      setCurrentTeam(null);
      assert(currentTeam() === undefined, "setCurrentTeam(null) selects no team");
      // legacy { repo } migrates to the new shape.
      writeFileSync(join(dir, "team.json"), JSON.stringify({ repo: "Acme/legacy" }));
      assert(currentTeam() === "Acme/legacy", "legacy single-repo config migrates");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
      if (prevRepo === undefined) delete process.env.HEMIUNU_PROTOTYPE_REPO;
      else process.env.HEMIUNU_PROTOTYPE_REPO = prevRepo;
    }
  });

  await check("workspace binding: a turn's repo is isolated from the global team & concurrent turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-ws-"));
    const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
    const prevRepo = process.env.HEMIUNU_PROTOTYPE_REPO;
    try {
      process.env.HEMIUNU_CONFIG_DIR = dir;
      delete process.env.HEMIUNU_PROTOTYPE_REPO; // env override must not mask the binding
      addTeam("Acme/alpha"); // global selection
      assert(resolveRepo() === "Acme/alpha", "outside a turn, resolveRepo uses the global team");

      // A turn bound to a different repo sees ITS repo, not the global one.
      withWorkspace({ repo: "Acme/beta" }, () => {
        assert(resolveRepo() === "Acme/beta", "binding overrides the global selection");
        assert(activeProtoDir().endsWith(join("Acme", "beta")), "activeProtoDir follows the binding");
      });
      // A no-team binding means local, even while a global team is set.
      withWorkspace({ repo: null }, () => {
        assert(resolveRepo() === undefined, "a null binding means no-team (local)");
      });
      // The binding doesn't leak out.
      assert(resolveRepo() === "Acme/alpha", "the global selection is intact after the turn");

      // Two concurrent turns must each keep their own repo across awaits — the
      // core guarantee that makes running several teams at once safe.
      const seen: string[] = [];
      const turn = (repo: string) =>
        withWorkspace({ repo }, async () => {
          await new Promise((r) => setTimeout(r, repo === "Acme/beta" ? 5 : 15));
          seen.push(`${repo}=${resolveRepo()}`);
        });
      await Promise.all([turn("Acme/beta"), turn("Acme/gamma")]);
      assert(seen.includes("Acme/beta=Acme/beta"), "beta turn kept its repo across the await");
      assert(seen.includes("Acme/gamma=Acme/gamma"), "gamma turn kept its repo across the await");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
      if (prevRepo === undefined) delete process.env.HEMIUNU_PROTOTYPE_REPO;
      else process.env.HEMIUNU_PROTOTYPE_REPO = prevRepo;
    }
  });

  await check("github device flow: client-id resolution + refuses without one", async () => {
    const prev = process.env.HEMIUNU_GITHUB_CLIENT_ID;
    try {
      delete process.env.HEMIUNU_GITHUB_CLIENT_ID;
      // No env and no shipped default → no client id → requestDeviceCode throws
      // BEFORE any network call.
      if (!githubClientId()) {
        let threw = false;
        try {
          await requestDeviceCode();
        } catch {
          threw = true;
        }
        assert(threw, "device flow must refuse without a client id (no network call)");
      }
      process.env.HEMIUNU_GITHUB_CLIENT_ID = "Iv1.smoketest";
      assert(githubClientId() === "Iv1.smoketest", "env client id should resolve");
    } finally {
      if (prev === undefined) delete process.env.HEMIUNU_GITHUB_CLIENT_ID;
      else process.env.HEMIUNU_GITHUB_CLIENT_ID = prev;
    }
  });

  await check("workspace: clone, sync-to-latest, bin discarded edits, restore", async () => {
    const cfg = mkdtempSync(join(tmpdir(), "hemiunu-ws-"));
    const remote = mkdtempSync(join(tmpdir(), "hemiunu-remote-"));
    const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
    const g = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });
    try {
      process.env.HEMIUNU_CONFIG_DIR = cfg;
      // A local "remote" repo with one commit on main (no network).
      g(["init", "-q", "-b", "main"], remote);
      g(["config", "user.email", "t@t.co"], remote);
      g(["config", "user.name", "t"], remote);
      writeFileSync(join(remote, "index.html"), "<h1>v1</h1>");
      g(["add", "."], remote);
      g(["commit", "-qm", "v1"], remote);

      // First iterate → clone the latest.
      let r = await ensureWorkspace("acme/proto", { cloneUrl: remote });
      assert(r.action === "cloned", `should clone, got ${r.action} ${r.note ?? ""}`);
      assert(readFileSync(join(r.path, "index.html"), "utf8").includes("v1"), "cloned content");

      // Make a local edit AND advance the remote → reset to latest, snapshot the edit.
      writeFileSync(join(r.path, "index.html"), "<h1>my local edit</h1>");
      writeFileSync(join(remote, "index.html"), "<h1>v2</h1>");
      g(["commit", "-aqm", "v2"], remote);
      r = await ensureWorkspace("acme/proto", { cloneUrl: remote });
      assert(r.action === "reset", `should reset to latest, got ${r.action} ${r.note ?? ""}`);
      assert(readFileSync(join(r.path, "index.html"), "utf8").includes("v2"), "workspace now at latest");
      assert(!!r.binned, "discarded edits should be snapshotted to the recycle bin");

      // The bin holds the forgotten edit; restore recovers it.
      const entries = listTrash();
      assert(entries.length >= 1, "recycle bin should have an entry");
      const dest = restoreTrash(entries[0].id);
      assert(
        readFileSync(join(dest, "index.html"), "utf8").includes("my local edit"),
        "restore should recover the un-pushed edit",
      );
    } finally {
      rmSync(cfg, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
    }
  });

  await check("preview: static server serves the workspace on localhost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-prev-"));
    try {
      writeFileSync(join(dir, "index.html"), "<h1>hello preview</h1>");
      const r = await startPreview("acme/proto", dir); // no package.json → static server
      assert(!("error" in r), `preview should start, got ${JSON.stringify(r)}`);
      const url = (r as { url: string }).url;
      const body = await (await fetch(url)).text();
      assert(body.includes("hello preview"), `should serve index.html, got: ${body.slice(0, 60)}`);
      assert(previewStatus()?.url === url, "status should report the running preview");
    } finally {
      stopPreview();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("share: commitAndPush commits & pushes to the remote", async () => {
    const cfg = mkdtempSync(join(tmpdir(), "hemiunu-share-"));
    const bare = mkdtempSync(join(tmpdir(), "hemiunu-bare-"));
    const seed = mkdtempSync(join(tmpdir(), "hemiunu-seed-"));
    const verify = mkdtempSync(join(tmpdir(), "hemiunu-verify-"));
    const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
    const g = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });
    try {
      process.env.HEMIUNU_CONFIG_DIR = cfg;
      g(["init", "--bare", "-b", "main"], bare);
      // seed the bare remote with one commit
      g(["clone", bare, seed], tmpdir());
      writeFileSync(join(seed, "index.html"), "<h1>v1</h1>");
      g(["config", "user.email", "t@t.co"], seed);
      g(["config", "user.name", "t"], seed);
      g(["add", "."], seed);
      g(["commit", "-qm", "v1"], seed);
      g(["push", "origin", "HEAD:main"], seed);

      // clone into the managed workspace, change a file, push to main
      const r = await ensureWorkspace("acme/proto", { cloneUrl: bare });
      assert(r.action === "cloned", `should clone, got ${r.action} ${r.note ?? ""}`);
      writeFileSync(join(r.path, "index.html"), "<h1>v2 from agent</h1>");
      const pr = await commitAndPush("acme/proto", { message: "v2", login: "tester", toMain: true });
      assert(pr.ok, `push should succeed: ${pr.note}`);

      // the remote received it
      g(["clone", bare, verify], tmpdir());
      assert(
        readFileSync(join(verify, "index.html"), "utf8").includes("v2 from agent"),
        "remote should have the pushed change",
      );
    } finally {
      for (const d of [cfg, bare, seed, verify]) rmSync(d, { recursive: true, force: true });
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
    }
  });

  await check("vercel: token resolves from env (login bypass)", () => {
    const prev = process.env.VERCEL_TOKEN;
    try {
      process.env.VERCEL_TOKEN = "vt_test";
      assert(resolveVercelToken() === "vt_test", "VERCEL_TOKEN should resolve");
    } finally {
      if (prev === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = prev;
    }
  });

  await check("migrate: local prototype work is pushed into a new team repo", async () => {
    const cfg = mkdtempSync(join(tmpdir(), "hemiunu-mcfg-"));
    const bare = mkdtempSync(join(tmpdir(), "hemiunu-mbare-"));
    const seed = mkdtempSync(join(tmpdir(), "hemiunu-mseed-"));
    const local = mkdtempSync(join(tmpdir(), "hemiunu-mlocal-"));
    const verify = mkdtempSync(join(tmpdir(), "hemiunu-mver-"));
    const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
    const g = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });
    try {
      process.env.HEMIUNU_CONFIG_DIR = cfg;
      g(["init", "--bare", "-b", "main"], bare);
      g(["clone", bare, seed], tmpdir());
      writeFileSync(join(seed, "README.md"), "init");
      g(["config", "user.email", "t@t.co"], seed);
      g(["config", "user.name", "t"], seed);
      g(["add", "."], seed);
      g(["commit", "-qm", "init"], seed);
      g(["push", "origin", "HEAD:main"], seed);

      // local (no-team) prototype work — FLAT: index.html + PROTOTYPE.md at root
      writeFileSync(join(local, "index.html"), "<h1>spark</h1>");
      writeFileSync(join(local, "PROTOTYPE.md"), "# Spark");

      const mig = await migrateLocalIntoTeam("acme/spark", { cwd: local, cloneUrl: bare });
      assert(mig.pushed, `should push: ${mig.note}`);
      assert(
        mig.migrated.includes("index.html") && mig.migrated.includes("PROTOTYPE.md"),
        `should migrate both, got: ${mig.migrated.join(",")}`,
      );

      g(["clone", bare, verify], tmpdir());
      // both land at the repo root, same level
      assert(
        readFileSync(join(verify, "index.html"), "utf8").includes("spark"),
        "remote should have index.html at the root",
      );
      assert(existsSync(join(verify, "PROTOTYPE.md")), "remote should have PROTOTYPE.md at the root");
    } finally {
      for (const d of [cfg, bare, seed, local, verify]) rmSync(d, { recursive: true, force: true });
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
    }
  });

  await check("control bridge: requestControl routes to the registered handler", async () => {
    try {
      setControlHandler(async (e) => (e.type === "create-team" ? `made ${e.name}` : `switched ${e.repo}`));
      assert((await requestControl({ type: "create-team", name: "foo" })) === "made foo", "should route create");
      assert((await requestControl({ type: "switch-team", repo: "a/b" })) === "switched a/b", "should route switch");
    } finally {
      setControlHandler(null);
    }
    const none = await requestControl({ type: "switch-team", repo: "a/b" });
    assert(/no interactive session/i.test(none), `no handler → message, got: ${none}`);
  });

  if (OFFLINE) return report();

  // ---- Live: one real turn through the proxy (the M0 gate) ----
  console.log(`\n\x1b[2mLive checks (model: ${EVAL_MODEL})\x1b[0m`);

  let liveCost = 0;

  await check("engine completes a turn and returns text", async () => {
    const { text, cost } = await collectTurn("Reply with exactly: PONG", EVAL_MODEL);
    liveCost += cost;
    assert(text.trim().length > 0, "expected a non-empty response");
    assert(/pong/i.test(text), `expected the model to echo PONG, got: ${text.slice(0, 80)}`);
  });

  await check("agent identifies as Hemiunu (persona wired through)", async () => {
    const sys = buildSystemPrompt(loadContext());
    let text = "";
    for await (const m of runTurn({
      prompt: "In one short sentence, what is your name and role?",
      model: EVAL_MODEL,
      systemPrompt: sys,
    })) {
      const msg = m as Record<string, any>;
      if (msg.type === "result") {
        if (typeof msg.result === "string") text = msg.result;
        if (typeof msg.total_cost_usd === "number") liveCost += msg.total_cost_usd;
      }
    }
    assert(/hemiunu/i.test(text), `expected the agent to call itself Hemiunu, got: ${text.slice(0, 120)}`);
  });

  await check("delegates to the researcher subagent and grounds the answer", async () => {
    // Give it a real source (this repo via the filesystem MCP) and a research
    // question; expect it to delegate to `researcher` and answer from the file.
    const mcpServers = {
      filesystem: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      },
    };
    let delegated = false;
    let text = "";
    for await (const m of runTurn({
      prompt:
        "Research this project's README.md and tell me in one sentence what Hemiunu is. Ground it in the file.",
      model: EVAL_MODEL,
      researchModel: EVAL_MODEL,
      mcpServers,
      toolPatterns: ["mcp__filesystem__*"],
    })) {
      const msg = m as Record<string, any>;
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) {
          if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") &&
              b.input?.subagent_type === "researcher") {
            delegated = true;
          }
        }
      }
      if (msg.type === "result") {
        if (typeof msg.result === "string") text = msg.result;
        if (typeof msg.total_cost_usd === "number") liveCost += msg.total_cost_usd;
      }
    }
    assert(delegated, "expected the main loop to delegate to the researcher subagent");
    assert(/product agent/i.test(text), `expected a grounded answer from the README, got: ${text.slice(0, 120)}`);
  });

  await check("ask_model reaches a configured provider", async () => {
    // Use whichever provider is actually configured in this environment.
    let provider: string | undefined;
    let model = "";
    if (process.env.ANTHROPIC_BASE_URL) {
      provider = "proxy";
      model = "gemini-2.5-flash";
    } else if (process.env.OPENAI_API_KEY) {
      provider = "openai";
      model = "gpt-4o-mini";
    }
    if (!provider) {
      console.log("      \x1b[2m(skipped: no ask_model provider configured)\x1b[0m");
      return;
    }
    // Retry transient upstream hiccups — this checks OUR tool, not model uptime.
    let text = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      text = await askModel({ provider, model, prompt: "Reply with exactly: PONG" });
      if (/pong/i.test(text)) return;
      if (!/HTTP 5\d\d|timeout/i.test(text)) break; // a real error — stop and fail
    }
    if (/HTTP 5\d\d|timeout/i.test(text)) {
      console.log(`      \x1b[2m(skipped: ${provider} upstream unavailable — ${text.slice(0, 50)})\x1b[0m`);
      return;
    }
    assert(/pong/i.test(text), `expected PONG from ${provider}/${model}, got: ${text.slice(0, 120)}`);
  });

  console.log(`\n\x1b[2m  live turns cost ~$${liveCost.toFixed(4)}\x1b[0m`);
  report();
}

main().catch((err) => {
  console.error("\n\x1b[31mharness crashed:\x1b[0m", err);
  process.exit(1);
});
