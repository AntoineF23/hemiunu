/**
 * Hemiunu smoke / eval harness — the MVP "is it alive?" gate.
 *
 *   corepack pnpm smoke                     # offline checks + live turns
 *   corepack pnpm smoke --offline           # structural checks only, no API calls, no cost
 *   corepack pnpm smoke --model <registry-id>   # run the live gate on any registry entry
 *
 * Offline checks are deterministic and free (config, context, MCP registry,
 * memory append) and — since P6-1c — exercise the NEW engine path: the model
 * registry, the permission pipeline, and createEngineRuntime driving the REAL
 * engine loop on a scripted model (zero network). The live section runs real
 * turns through the engine runtime to prove it end-to-end, then a couple of
 * lightweight behavioural evals. Exits non-zero if any check fails, so it
 * doubles as a CI/pre-push gate.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
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
  createEngineRuntime,
  createHemiPipelineConfig,
  setSeenTools,
  setToolPolicy,
  loadToolPolicy,
  appendKnowledge,
  addPrototypeNote,
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
  binWorkspace,
  startPreview,
  stopPreview,
  previewStatus,
  commitAndPush,
  migrateLocalIntoTeam,
  checkpointWorkspace,
  reconcileWorkspace,
  publishWorkspace,
  CHECKPOINT_BRANCH,
  workspacePath,
  cloudflareConfigured,
  projectNameFor,
  activeProvider,
  listDeployProviders,
  setControlHandler,
  requestControl,
  verifyPrototype,
  validateParallelTasks,
} from "@hemiunu/agent-core";
import { execFileSync } from "node:child_process";
import { loadContext, buildSystemPrompt, remember, seedContextFiles } from "@hemiunu/memory";
import { loadMcpRegistry, sandboxStdioCwd } from "@hemiunu/mcp";
import {
  anyModelAvailable,
  createPipeline,
  defaultModels,
  emptyUsage,
  loadModelRegistry,
  modelForTag,
  registryReady,
  resolveDefaultModel,
  type HemiTool,
  type ModelEntry,
  type RunTurnOptions as EngineRunTurnOptions,
  type ToolContext,
  type TurnEvent,
} from "@hemiunu/engine";
import {
  check,
  assert,
  collectTurn,
  collectTurnDetailed,
  parseEvalArgs,
  report,
  resolveEvalModel,
  scriptedResolve,
} from "./harness";

const OFFLINE = process.argv.includes("--offline");
// Live gate uses the configured model by default. Target ANY model registry
// entry with `--model <registry-id>` (validated against the registry so a typo
// fails fast), or with the HEMIUNU_EVAL_MODEL env var.
const EVAL_MODEL = resolveEvalModel(
  parseEvalArgs(process.argv.slice(2)).model ?? process.env.HEMIUNU_EVAL_MODEL,
  loadModelRegistry(),
  loadConfig().model,
);

// --- Engine-path fixtures --------------------------------------------------
// The engine checks run the REAL pipeline / runtime / loop on seams: raw-JSON-
// schema fixture tools (no zod dependency here), a fabricated ToolContext, and
// registry entries whose key env is deliberately unset so any accidental real
// model resolution fails fast instead of hitting the network.

/** A fixture tool that returns a fixed payload (raw JSON Schema input). */
function fixtureTool(name: string, content: string, over: Partial<HemiTool> = {}): HemiTool {
  return {
    name,
    description: `smoke fixture: ${name}`,
    inputSchema: { jsonSchema: { type: "object" } },
    readOnly: true,
    async execute() {
      return { content };
    },
    ...over,
  };
}

/** A fabricated ToolContext capturing emitted TurnEvents. */
function toolCtx(events: TurnEvent[] = []): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "smoke",
    emit: (e) => events.push(e),
    mode: () => "default",
    setMode: () => {},
  };
}

/** A registry entry that can never resolve for real (unset key env). */
function fixtureEntry(id: string, tags?: ModelEntry["tags"]): ModelEntry {
  return {
    id,
    label: id,
    provider: "openai",
    model: id,
    apiKeyEnv: "HEMIUNU_SMOKE_UNSET_KEY",
    contextWindow: 128_000,
    cost: { in: 3, out: 15 },
    supports: { tools: true },
    tags,
  };
}

const FIXTURE_REGISTRY: ModelEntry[] = [
  fixtureEntry("smoke-synthesis", ["synthesis"]),
  fixtureEntry("smoke-research", ["research", "judge", "title"]),
];

async function main() {
  console.log("\n\x1b[1mHemiunu smoke harness\x1b[0m");

  // ---- Offline: structural checks (free, deterministic) ----
  console.log("\n\x1b[2mOffline checks\x1b[0m");

  await check(
    "config + registry: any-model readiness (no ANTHROPIC gate) + default-model fallback",
    async () => {
      // loadConfig no longer demands ANTHROPIC_API_KEY — this whole harness
      // runs with or without it (CI sets no key at all).
      const cfg = loadConfig();
      // baseUrl is optional now (undefined = Anthropic direct).
      assert(
        cfg.baseUrl === undefined || cfg.baseUrl.startsWith("http"),
        "baseUrl, if set, should be a URL",
      );
      assert(cfg.model.length > 0, "model id should be set");
      // The engine's model registry — what every turn resolves models against.
      const registry = loadModelRegistry();
      assert(registry.length > 0, "the registry should ship default models");
      assert(
        new Set(registry.map((m) => m.id)).size === registry.length,
        "registry ids must be unique",
      );
      for (const tag of ["synthesis", "research", "judge", "title"] as const) {
        assert(
          modelForTag(tag, registry, registry[0].id).id.length > 0,
          `the '${tag}' tag should resolve to a registry entry`,
        );
      }

      // Readiness rule: at least one model usable; NO env var special-cased.
      const keyless: ModelEntry = {
        id: "smoke-local",
        label: "smoke-local",
        provider: "openai-compatible",
        model: "smoke-local",
        baseURL: "http://localhost:1/v1",
        contextWindow: 32_000,
        supports: { tools: true },
      };
      assert(!anyModelAvailable(FIXTURE_REGISTRY, {}), "no key set → not ready (first-run gate)");
      assert(
        anyModelAvailable(FIXTURE_REGISTRY, { HEMIUNU_SMOKE_UNSET_KEY: "sk-x" }),
        "ANY set key env counts as ready",
      );
      assert(anyModelAvailable([keyless], {}), "a keyless local entry counts as usable");
      // The async gate variant probes keyless endpoints instead of trusting them.
      assert(
        await registryReady([keyless], {}, async () => true),
        "keyless + endpoint answering → ready",
      );
      assert(
        !(await registryReady([keyless], {}, async () => false)),
        "keyless + nothing listening → gate stays up",
      );
      assert(
        await registryReady(FIXTURE_REGISTRY, { HEMIUNU_SMOKE_UNSET_KEY: "sk-x" }, async () => {
          throw new Error("a set key must short-circuit the probe");
        }),
        "a set key is ready without probing",
      );

      // Default-model resolution: the persisted id wins when usable; an
      // unavailable hardcoded default (the old Claude id) falls to the first
      // AVAILABLE model instead of erroring.
      const shipped = defaultModels();
      assert(
        resolveDefaultModel(shipped, { ANTHROPIC_API_KEY: "sk-a" }) === "claude-opus-4.8",
        "with an Anthropic key the synthesis default is the Claude entry",
      );
      const litellmOnly = resolveDefaultModel(
        shipped,
        { LITELLM_API_KEY: "sk-l" },
        "claude-opus-4.8",
      );
      assert(
        litellmOnly === "gpt-4o",
        `LiteLLM-only env must fall to the first available model, got ${litellmOnly}`,
      );
      assert(
        resolveDefaultModel(shipped, { LITELLM_API_KEY: "sk-l" }, "deepseek-v3") === "deepseek-v3",
        "a usable persisted HEMIUNU_MODEL is honored",
      );
    },
  );

  await check("model registry: user models.json overrides by id and appends new entries", () => {
    // Next-phase live runs (gpt-4o via LiteLLM, local ollama) work by adding
    // registry entries — prove the overlay merge that makes that possible.
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-registry-"));
    try {
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify([
          { ...defaultModels()[0], contextWindow: 42_000 }, // override a shipped id
          {
            id: "local-llama",
            label: "Llama (local ollama)",
            provider: "openai-compatible",
            model: "llama3.3",
            baseURL: "http://localhost:11434/v1",
            apiKeyEnv: "OLLAMA_API_KEY",
            contextWindow: 8_000,
            supports: { tools: true },
          },
          { id: "broken-entry" }, // invalid → skipped, must not break startup
        ]),
      );
      // The skip warns by design — keep the gate output clean while loading.
      const warn = console.warn;
      console.warn = () => {};
      let reg: ModelEntry[];
      try {
        reg = loadModelRegistry(dir);
      } finally {
        console.warn = warn;
      }
      const overridden = reg.find((m) => m.id === defaultModels()[0].id);
      assert(overridden?.contextWindow === 42_000, "a same-id entry should override the default");
      assert(
        reg.some((m) => m.id === "local-llama"),
        "a new id should be appended to the registry",
      );
      assert(
        reg.length === defaultModels().length + 1,
        "the invalid entry must be skipped, not merged",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("--model flag: parses and resolves against the registry (typo fails fast)", () => {
    const registry = loadModelRegistry();
    const parsed = parseEvalArgs(["S6", "--model", "gemini-2.5-flash", "S8", "--offline"]);
    assert(parsed.model === "gemini-2.5-flash", "should capture --model's value");
    assert(
      parsed.rest.join(",") === "S6,S8,--offline",
      `other args pass through, got ${parsed.rest.join(",")}`,
    );
    assert(parseEvalArgs(["--model=gpt-5.2"]).model === "gpt-5.2", "--model=<id> form works");
    assert(
      resolveEvalModel("gemini-2.5-flash", registry, "x") === "gemini-2.5-flash",
      "a known registry id resolves to itself",
    );
    assert(
      resolveEvalModel(undefined, registry, "fallback-id") === "fallback-id",
      "no flag/env falls back to the configured model",
    );
    let threw = false;
    try {
      resolveEvalModel("nope-9000", registry, "x");
    } catch (e) {
      threw = /Known registry ids/.test(e instanceof Error ? e.message : "");
    }
    assert(threw, "an unknown id must fail fast, listing the known registry ids");
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
    // A server that references an unset ${ENV} var must be skipped, not connected.
    const had = process.env.HEMIUNU_PROBE_TOKEN;
    delete process.env.HEMIUNU_PROBE_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-mcp-"));
    try {
      const mcpPath = join(dir, "mcp.json");
      writeFileSync(
        mcpPath,
        JSON.stringify({
          mcpServers: {
            probe: {
              type: "http",
              url: "https://example.com",
              headers: { Authorization: "Bearer ${HEMIUNU_PROBE_TOKEN}" },
            },
          },
        }),
      );
      const reg = loadMcpRegistry(process.cwd(), mcpPath);
      const probe = reg.skipped.find((s) => s.name === "probe");
      assert(probe !== undefined, "probe should be skipped without HEMIUNU_PROBE_TOKEN");
      assert(/missing env/.test(probe.reason), "skip reason should cite missing env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (had !== undefined) process.env.HEMIUNU_PROBE_TOKEN = had;
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
      assert(
        !/^- \S/m.test(user),
        `seeded user.md should carry no learned facts, got: ${user.slice(0, 80)}`,
      );
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
      assert(
        saved.indexPath === join(dir, "index.html"),
        `index.html should be at the root, got: ${saved.indexPath}`,
      );
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
    assert(
      /design principles to apply/i.test(proto),
      "prototyper prompt should inject the design knowledge",
    );
    assert(
      /Purpose|Familiarity|earn its place/i.test(proto),
      "design principles should be present",
    );
    const researcher = subagentPrompt("researcher");
    assert(
      !/design principles to apply/i.test(researcher),
      "researcher should NOT carry the design guideline",
    );
    // Specialist subagents carry their own knowledge packs (generic injection).
    assert(
      /product strategy principles/i.test(subagentPrompt("strategist")),
      "strategist should inject the strategy pack",
    );
    assert(
      /analytics principles/i.test(subagentPrompt("analyst")),
      "analyst should inject the metrics pack",
    );
    // Every subagent carries the operating-rules guard (no plan mode / no file
    // writes outside their tools) — so they never try to write to the SDK plan
    // path and return their deliverable as text.
    for (const n of ["researcher", "prototyper", "designer", "strategist", "analyst"] as const) {
      const p = subagentPrompt(n);
      assert(/final message IS/i.test(p), `${n} prompt should carry the operating-rules guard`);
      assert(/NOT in plan mode/i.test(p), `${n} prompt should forbid plan mode`);
    }
  });

  await check(
    "hi-fi verification: designer contract, verify skip-paths, fan-out guard",
    async () => {
      // The designer must be told to verify the build before reporting done —
      // the preview answers HTTP 200 even when a component fails to compile.
      const designer = subagentPrompt("designer");
      assert(
        /check_prototype/.test(designer),
        "designer prompt should require the check_prototype validation pass",
      );
      assert(
        /tsconfig\.json/.test(designer),
        "designer scaffold should include a tsconfig so check_prototype can type-check",
      );
      // verifyPrototype never false-fails: static wireframes and uninstalled
      // workspaces report ok with a note instead of an error.
      const dir = mkdtempSync(join(tmpdir(), "hemiunu-smoke-verify-"));
      try {
        writeFileSync(join(dir, "index.html"), "<!doctype html><h1>wf</h1>");
        const wf = await verifyPrototype(dir);
        assert(wf.ok, "static wireframe must verify ok");
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
        const noDeps = await verifyPrototype(dir);
        assert(noDeps.ok, "uninstalled framework project must skip, not fail");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // Concurrent designers must declare disjoint write scopes up front — the
      // write-scope guard can't protect a task that never declared one.
      assert(
        validateParallelTasks([{ agent: "designer" }, { agent: "designer" }]) !== null,
        "unscoped concurrent designers must be refused",
      );
      assert(
        validateParallelTasks([
          { agent: "designer", writes: ["src/components/A.tsx"] },
          { agent: "designer", writes: ["src/components/B.tsx"] },
        ]) === null,
        "scoped, disjoint concurrent designers must be allowed",
      );
    },
  );

  await check("writeUserEnv writes ~/.hemiunu/.env and a user mcp.json overlay merges", () => {
    // Snapshot every env var writeUserEnv may mutate — the live checks below
    // need the real key restored.
    const snap: Record<string, string | undefined> = {
      HEMIUNU_CONFIG_DIR: process.env.HEMIUNU_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      HEMIUNU_MODEL: process.env.HEMIUNU_MODEL,
    };
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-cfg-"));
    try {
      process.env.HEMIUNU_CONFIG_DIR = dir;
      const p = writeUserEnv({ apiKey: "sk-test-123" });
      assert(p === join(dir, ".env"), `should write to the config dir, got ${p}`);
      const content = readFileSync(p, "utf8");
      assert(/ANTHROPIC_API_KEY=sk-test-123/.test(content), "key should be written");
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

  await check(
    "mcp sandbox: stdio servers run via the cwd shim; filesystem + remote pass through",
    () => {
      const servers: Record<string, unknown> = {
        playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/proj"],
        },
        remote: { type: "http", url: "https://mcp.example.com" },
      };
      const out = sandboxStdioCwd(servers, {
        shimPath: "/HOME/bin/mcp-in-dir.mjs",
        rootDir: "/CFG/tmp/mcp",
      });

      // A normal stdio server is rewritten to launch via the node shim in its own
      // throwaway cwd, with the real command/args trailing — so its output can't
      // land in the user's launch folder.
      const pw = out.playwright as { command: string; args: string[] };
      assert(pw.command === process.execPath, "stdio server should launch via node (the shim)");
      assert(pw.args[0] === "/HOME/bin/mcp-in-dir.mjs", "arg[0] should be the shim path");
      assert(pw.args[1] === "/CFG/tmp/mcp/playwright", "arg[1] should be the per-server cwd");
      assert(
        pw.args[2] === "npx" && pw.args[3] === "@playwright/mcp@latest",
        "the real command + args should follow the shim args",
      );

      // The filesystem server must keep reading the launch dir → not sandboxed.
      assert((out.filesystem as { command: string }).command === "npx", "filesystem is exempt");
      // Remote servers aren't spawned → untouched.
      const remote = out.remote as { type: string; url: string };
      assert(remote.type === "http" && !!remote.url, "remote servers pass through unchanged");
    },
  );

  await check("ask_model reports a missing provider key without a network call", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const msg = await askModel({ provider: "openai", model: "gpt-4o", prompt: "hi" });
      assert(/OPENAI_API_KEY/.test(msg), `should name the missing key, got: ${msg.slice(0, 120)}`);
      const unknown = await askModel({ provider: "nope", model: "x", prompt: "hi" });
      assert(
        /unknown provider/i.test(unknown),
        `should reject unknown provider, got: ${unknown.slice(0, 80)}`,
      );
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
      assert(
        list.some((s) => s.name === "weekly-report"),
        "saved skill should be listed",
      );
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

  await check(
    "source maps: saveSourceMap writes a per-mcp file; load round-trips frontmatter + body",
    () => {
      const root = mkdtempSync(join(tmpdir(), "hemiunu-sources-"));
      try {
        const saved = saveSourceMap({
          mcp: "Acme",
          description: "Product workspace — roadmap, specs (viewer).",
          body: "## Key locations\n- **Roadmap** — page id `abc123` — quarterly OKRs.",
          root,
        });
        assert(saved.mcp === "acme", `mcp name should be slugified, got: ${saved.mcp}`);

        const list = loadSourceMaps(root);
        assert(
          list.some((m) => m.mcp === "acme"),
          "saved map should be listed",
        );
        assert(
          list[0].description === "Product workspace — roadmap, specs (viewer).",
          "frontmatter description should round-trip",
        );
        assert(!!list[0].scanned, "a scanned date should be recorded in frontmatter");

        const full = loadSourceMap("acme", root);
        assert(!!full && /abc123/.test(full.body), "full map body should load on demand");

        assert(loadSourceMap("missing", root) === undefined, "absent map returns undefined");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await check(
    "tool cap: the pipeline truncates oversized built-in results, exempts MCP, leaves small ones",
    async () => {
      const budget = 100; // tokens → 400 chars
      const big = "x".repeat(5000);
      const root = mkdtempSync(join(tmpdir(), "hemiunu-cap-pipe-"));
      try {
        const executor = createPipeline(
          createHemiPipelineConfig({
            tools: [
              fixtureTool("web_search", "ok"),
              fixtureTool("web_fetch", big),
              fixtureTool("mcp__acme__query", big),
            ],
            budgetTokens: budget,
            policyRoot: root, // hermetic toolpolicy/seen-tool bookkeeping
          }),
        );
        // Small built-in result passes through untouched.
        const small = await executor.execute(
          { id: "id1", name: "web_search", input: {} },
          toolCtx(),
        );
        assert(small.content === "ok" && !small.isError, "small result should not be modified");
        // Oversized built-in result is truncated to the budget + a notice.
        const capped = await executor.execute(
          { id: "id2", name: "web_fetch", input: {} },
          toolCtx(),
        );
        assert(
          capped.content.length < 5000 && /truncated/i.test(capped.content),
          "oversized result should be shorter and carry a truncation notice",
        );
        // MCP results are exempt — an oversized MCP retrieval is never truncated.
        const mcp = await executor.execute(
          { id: "id3", name: "mcp__acme__query", input: {} },
          toolCtx(),
        );
        assert(mcp.content === big, "oversized MCP result should be left intact");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await check(
    "tool policy: setSeenTools records the full inventory; a 'block' wins in the pipeline",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "hemiunu-policy-"));
      try {
        // Full inventory: bare names get normalised to ids, sorted & deduped;
        // Hemiunu's own servers are skipped.
        setSeenTools("demo", ["write", "search", "search"], root);
        setSeenTools("hemiunu-memory", ["remember"], root);
        const cfg = loadToolPolicy(root);
        assert(
          JSON.stringify(cfg.seen.demo) ===
            JSON.stringify(["mcp__demo__search", "mcp__demo__write"]),
          `seen.demo should be the sorted, prefixed inventory, got ${JSON.stringify(cfg.seen.demo)}`,
        );
        assert(!cfg.seen["hemiunu-memory"], "Hemiunu's own servers must not be recorded");

        // The pipeline denies a tool the user set to "block" — even in an
        // auto-accepting run (what the SDK era needed a PreToolUse hook for) —
        // and passes everything else.
        setToolPolicy("mcp__demo__write", "block", root);
        const executor = createPipeline(
          createHemiPipelineConfig({
            tools: [
              fixtureTool("mcp__demo__write", "wrote", { readOnly: false }),
              fixtureTool("mcp__demo__search", "found"),
            ],
            autoAccept: true,
            policyRoot: root,
          }),
        );
        const denied = await executor.execute(
          { id: "id1", name: "mcp__demo__write", input: {} },
          toolCtx(),
        );
        assert(
          denied.isError === true && /blocked by your tool policy/i.test(denied.content),
          "a blocked tool must be refused by the pipeline and never execute",
        );
        const events: TurnEvent[] = [];
        const allowed = await executor.execute(
          { id: "id2", name: "mcp__demo__search", input: {} },
          toolCtx(events),
        );
        assert(
          allowed.content === "found" && !allowed.isError,
          "a non-blocked tool must pass through untouched (no automatic blocking)",
        );
        assert(
          events.some((e) => e.type === "permission-note" && e.decision === "auto"),
          "an allowed call should carry a permission-note saying who decided",
        );

        // "Always allow" persists by writing an allow policy here — so it sticks
        // across turns/compaction/restarts instead of being lost with the session.
        setToolPolicy("mcp__demo__search", "allow", root);
        assert(
          loadToolPolicy(root).tools["mcp__demo__search"] === "allow",
          "an 'always allow' grant must persist to the tool policy",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await check("prototype knowledge: appendKnowledge builds & appends sections", () => {
    // From scratch → frontmatter + a Decisions section.
    const v1 = appendKnowledge(
      null,
      "Churn Dashboard",
      "decision",
      "Tabs over wizard.",
      "alex",
      "2026-06-23",
    );
    assert(/title: Churn Dashboard/.test(v1), `should set a title, got:\n${v1}`);
    assert(/feature: churn-dashboard/.test(v1), "should set the feature slug");
    assert(
      /## Decisions\n- 2026-06-23 \(alex\): Tabs over wizard\./.test(v1),
      `decision should be appended, got:\n${v1}`,
    );

    // Append a question → new section, existing one preserved, checkbox bullet.
    const v2 = appendKnowledge(
      v1,
      "churn-dashboard",
      "question",
      "Empty state range?",
      "sam",
      "2026-06-24",
    );
    assert(
      /## Decisions\n- 2026-06-23 \(alex\): Tabs over wizard\./.test(v2),
      "prior decision preserved",
    );
    assert(
      /## Open questions\n- \[ \] Empty state range\? \(sam, 2026-06-24\)/.test(v2),
      `question appended as a checkbox, got:\n${v2}`,
    );
    assert(/updated: 2026-06-24/.test(v2), "updated date should advance");

    // A second decision lands under the existing Decisions heading.
    const v3 = appendKnowledge(
      v2,
      "churn-dashboard",
      "decision",
      "Add cohort filter.",
      "alex",
      "2026-06-25",
    );
    const decBlock = v3.slice(v3.indexOf("## Decisions"));
    assert(
      /Tabs over wizard[\s\S]*Add cohort filter\./.test(decBlock),
      "second decision appends under Decisions",
    );
  });

  await check("github helpers: repo normalize + path + token resolution", () => {
    assert(
      normalizeRepo("https://github.com/Acme/proto.git") === "Acme/proto",
      "https url should normalize",
    );
    assert(
      normalizeRepo("git@github.com:Acme/proto.git") === "Acme/proto",
      "ssh url should normalize",
    );
    assert(
      prototypePath() === "PROTOTYPE.md",
      `knowledge file should be at the repo root, got ${prototypePath()}`,
    );

    // With no connected-account store, an env token resolves (no network call).
    // Sandbox the config dir so this doesn't depend on the dev's ~/.hemiunu
    // (a real github.json store would take precedence by design).
    const prevTok = process.env.GITHUB_TOKEN;
    const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
    const dir = mkdtempSync(join(tmpdir(), "hemiunu-gh-"));
    process.env.HEMIUNU_CONFIG_DIR = dir;
    process.env.GITHUB_TOKEN = "ghp_smoke";
    try {
      assert(resolveGithubToken() === "ghp_smoke", "env token should resolve");
    } finally {
      if (prevTok === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevTok;
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
      rmSync(dir, { recursive: true, force: true });
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
      assert(
        /GITHUB_TOKEN=ghp_two/.test(env) && !/ghp_one/.test(env),
        "key should be updated in place",
      );
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
      assert(
        JSON.stringify(listTeams()) === '["Acme/alpha","Acme/beta"]',
        `two teams, got ${listTeams()}`,
      );
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

  await check(
    "workspace binding: a turn's repo is isolated from the global team & concurrent turns",
    async () => {
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
          assert(
            activeProtoDir().endsWith(join("Acme", "beta")),
            "activeProtoDir follows the binding",
          );
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
    },
  );

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

  await check(
    "workspace: clone, then sync PRESERVES in-progress work (rebases onto latest, never discards)",
    async () => {
      const cfg = mkdtempSync(join(tmpdir(), "hemiunu-ws-"));
      const remote = mkdtempSync(join(tmpdir(), "hemiunu-remote-"));
      const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
      const g = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, stdio: "ignore" });
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

        // In-progress prototype code locally, while the remote advances a DIFFERENT
        // file (e.g. a PROTOTYPE.md note). Syncing must KEEP the local work and
        // rebase it onto the latest — never reset/bin it (the old, lossy behavior).
        writeFileSync(join(r.path, "app.tsx"), "export const App = () => 'mine';");
        writeFileSync(join(remote, "PROTOTYPE.md"), "## Decisions\n- a remote note");
        g(["add", "."], remote);
        g(["commit", "-qm", "note"], remote);
        const trashBefore = listTrash().length;
        r = await ensureWorkspace("acme/proto", { cloneUrl: remote });
        assert(r.action === "kept", `should keep+rebase, got ${r.action} ${r.note ?? ""}`);
        assert(
          readFileSync(join(r.path, "app.tsx"), "utf8").includes("mine"),
          "the in-progress local code must be preserved",
        );
        assert(
          existsSync(join(r.path, "PROTOTYPE.md")),
          "the remote change must be integrated via rebase",
        );
        assert(
          listTrash().length === trashBefore,
          "nothing should be discarded to the recycle bin on a normal sync",
        );

        // restoreTrash still recovers a snapshot when one IS made (e.g. start-fresh).
        const binId = binWorkspace(r.path, "acme/proto", "test snapshot");
        const dest = restoreTrash(basename(binId));
        assert(
          readFileSync(join(dest, "app.tsx"), "utf8").includes("mine"),
          "restore should recover a binned snapshot",
        );
      } finally {
        rmSync(cfg, { recursive: true, force: true });
        rmSync(remote, { recursive: true, force: true });
        if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
        else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
      }
    },
  );

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
      const pr = await commitAndPush("acme/proto", {
        message: "v2",
        login: "tester",
        toMain: true,
      });
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

  await check("cloudflare: configured only when token + account ID are both set", () => {
    const prevTok = process.env.CLOUDFLARE_API_TOKEN;
    const prevAcct = process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      delete process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      assert(!cloudflareConfigured(), "should be unconfigured with neither var");
      process.env.CLOUDFLARE_API_TOKEN = "cf_test";
      assert(!cloudflareConfigured(), "should be unconfigured with only a token");
      process.env.CLOUDFLARE_ACCOUNT_ID = "acct_test";
      assert(cloudflareConfigured(), "should be configured with both vars");
    } finally {
      if (prevTok === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = prevTok;
      if (prevAcct === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = prevAcct;
    }
  });

  await check("cloudflare: project name is a valid Pages slug derived from the repo", () => {
    assert(
      projectNameFor("Acme/Checkout_Redesign") === "acme-checkout-redesign",
      "should slugify owner/repo",
    );
    assert(projectNameFor("a/b") === "a-b", "should join owner and repo");
    const long = projectNameFor(`org/${"x".repeat(80)}`);
    assert(long.length <= 58, "should cap at 58 chars");
    assert(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(long), "should be a valid lowercase slug");
  });

  await check("deploy: provider seam defaults to Cloudflare and exposes the interface", () => {
    const p = activeProvider();
    assert(p !== undefined, "an active provider should resolve");
    assert(p.id === "cloudflare", `default provider should be cloudflare, got ${p?.id}`);
    assert(typeof p.deploy === "function", "provider should expose deploy()");
    assert(typeof p.isConfigured === "function", "provider should expose isConfigured()");
    assert(
      listDeployProviders().some((x) => x.id === "cloudflare"),
      "cloudflare should be registered in the provider list",
    );
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
      assert(
        existsSync(join(verify, "PROTOTYPE.md")),
        "remote should have PROTOTYPE.md at the root",
      );
    } finally {
      for (const d of [cfg, bare, seed, local, verify]) rmSync(d, { recursive: true, force: true });
      if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
      else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
    }
  });

  await check(
    "auto-save commits locally only (nothing pushed to GitHub); publish → main; reconcile detects divergence",
    async () => {
      const cfg = mkdtempSync(join(tmpdir(), "hemiunu-cpcfg-"));
      const bare = mkdtempSync(join(tmpdir(), "hemiunu-cpbare-"));
      const seed = mkdtempSync(join(tmpdir(), "hemiunu-cpseed-"));
      const verify = mkdtempSync(join(tmpdir(), "hemiunu-cpver-"));
      const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
      const g = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, stdio: "ignore" });
      const out = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

        // Clone into the managed workspace, write a prototype file + build
        // artifacts (as the deploy's install/build would), then auto-save.
        await ensureWorkspace("acme/cp", { cloneUrl: bare });
        const ws = workspacePath("acme/cp");
        writeFileSync(join(ws, "index.html"), "<h1>v1</h1>");
        mkdirSync(join(ws, "dist"), { recursive: true });
        writeFileSync(join(ws, "dist", "bundle.js"), "// built");
        mkdirSync(join(ws, "node_modules", "x"), { recursive: true });
        writeFileSync(join(ws, "node_modules", "x", "index.js"), "// dep");
        const cp = await checkpointWorkspace("acme/cp", { login: "tester" });
        // Build artifacts must never be tracked — otherwise reconcile flags them
        // as "un-published changes" every session.
        const tracked = out(["ls-files"], ws);
        assert(!/(^|\n)dist\//.test(tracked), "dist/ must not be tracked after auto-save");
        assert(
          !/(^|\n)node_modules\//.test(tracked),
          "node_modules/ must not be tracked after auto-save",
        );
        assert(tracked.includes("index.html"), "the prototype file itself should be tracked");
        // Auto-save is LOCAL-ONLY: it commits to the checkpoint branch but does
        // NOT push — nothing reaches GitHub until publish/deploy.
        assert(!cp.pushed, `auto-save should NOT push (local-only): ${cp.note}`);
        assert(
          cp.branch === CHECKPOINT_BRANCH,
          `auto-save should commit to the checkpoint branch, got ${cp.branch}`,
        );
        assert(
          out(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath("acme/cp")) ===
            CHECKPOINT_BRANCH,
          "the workspace should be on the local checkpoint branch",
        );

        // GitHub stays CLEAN: no un-published work on main, and NO checkpoint
        // branch pushed to origin during iteration.
        g(["clone", bare, verify], tmpdir());
        assert(!existsSync(join(verify, "index.html")), "main must NOT have un-published work");
        assert(
          !out(["branch", "-r"], verify).includes(`origin/${CHECKPOINT_BRANCH}`),
          "the checkpoint branch must NOT be pushed to origin (local-only auto-save)",
        );

        // reconcile sees the divergence (un-published work differs from main).
        const rec = await reconcileWorkspace("acme/cp", { cloneUrl: bare });
        assert(rec.status === "diverged", `reconcile should report diverged, got ${rec.status}`);

        // A clean tree is a no-op (no empty commit/push).
        const noop = await checkpointWorkspace("acme/cp", { login: "tester" });
        assert(
          !noop.pushed && /nothing changed/.test(noop.note),
          `clean tree should no-op: ${noop.note}`,
        );

        // Publishing ships the work to main but KEEPS the workspace so the user can
        // keep iterating (it's only cleared on leaving the team).
        const pub = await publishWorkspace("acme/cp", { login: "tester" });
        assert(pub.ok && pub.branch === "main", `publish should push to main: ${pub.note}`);
        assert(
          existsSync(workspacePath("acme/cp")),
          "publish should KEEP the workspace for further iteration",
        );
        const verify2 = mkdtempSync(join(tmpdir(), "hemiunu-cpver2-"));
        g(["clone", bare, verify2], tmpdir());
        assert(
          readFileSync(join(verify2, "index.html"), "utf8").includes("v1"),
          "main should have the published prototype after publish",
        );
        rmSync(verify2, { recursive: true, force: true });
      } finally {
        for (const d of [cfg, bare, seed, verify]) rmSync(d, { recursive: true, force: true });
        if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
        else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
      }
    },
  );

  await check(
    "PROTOTYPE.md notes land in the workspace (not main) when a checkout exists; publish rebases over a moved main",
    async () => {
      const cfg = mkdtempSync(join(tmpdir(), "hemiunu-ppcfg-"));
      const bare = mkdtempSync(join(tmpdir(), "hemiunu-ppbare-"));
      const seed = mkdtempSync(join(tmpdir(), "hemiunu-ppseed-"));
      const side = mkdtempSync(join(tmpdir(), "hemiunu-ppside-"));
      const prevCfg = process.env.HEMIUNU_CONFIG_DIR;
      const g = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, stdio: "ignore" });
      const out = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

        // A checkout exists → a note writes to the workspace PROTOTYPE.md, NOT main.
        await ensureWorkspace("acme/pp", { cloneUrl: bare });
        const mainBefore = out(["ls-remote", bare, "refs/heads/main"], tmpdir());
        await addPrototypeNote("decision", "Tabs over a wizard", { repo: "acme/pp" });
        assert(
          readFileSync(join(workspacePath("acme/pp"), "PROTOTYPE.md"), "utf8").includes(
            "Tabs over a wizard",
          ),
          "the note should be written into the workspace PROTOTYPE.md",
        );
        assert(
          out(["ls-remote", bare, "refs/heads/main"], tmpdir()) === mainBefore,
          "the note must NOT create an out-of-band commit on main when a checkout exists",
        );

        // Build code in the workspace + checkpoint it (commits note + code).
        writeFileSync(join(workspacePath("acme/pp"), "index.html"), "<h1>built</h1>");
        await checkpointWorkspace("acme/pp", { login: "tester" });

        // Meanwhile main moves out-of-band (e.g. a teammate). Publish must rebase
        // our work on top of it and fast-forward — not fail non-fast-forward.
        g(["clone", bare, side], tmpdir());
        writeFileSync(join(side, "NOTES.md"), "from a teammate");
        g(["config", "user.email", "u@u.co"], side);
        g(["config", "user.name", "u"], side);
        g(["add", "."], side);
        g(["commit", "-qm", "teammate change"], side);
        g(["push", "origin", "HEAD:main"], side);

        const pub = await publishWorkspace("acme/pp", { login: "tester" });
        assert(pub.ok, `publish should rebase over the moved main and succeed: ${pub.note}`);
        const ppver = mkdtempSync(join(tmpdir(), "hemiunu-ppver-"));
        g(["clone", bare, ppver], tmpdir());
        assert(
          readFileSync(join(ppver, "index.html"), "utf8").includes("built") &&
            existsSync(join(ppver, "NOTES.md")) &&
            readFileSync(join(ppver, "PROTOTYPE.md"), "utf8").includes("Tabs over a wizard"),
          "main should end with our code, our note, AND the teammate's change (clean rebase)",
        );
        rmSync(ppver, { recursive: true, force: true });
      } finally {
        for (const d of [cfg, bare, seed, side]) rmSync(d, { recursive: true, force: true });
        if (prevCfg === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
        else process.env.HEMIUNU_CONFIG_DIR = prevCfg;
      }
    },
  );

  await check("control bridge: requestControl routes to the registered handler", async () => {
    try {
      setControlHandler(async (e) => {
        if (e.type === "create-team") return `made ${e.name}`;
        if (e.type === "rename-team") return `renamed ${e.name}`;
        if (e.type === "ask-user")
          return e.questions.map((q) => `${q.header}: ${q.options[0].label}`).join("\n");
        if (e.type === "switch-team") return `switched ${e.repo}`;
        return e.line; // discovery
      });
      assert(
        (await requestControl({ type: "create-team", name: "foo" })) === "made foo",
        "should route create",
      );
      assert(
        (await requestControl({ type: "switch-team", repo: "a/b" })) === "switched a/b",
        "should route switch",
      );
      assert(
        (await requestControl({ type: "rename-team", name: "bar" })) === "renamed bar",
        "should route rename",
      );
      // ask_user routes its questions through the same bridge and returns the answer.
      const answer = await requestControl({
        type: "ask-user",
        questions: [
          { header: "Approach", question: "Which way?", options: [{ label: "A" }, { label: "B" }] },
        ],
      });
      assert(answer === "Approach: A", `should route ask-user, got: ${answer}`);
    } finally {
      setControlHandler(null);
    }
    const none = await requestControl({ type: "switch-team", repo: "a/b" });
    assert(/no interactive session/i.test(none), `no handler → message, got: ${none}`);
  });

  // ---- Offline: the engine runtime itself (createEngineRuntime → TurnEvent) ----
  console.log("\n\x1b[2mEngine runtime checks (offline, scripted model)\x1b[0m");

  await check(
    "engine runtime assembles the full turn tool set (11 servers + control + delegation + web)",
    async () => {
      const userRoot = mkdtempSync(join(tmpdir(), "hemiunu-rt-user-"));
      const captured: EngineRunTurnOptions[] = [];
      const rt = createEngineRuntime({
        dbPath: ":memory:",
        registry: FIXTURE_REGISTRY,
        mcpServers: {},
        webSearchEnv: {},
        userRoot,
        policyRoot: userRoot,
        runTurnImpl: async function* (opts): AsyncGenerator<TurnEvent> {
          captured.push(opts);
          yield {
            type: "turn-finish",
            text: "",
            usage: emptyUsage(),
            costUsd: 0,
            stopReason: "end",
          };
        },
      });
      try {
        for await (const _e of rt.runTurn({ prompt: "hi" })) {
          /* drain */
        }
        const opts = captured[0];
        const names = new Set((opts.tools ?? []).map((t) => t.name));
        // All 11 in-process servers are represented.
        const servers = new Set(
          [...names]
            .filter((n) => n.startsWith("mcp__hemiunu-"))
            .map((n) => n.slice(5).split("__")[0]),
        );
        assert(servers.size === 11, `expected 11 hemiunu servers, got ${[...servers].join(",")}`);
        // Engine control tools, the delegation surface, and web_fetch (always).
        for (const t of [
          "todo_write",
          "enter_plan_mode",
          "exit_plan_mode",
          "delegate",
          "mcp__hemiunu-orchestrator__parallel",
          "web_fetch",
        ]) {
          assert(names.has(t), `expected ${t} in the turn's tool set`);
        }
        // web_search NOT registered (no provider in the chain: empty env).
        assert(!names.has("web_search"), "web_search must be absent without a provider");
        assert(names.size === (opts.tools ?? []).length, "no duplicate tool names");
        // Durable pieces wired: synthesis-tag default model, the runtime's own
        // transcript store, and the compactor as the compaction check.
        assert(opts.model === "smoke-synthesis", `model should default by tag, got ${opts.model}`);
        assert(opts.transcript === rt.transcript, "the runtime's transcript store is wired in");
        assert(typeof opts.compactionCheck === "function", "the compactor is wired in");
      } finally {
        await rt.shutdown();
        rmSync(userRoot, { recursive: true, force: true });
      }
    },
  );

  await check(
    "engine loop end-to-end offline: a scripted turn runs a real tool and streams TurnEvents",
    async () => {
      const userRoot = mkdtempSync(join(tmpdir(), "hemiunu-rt-loop-"));
      const rt = createEngineRuntime({
        dbPath: ":memory:",
        registry: FIXTURE_REGISTRY,
        mcpServers: {},
        webSearchEnv: {},
        userRoot,
        policyRoot: userRoot,
        // No runTurnImpl → the REAL engine loop runs, on a scripted model.
        resolve: scriptedResolve(FIXTURE_REGISTRY, [
          {
            tool: "mcp__hemiunu-memory__remember",
            input: { note: "The PM prefers concise answers." },
          },
          { text: "Noted." },
        ]),
      });
      try {
        const events: TurnEvent[] = [];
        for await (const e of rt.runTurn({ prompt: "remember that I prefer concise answers" })) {
          events.push(e);
        }
        assert(events[0]?.type === "turn-start", "the stream must open with turn-start");
        const start = events.find((e) => e.type === "tool-start");
        assert(
          start?.type === "tool-start" && start.name === "mcp__hemiunu-memory__remember",
          "the scripted tool call must surface as tool-start",
        );
        const result = events.find((e) => e.type === "tool-result");
        assert(
          result?.type === "tool-result" &&
            result.id === start.id &&
            !result.output.isError &&
            /saved/i.test(result.output.content),
          "tool-result must pair with the tool-start id and carry the tool's output",
        );
        assert(
          events.some((e) => e.type === "permission-note" && e.id === start.id),
          "the pipeline should note who allowed the call",
        );
        const finish = events.at(-1);
        assert(finish?.type === "turn-finish", "the stream must close with turn-finish");
        assert(finish.text === "Noted." && finish.stopReason === "end", "final text + stopReason");
        assert(
          finish.usage.steps === 2 && finish.usage.inputTokens === 200,
          `usage should accumulate across steps, got ${JSON.stringify(finish.usage)}`,
        );
        assert(finish.costUsd > 0, "costUsd should be computed from the entry's price table");
        // …and the tool REALLY ran: the fact landed in the user memory file.
        assert(
          readFileSync(join(userRoot, "user.md"), "utf8").includes("concise answers"),
          "remember() should have written the note under userRoot",
        );
      } finally {
        await rt.shutdown();
        rmSync(userRoot, { recursive: true, force: true });
      }
    },
  );

  await check("engine transcript: turns persist and resume by conversation id", async () => {
    const userRoot = mkdtempSync(join(tmpdir(), "hemiunu-rt-resume-"));
    const rt = createEngineRuntime({
      dbPath: join(userRoot, "smoke.db"),
      registry: FIXTURE_REGISTRY,
      mcpServers: {},
      webSearchEnv: {},
      userRoot,
      policyRoot: userRoot,
      // One scripted model spans both turns (step counter carries over).
      resolve: scriptedResolve(FIXTURE_REGISTRY, [{ text: "first answer" }, { text: "second" }]),
    });
    try {
      let conversationId: string | undefined;
      for await (const e of rt.runTurn({ prompt: "first prompt" })) {
        if (e.type === "turn-start") conversationId = e.conversationId;
      }
      assert(conversationId, "turn-start should carry the conversation id");
      for await (const _e of rt.runTurn({ prompt: "second prompt", resume: conversationId })) {
        /* drain */
      }
      const loaded = rt.transcript.load(conversationId);
      assert(loaded !== undefined, "the conversation should load from the transcript store");
      const roles = loaded.messages.map((m) => m.role);
      assert(
        roles.join(",") === "user,assistant,user,assistant",
        `both turns should persist in order, got ${roles.join(",")}`,
      );
      assert(loaded.messages[0].content === "first prompt", "the first user prompt round-trips");
    } finally {
      await rt.shutdown();
      rmSync(userRoot, { recursive: true, force: true });
    }
  });

  await check(
    "engine control tools: todo_write emits `todo`; exit_plan_mode proposes the plan",
    async () => {
      const userRoot = mkdtempSync(join(tmpdir(), "hemiunu-rt-plan-"));
      const rt = createEngineRuntime({
        dbPath: ":memory:",
        registry: FIXTURE_REGISTRY,
        mcpServers: {},
        webSearchEnv: {},
        userRoot,
        policyRoot: userRoot,
        resolve: scriptedResolve(FIXTURE_REGISTRY, [
          {
            tool: "todo_write",
            input: {
              todos: [
                { text: "Draft the plan", status: "in_progress" },
                { text: "Review with the user", status: "pending" },
              ],
            },
          },
          { tool: "exit_plan_mode", input: { plan: "1. Do the thing\n2. Verify it" } },
          { text: "Plan approved — done." },
        ]),
      });
      try {
        const events: TurnEvent[] = [];
        // Start IN plan mode: both scripted tools are read-only, so they stay
        // advertised; approving exit_plan_mode flips the mode back.
        for await (const e of rt.runTurn({ prompt: "plan it", permissionMode: "plan" })) {
          events.push(e);
        }
        const todo = events.find((e) => e.type === "todo");
        assert(
          todo?.type === "todo" &&
            todo.todos.length === 2 &&
            todo.todos[0].status === "in_progress",
          "todo_write must surface the snapshot as a `todo` event",
        );
        const plan = events.find((e) => e.type === "plan-proposed");
        assert(
          plan?.type === "plan-proposed" && /Do the thing/.test(plan.plan),
          "exit_plan_mode must surface the plan as `plan-proposed`",
        );
        const finish = events.at(-1);
        assert(
          finish?.type === "turn-finish" && /approved/i.test(finish.text),
          "the turn should finish normally after the plan is approved",
        );
      } finally {
        await rt.shutdown();
        rmSync(userRoot, { recursive: true, force: true });
      }
    },
  );

  if (OFFLINE) return report();

  // ---- Live: real turns through the engine runtime (the M0 gate) ----
  console.log(`\n\x1b[2mLive checks (model: ${EVAL_MODEL})\x1b[0m`);

  let liveCost = 0;
  // The live runtime: no MCP servers (the grounded check builds its own).
  const live = createEngineRuntime({ mcpServers: {} });

  await check("engine completes a turn and returns text", async () => {
    const { text, cost } = await collectTurn(live, {
      prompt: "Reply with exactly: PONG",
      model: EVAL_MODEL,
    });
    liveCost += cost;
    assert(text.trim().length > 0, "expected a non-empty response");
    assert(/pong/i.test(text), `expected the model to echo PONG, got: ${text.slice(0, 80)}`);
  });

  await check("agent identifies as Hemiunu (persona wired through)", async () => {
    const { text, cost } = await collectTurn(live, {
      prompt: "In one short sentence, what is your name and role?",
      model: EVAL_MODEL,
      systemPrompt: buildSystemPrompt(loadContext()),
    });
    liveCost += cost;
    assert(
      /hemiunu/i.test(text),
      `expected the agent to call itself Hemiunu, got: ${text.slice(0, 120)}`,
    );
  });

  await check("delegates to the researcher subagent and grounds the answer", async () => {
    // Give it a real source (this repo via the filesystem MCP) and a research
    // task routed through the researcher; expect the delegate → sub-run →
    // grounded-synthesis machinery to work end to end (isolated sub-context,
    // nested tool events, final text from the file). The ask names the
    // researcher explicitly: Opus 4.8 legitimately answers a trivial one-file
    // read itself (the soul allows that), so an implicit prompt would test the
    // model's judgment, not the engine's delegation path.
    const grounded = createEngineRuntime({
      dbPath: ":memory:",
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
        },
      },
    });
    try {
      // Run with the SHIPPED soul (like the CLI/web do) — it carries the
      // researcher-delegation guidance the minimal DEFAULT_SOUL fallback lacks.
      const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
      const d = await collectTurnDetailed(grounded, {
        prompt:
          "Use your researcher subagent to research this project's README.md, then tell me in one sentence what Hemiunu is. Ground it in the file.",
        model: EVAL_MODEL,
        researchModel: EVAL_MODEL,
        systemPrompt: buildSystemPrompt(loadContext({ appRoot })),
        toolPatterns: ["mcp__filesystem__*"],
      });
      liveCost += d.cost;
      assert(
        d.delegations.includes("researcher"),
        "expected the main loop to delegate to the researcher subagent",
      );
      assert(
        /product agent/i.test(d.text),
        `expected a grounded answer from the README, got: ${d.text.slice(0, 120)}`,
      );
    } finally {
      await grounded.shutdown();
    }
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
      console.log(
        `      \x1b[2m(skipped: ${provider} upstream unavailable — ${text.slice(0, 50)})\x1b[0m`,
      );
      return;
    }
    assert(
      /pong/i.test(text),
      `expected PONG from ${provider}/${model}, got: ${text.slice(0, 120)}`,
    );
  });

  console.log(`\n\x1b[2m  live turns cost ~$${liveCost.toFixed(4)}\x1b[0m`);
  await live.shutdown();
  report();
}

main().catch((err) => {
  console.error("\n\x1b[31mharness crashed:\x1b[0m", err);
  process.exit(1);
});
