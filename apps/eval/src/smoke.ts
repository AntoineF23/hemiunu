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
} from "@hemiunu/agent-core";
import {
  loadContext,
  buildSystemPrompt,
  remember,
  seedContextFiles,
} from "@hemiunu/memory";
import { loadMcpRegistry } from "@hemiunu/mcp";

const OFFLINE = process.argv.includes("--offline");
// Live gate uses the configured model by default (known-good with the proxy's
// `effort` param — some models, e.g. haiku-4.5, reject it). Override with
// HEMIUNU_EVAL_MODEL to run the gate against a cheaper/different model.
const EVAL_MODEL = process.env.HEMIUNU_EVAL_MODEL ?? loadConfig().model;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${msg}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Drain a runTurn stream into final text + cost. */
async function collectTurn(prompt: string): Promise<{ text: string; cost: number }> {
  let text = "";
  let cost = 0;
  for await (const m of runTurn({ prompt, model: EVAL_MODEL })) {
    const msg = m as Record<string, any>;
    if (msg.type === "result") {
      if (typeof msg.result === "string") text = msg.result;
      if (typeof msg.total_cost_usd === "number") cost = msg.total_cost_usd;
    }
  }
  return { text, cost };
}

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

  await check("context builds the system prompt from soul/user/memory", () => {
    const ctx = loadContext();
    assert(ctx.soul.length > 0, "soul.md should not be empty");
    const sys = buildSystemPrompt(ctx);
    assert(/hemiunu/i.test(sys), "system prompt should name Hemiunu");
    if (ctx.user) assert(sys.includes(ctx.user), "user facts should be included");
    if (ctx.memory) assert(sys.includes(ctx.memory), "durable memory should be included");
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

  await check("remember() routes 'user' globally and 'memory' to the project", () => {
    const userRoot = mkdtempSync(join(tmpdir(), "hemiunu-user-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "hemiunu-proj-"));
    try {
      remember("user", "A user fact.", { userRoot, projectRoot });
      remember("memory", "A project fact.", { userRoot, projectRoot });
      // 'user' → the global user.md in the user data dir.
      const user = readFileSync(join(userRoot, "user.md"), "utf8");
      assert(user.includes("A user fact."), "user note should land in the global user.md");
      // 'memory' → HEMIUNU.md at the project (launch folder) root.
      const project = readFileSync(join(projectRoot, "HEMIUNU.md"), "utf8");
      assert(project.includes("A project fact."), "project note should land in HEMIUNU.md");
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
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

  await check("savePrototype writes into the sandbox and blocks path traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "hemiunu-proto-"));
    try {
      const saved = savePrototype({
        slug: "My Test Screen!",
        files: [{ path: "index.html", content: "<!doctype html><title>x</title>" }],
        root,
      });
      assert(!!saved.indexPath && existsSync(saved.indexPath), "index.html should be written");
      assert(
        saved.dir.includes(join("prototypes", "my-test-screen")),
        `slug should be sanitized to kebab-case, got: ${saved.dir}`,
      );
      let threw = false;
      try {
        savePrototype({ slug: "esc", files: [{ path: "../../escape.html", content: "x" }], root });
      } catch {
        threw = true;
      }
      assert(threw, "writing outside the prototype sandbox must throw");
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  if (OFFLINE) return report();

  // ---- Live: one real turn through the proxy (the M0 gate) ----
  console.log(`\n\x1b[2mLive checks (model: ${EVAL_MODEL})\x1b[0m`);

  let liveCost = 0;

  await check("engine completes a turn and returns text", async () => {
    const { text, cost } = await collectTurn("Reply with exactly: PONG");
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

function report() {
  const total = passed + failed;
  const color = failed === 0 ? "\x1b[32m" : "\x1b[31m";
  console.log(`\n${color}${passed}/${total} checks passed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n\x1b[31mharness crashed:\x1b[0m", err);
  process.exit(1);
});
