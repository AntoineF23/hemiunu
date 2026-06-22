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
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { copyFileSync } from "node:fs";

import { runTurn, loadConfig } from "@hemiunu/agent-core";
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

  await check("config loads (proxy url, model, key present)", () => {
    const cfg = loadConfig();
    assert(cfg.baseUrl.startsWith("http"), "baseUrl should be a URL");
    assert(cfg.model.length > 0, "model id should be set");
    assert(cfg.apiKey.length > 0, "ANTHROPIC_API_KEY should be set (.env)");
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

  await check("remember() appends a durable note to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "hemiunu-smoke-"));
    mkdirSync(join(root, "context"), { recursive: true });
    try {
      remember("user", "Smoke test note.", root);
      const out = readFileSync(join(root, "context", "user.md"), "utf8");
      assert(out.includes("Smoke test note."), "note should be written to user.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await check("fresh clone seeds an EMPTY user.md from the template", () => {
    // Simulate a clone: only the committed *.example templates are present.
    const root = mkdtempSync(join(tmpdir(), "hemiunu-clone-"));
    const ctx = join(root, "context");
    mkdirSync(ctx, { recursive: true });
    // Resolve from this file (apps/eval/src/) → repo root → context/.
    const repoCtx = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "context");
    try {
      copyFileSync(join(repoCtx, "user.md.example"), join(ctx, "user.md.example"));
      copyFileSync(join(repoCtx, "memory.md.example"), join(ctx, "memory.md.example"));
      seedContextFiles(root);
      // remember() appends facts as lines starting with "- "; a fresh template has none.
      const user = loadContext(root).user;
      assert(!/^- \S/m.test(user), `seeded user.md should carry no learned facts, got: ${user.slice(0, 80)}`);
      assert(buildSystemPrompt(loadContext(root)).includes("Hemiunu"), "persona still wires through on a fresh clone");
    } finally {
      rmSync(root, { recursive: true, force: true });
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
