// P6-0 runtime composition: the createEngineRuntime facade assembles the whole
// engine offline — tool inventory (11 in-process servers + control + delegate +
// parallel + web tools + MCP host tools), old-name option plumbing into the
// loop, the permission pipeline's gates, plan-mode filtering (via the REAL
// engine loop on a scripted model), and a clean shutdown. Everything runs on
// seams: a mock MCP registry (clientFactory/transportFactory), a fake model
// registry with an unset key env, and the runTurnImpl/resolve test hooks.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  McpClientLike,
  McpHostOptions,
  ModelEntry,
  ResolvedModel,
  RunTurnOptions,
  ToolContext,
  TurnEvent,
} from "@hemiunu/engine";
import { emptyUsage } from "@hemiunu/engine";
import { DEFAULT_SOUL } from "@hemiunu/memory";
import { createEngineRuntime, type EngineRuntimeOptions } from "./runtime";

// Hermetic config root: configDir() reads HEMIUNU_CONFIG_DIR at call time, so
// hemitools, toolpolicy, and overlays never touch ~/.hemiunu.
process.env.HEMIUNU_CONFIG_DIR = mkdtempSync(join(tmpdir(), "hemi-runtime-test-"));

// --- fixtures -------------------------------------------------------------

/** Registry entries whose key env is deliberately unset, so any accidental
 *  real resolution fails fast instead of hitting the network. */
function entry(id: string, tags?: ModelEntry["tags"]): ModelEntry {
  return {
    id,
    label: id,
    provider: "openai",
    model: id,
    apiKeyEnv: "HEMI_RUNTIME_TEST_UNSET_KEY",
    contextWindow: 128_000,
    supports: { tools: true },
    tags,
  };
}

const registry: ModelEntry[] = [
  entry("big-model", ["synthesis"]),
  entry("cheap-model", ["research", "judge", "title"]),
];

/** A mock MCP registry: one remote server ("mock") serving one read-only tool. */
function fakeMcp() {
  const closed: string[] = [];
  const calls: Array<{ server: string; tool: string; args: unknown }> = [];
  const clientFactory = (server: string): McpClientLike => ({
    async connect() {},
    async listTools() {
      return {
        tools: [
          {
            name: "lookup",
            description: "Look something up.",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    },
    async callTool(params) {
      calls.push({ server, tool: params.name, args: params.arguments });
      return { content: [{ type: "text", text: "hit" }] };
    },
    async close() {
      closed.push(server);
    },
  });
  const transportFactory = (() => ({})) as unknown as NonNullable<
    McpHostOptions["transportFactory"]
  >;
  return { clientFactory, transportFactory, closed, calls };
}

/** A fake engine loop that records the RunTurnOptions the runtime assembled. */
function captureLoop(captured: RunTurnOptions[]) {
  return async function* loop(opts: RunTurnOptions): AsyncGenerator<TurnEvent> {
    captured.push(opts);
    yield { type: "turn-finish", text: "", usage: emptyUsage(), costUsd: 0, stopReason: "end" };
  };
}

function runtimeWith(over: Partial<EngineRuntimeOptions> = {}) {
  const mcp = fakeMcp();
  const captured: RunTurnOptions[] = [];
  const rt = createEngineRuntime({
    dbPath: ":memory:",
    registry,
    mcpServers: { mock: { type: "http", url: "http://mock.invalid/mcp" } },
    mcpHost: { clientFactory: mcp.clientFactory, transportFactory: mcp.transportFactory },
    webSearchEnv: {},
    runTurnImpl: captureLoop(captured),
    ...over,
  });
  return { rt, captured, mcp };
}

async function drain(events: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function toolCtx(emitted: TurnEvent[] = []): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "conv-test",
    emit: (e) => emitted.push(e),
    mode: () => "default",
    setMode: () => {},
  };
}

const HEMI_SERVERS = [
  "hemiunu-memory",
  "hemiunu-models",
  "hemiunu-ask",
  "hemiunu-team-control",
  "hemiunu-prototype",
  "hemiunu-share",
  "hemiunu-workspace",
  "hemiunu-sources",
  "hemiunu-skills",
  "hemiunu-prototype-knowledge",
  "hemiunu-orchestrator",
];

// --- tool inventory ---------------------------------------------------------

test("runtime assembles the full tool inventory for a turn", async () => {
  const { rt, captured } = runtimeWith();
  await drain(rt.runTurn({ prompt: "hi" }));

  const opts = captured[0];
  const names = new Set((opts.tools ?? []).map((t) => t.name));

  // All 11 in-process servers are represented.
  const servers = new Set(
    [...names].filter((n) => n.startsWith("mcp__hemiunu-")).map((n) => n.slice(5).split("__")[0]),
  );
  assert.deepEqual([...servers].sort(), [...HEMI_SERVERS].sort());

  // Engine control tools + the delegation surface.
  for (const t of [
    "todo_write",
    "enter_plan_mode",
    "exit_plan_mode",
    "delegate",
    "mcp__hemiunu-orchestrator__parallel",
  ]) {
    assert.ok(names.has(t), `expected ${t} in the turn's tool set`);
  }

  // The mock MCP registry server's tool, named mcp__<server>__<tool>.
  assert.ok(names.has("mcp__mock__lookup"));

  // web_fetch always; web_search NOT registered (no provider in the chain:
  // non-Anthropic model, empty env).
  assert.ok(names.has("web_fetch"));
  assert.ok(!names.has("web_search"));

  // No duplicate names in the advertised set.
  assert.equal(names.size, (opts.tools ?? []).length);

  // Durable pieces wired: model defaulted to the synthesis tag, transcript is
  // the runtime's store, the compactor is the compactionCheck.
  assert.equal(opts.model, "big-model");
  assert.equal(opts.transcript, rt.transcript);
  assert.equal(typeof opts.compactionCheck, "function");
  assert.equal(opts.registry, registry);

  // Sources are connected (the mock server), so the researcher is delegable.
  const delegate = (opts.tools ?? []).find((t) => t.name === "delegate");
  assert.match(delegate?.description ?? "", /researcher/);
});

test("web_search joins the tool set when the provider chain has a provider", async () => {
  const { rt, captured } = runtimeWith({ webSearchEnv: { TAVILY_API_KEY: "tvly-test" } });
  await drain(rt.runTurn({ prompt: "hi" }));
  const names = (captured[0].tools ?? []).map((t) => t.name);
  assert.ok(names.includes("web_search"));
});

test("per-turn mcpServers subset gates the host's tools and the researcher", async () => {
  const { rt, captured } = runtimeWith();
  await drain(rt.runTurn({ prompt: "hi", mcpServers: {} }));

  const names = (captured[0].tools ?? []).map((t) => t.name);
  assert.ok(!names.some((n) => n.startsWith("mcp__mock__")));
  // No sources this turn → the researcher isn't offered for delegation.
  const delegate = (captured[0].tools ?? []).find((t) => t.name === "delegate");
  assert.doesNotMatch(delegate?.description ?? "", /researcher/);
});

// --- option plumbing ---------------------------------------------------------

test("old agent.ts option names plumb through to the engine loop", async () => {
  const { rt, captured } = runtimeWith();
  const abort = new AbortController();
  await drain(
    rt.runTurn({
      prompt: "do the thing",
      model: "cheap-model",
      researchModel: "cheap-model",
      systemPrompt: "SYS-BASE",
      resume: "conv-42",
      workspace: { repo: "owner/repo", localSessionId: "s1" },
      abortController: abort,
      permissionMode: "plan",
      maxSteps: 7,
    }),
  );

  const opts = captured[0];
  assert.equal(opts.prompt, "do the thing");
  assert.equal(opts.model, "cheap-model");
  assert.equal(opts.researchModel, "cheap-model");
  assert.ok(opts.systemPrompt?.startsWith("SYS-BASE"));
  assert.equal(opts.resume, "conv-42");
  assert.deepEqual(opts.workspace, { repo: "owner/repo", localSessionId: "s1" });
  assert.equal(opts.abortController, abort);
  assert.equal(opts.permissionMode, "plan");
  assert.equal(opts.maxSteps, 7);
});

test("systemPrompt defaults to the soul, exactly like the old runtime", async () => {
  const { rt, captured } = runtimeWith();
  await drain(rt.runTurn({ prompt: "hi" }));
  assert.ok(captured[0].systemPrompt?.startsWith(DEFAULT_SOUL));
});

test("canUseTool reaches the pipeline gate: deny blocks, allow executes", async () => {
  const { rt, captured, mcp } = runtimeWith();
  const asked: string[] = [];
  let verdict: "allow" | "deny" = "deny";
  await drain(
    rt.runTurn({
      prompt: "hi",
      canUseTool: async (name) => {
        asked.push(name);
        return verdict === "deny"
          ? { behavior: "deny", message: "denied by test" }
          : { behavior: "allow" };
      },
    }),
  );

  const executor = captured[0].executor!;
  const denied = await executor.execute(
    { id: "c1", name: "mcp__mock__lookup", input: { q: "x" } },
    toolCtx(),
  );
  assert.equal(asked[0], "mcp__mock__lookup");
  assert.equal(denied.isError, true);
  assert.equal(denied.content, "denied by test");
  assert.equal(mcp.calls.length, 0, "a denied tool never executes");

  verdict = "allow";
  const allowed = await executor.execute(
    { id: "c2", name: "mcp__mock__lookup", input: { q: "x" } },
    toolCtx(),
  );
  assert.equal(allowed.content, "hit");
  assert.deepEqual(mcp.calls, [{ server: "mock", tool: "lookup", args: { q: "x" } }]);
});

test("alwaysAllow and autoAccept bypass the interactive gate", async () => {
  const { rt, captured, mcp } = runtimeWith();
  const asked: string[] = [];
  const gate = async (name: string) => {
    asked.push(name);
    return { behavior: "deny" as const, message: "should not be asked" };
  };

  await drain(
    rt.runTurn({ prompt: "hi", canUseTool: gate, alwaysAllow: new Set(["mcp__mock__lookup"]) }),
  );
  const viaAlways = await captured[0].executor!.execute(
    { id: "c1", name: "mcp__mock__lookup", input: {} },
    toolCtx(),
  );
  assert.equal(viaAlways.content, "hit");

  await drain(rt.runTurn({ prompt: "hi", canUseTool: gate, autoAccept: true }));
  const viaAuto = await captured[1].executor!.execute(
    { id: "c2", name: "mcp__mock__lookup", input: {} },
    toolCtx(),
  );
  assert.equal(viaAuto.content, "hit");

  assert.deepEqual(asked, [], "the interactive gate is never consulted");
  assert.equal(mcp.calls.length, 2);
});

// --- plan mode through the REAL engine loop -----------------------------------

test("permissionMode 'plan' filters the advertised tools in the loop", async () => {
  const advertised: string[][] = [];
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2, reasoning: 0 },
  };
  // A hand-rolled AI SDK v4 language model (agent-core must not import `ai`):
  // records the tools each step advertises, then streams one text answer.
  const languageModel = {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock",
    supportedUrls: Promise.resolve({}),
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream(o: { tools?: Array<{ name?: string }> }) {
      advertised.push((o.tools ?? []).map((t) => t.name ?? ""));
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "text-start", id: "t1" });
            c.enqueue({ type: "text-delta", id: "t1", delta: "planned" });
            c.enqueue({ type: "text-end", id: "t1" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            c.close();
          },
        }),
      };
    },
  };
  const resolve = (id: string): ResolvedModel => ({
    entry: registry.find((m) => m.id === id)!,
    languageModel: languageModel as unknown as ResolvedModel["languageModel"],
  });

  const mcp = fakeMcp();
  const rt = createEngineRuntime({
    dbPath: ":memory:",
    registry,
    mcpServers: { mock: { type: "http", url: "http://mock.invalid/mcp" } },
    mcpHost: { clientFactory: mcp.clientFactory, transportFactory: mcp.transportFactory },
    webSearchEnv: {},
    resolve, // no runTurnImpl → the REAL engine loop runs
  });

  const events = await drain(rt.runTurn({ prompt: "plan it", permissionMode: "plan" }));
  const finish = events.at(-1);
  assert.equal(finish?.type, "turn-finish");
  assert.equal((finish as Extract<TurnEvent, { type: "turn-finish" }>).text, "planned");

  const names = advertised[0];
  assert.ok(names.includes("exit_plan_mode"), "the plan-exit tool stays advertised");
  assert.ok(names.includes("web_fetch"), "read-only tools stay advertised");
  assert.ok(names.includes("mcp__mock__lookup"), "read-only MCP tools stay advertised");
  for (const gone of [
    "delegate",
    "mcp__hemiunu-orchestrator__parallel",
    "mcp__hemiunu-workspace__write_workspace_file",
    "mcp__hemiunu-prototype__save_prototype",
  ]) {
    assert.ok(!names.includes(gone), `${gone} must be filtered out in plan mode`);
  }

  await rt.shutdown();
});

// --- lifecycle ----------------------------------------------------------------

test("shutdown closes MCP clients and the transcript store", async () => {
  const { rt, mcp } = runtimeWith();
  await drain(rt.runTurn({ prompt: "hi" })); // connects the mock server
  await rt.shutdown();

  assert.deepEqual(mcp.closed, ["mock"]);
  assert.throws(() => rt.transcript.append("conv", [{ role: "user", content: "x" }]));
});

test("compactNow is wired to the runtime's transcript store", async () => {
  const { rt } = runtimeWith();
  await assert.rejects(rt.compactNow("no-such-conversation"), /Nothing to compact/);
  await rt.shutdown();
});
