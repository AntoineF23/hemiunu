// Engine-loop subagents (P4): delegate depth-1 recursion, parent stamping,
// ephemeral transcripts, tier resolution, abort propagation, custom-agent
// loading, and the parallel fan-out's per-task write scopes. The engine loop
// itself is covered by the engine's loop tests — here it is injected via the
// runTurnImpl seam so every RunTurnOptions contract can be asserted offline.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type {
  HemiTool,
  ModelEntry,
  ResolvedModel,
  RunTurnOptions,
  ToolContext,
  ToolOutput,
  TranscriptMessage,
  TurnEvent,
} from "@hemiunu/engine";
import { TRUNCATION_NOTE, emptyUsage, estimateContextTokens } from "@hemiunu/engine";
import { z } from "zod";
import { saveCustomAgent } from "./agents";
import {
  availableEngineAgents,
  createDelegateTool,
  DELEGATE_TOOL_NAME,
  runEngineSubagent,
  type EngineSubagentContext,
} from "./engine-subagents";
import { createOrchestratorTools } from "./hemitools";
import { SUBAGENT_GUARD } from "./subagents";
import { setToolPolicy } from "./toolpolicy";
import { activeProtoDir } from "./workspace";

// Hermetic config root: configDir() reads HEMIUNU_CONFIG_DIR at call time, so
// custom agents, toolpolicy, and activeProtoDir() never touch ~/.hemiunu.
process.env.HEMIUNU_CONFIG_DIR = mkdtempSync(join(tmpdir(), "hemi-subagents-test-"));

// --- fixtures -------------------------------------------------------------

function entry(id: string, tags?: ModelEntry["tags"]): ModelEntry {
  return {
    id,
    label: id,
    provider: "openai",
    model: id,
    contextWindow: 128_000,
    supports: { tools: true },
    tags,
  };
}

const registry: ModelEntry[] = [
  entry("big-model", ["synthesis"]),
  entry("cheap-model", ["research", "judge", "title"]),
  entry("exotic-model"),
];

/** Registry-only resolution — never touches provider factories or API keys. */
function fakeResolve(resolves: string[]) {
  return (id: string): ResolvedModel => {
    resolves.push(id);
    const found = registry.find((m) => m.id === id);
    if (!found) throw new Error(`Unknown model '${id}'.`);
    return { entry: found, languageModel: found.model };
  };
}

function fakeTool(name: string, onExecute?: (input: unknown) => ToolOutput): HemiTool {
  return {
    name,
    description: "",
    inputSchema: z.record(z.string(), z.unknown()),
    async execute(input) {
      return onExecute?.(input) ?? { content: "ok" };
    },
  };
}

/** The delegating turn's ToolContext (what the pipeline hands the tool). */
function toolCtx(events: TurnEvent[] = [], over: Partial<ToolContext> = {}): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "main-conv",
    toolCallId: "call-42",
    emit: (e) => events.push(e),
    mode: () => "default",
    setMode: () => {},
    ...over,
  };
}

/** ToolContext for calls a fake loop feeds through the sub-run's executor. */
function innerCtx(events: TurnEvent[] = []): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "sub-conv",
    emit: (e) => events.push(e),
    mode: () => "default",
    setMode: () => {},
  };
}

function finishEvent(text: string, stopReason: "end" | "aborted" | "error" = "end"): TurnEvent {
  return { type: "turn-finish", text, usage: emptyUsage(), costUsd: 0, stopReason };
}

/** A scripted engine loop that records the RunTurnOptions it was given. */
function scriptedLoop(captured: RunTurnOptions[], events: TurnEvent[]) {
  return async function* (opts: RunTurnOptions): AsyncGenerator<TurnEvent> {
    captured.push(opts);
    yield* events;
  };
}

const SUB_EVENTS: TurnEvent[] = [
  { type: "turn-start", conversationId: "sub-conv", model: "big-model" },
  { type: "text-delta", text: "working…" },
  { type: "tool-start", id: "sub-1", name: "mcp__hemiunu-prototype__save_prototype", input: {} },
  {
    type: "tool-result",
    id: "sub-1",
    name: "mcp__hemiunu-prototype__save_prototype",
    output: { content: "saved" },
  },
  { type: "step-finish", usage: emptyUsage() },
  finishEvent("final report"),
];

function baseCtx(over: Partial<EngineSubagentContext> = {}): EngineSubagentContext {
  return { registry, resolve: fakeResolve([]), ...over };
}

// --- delegate: depth-1 recursion, spec tools, ephemeral transcript ----------

test("delegate: the sub-run gets ONLY the spec's tools — never delegate/parallel — and no transcript", async () => {
  const captured: RunTurnOptions[] = [];
  const pool = [
    fakeTool("mcp__hemiunu-prototype__save_prototype"),
    fakeTool("mcp__hemiunu-workspace__write_workspace_file"),
    fakeTool(DELEGATE_TOOL_NAME),
    fakeTool("mcp__hemiunu-orchestrator__parallel"),
  ];
  const tool = createDelegateTool(
    baseCtx({ tools: pool, runTurnImpl: scriptedLoop(captured, SUB_EVENTS) }),
  );
  const out = (await tool.execute(
    { agent: "prototyper", prompt: "Build the wireframe." },
    toolCtx(),
  )) as ToolOutput;

  assert.equal(out.isError, undefined);
  assert.equal(out.content, "final report");
  assert.equal(captured.length, 1);
  const o = captured[0];
  // Depth 1: the prototyper's pattern (mcp__hemiunu-prototype__*) matches one
  // tool; the orchestration tools are excluded even from a matching pool.
  assert.deepEqual(
    o.tools?.map((t) => t.name),
    ["mcp__hemiunu-prototype__save_prototype"],
  );
  assert.equal(o.transcript, undefined, "sub-run history must be ephemeral");
  assert.equal(o.resume, undefined);
  assert.ok(o.executor, "the sub-run must go through the wired pipeline");
  assert.ok(o.compactionCheck, "the sub-run must wire a compaction guard against its window");
  assert.equal(o.prompt, "Build the wireframe.");
  // Spec prompt ported verbatim + the universal guard appended.
  assert.match(o.systemPrompt ?? "", /prototyper subagent/);
  assert.ok((o.systemPrompt ?? "").includes(SUBAGENT_GUARD));
});

test("delegate: a subagent handed the whole pool still cannot reach delegation tools", async () => {
  const captured: RunTurnOptions[] = [];
  const pool = [
    fakeTool(DELEGATE_TOOL_NAME),
    fakeTool("mcp__hemiunu-orchestrator__parallel"),
    fakeTool("mcp__hemiunu-workspace__read_workspace_file"),
    fakeTool("mcp__notion__search"),
  ];
  const tool = createDelegateTool(
    baseCtx({
      tools: pool,
      sourceTools: ["mcp__notion__*"],
      runTurnImpl: scriptedLoop(captured, [finishEvent("found it")]),
    }),
  );
  await tool.execute({ agent: "researcher", prompt: "Find X." }, toolCtx());
  // Researcher patterns include the source tools; orchestration stays out.
  assert.deepEqual(
    captured[0].tools?.map((t) => t.name),
    ["mcp__notion__search"],
  );
});

// --- sub-run context safety: the ephemeral window is bounded before overflow -
// runEngineSubagent runs an ephemeral loop with no durable transcript; a
// multi-step research/tool session grows its in-memory window unbounded and
// overflowed the model (the researcher's 844k → ContextWindowExceeded). The
// sub-run must wire the Compactor against the run model's window so the wire
// always fits — folding, or (as here, when the summarizer can't run) truncating.

test("sub-run: the wired compaction guard bounds an oversized ephemeral window to the model's small window", async () => {
  // A tiny-window model; its summarizer is unusable ({} → generateText throws),
  // so the guard must fall back to truncating the ephemeral window in place.
  const smallEntry: ModelEntry = {
    id: "tiny",
    label: "Tiny",
    provider: "openai",
    model: "tiny",
    contextWindow: 1000,
    supports: { tools: true },
    tags: ["synthesis"],
  };
  const bounded: TranscriptMessage[][] = [];
  const runTurnImpl = async function* (o: RunTurnOptions): AsyncGenerator<TurnEvent> {
    assert.ok(o.compactionCheck, "sub-run wires a compaction guard");
    // Simulate mid-turn growth: an ephemeral window far larger than the window.
    const messages: TranscriptMessage[] = [{ role: "user", content: "x".repeat(40000) }];
    await o.compactionCheck({
      conversationId: "sub",
      messages,
      entry: o.resolvedModel!.entry,
      usage: emptyUsage(),
      system: o.systemPrompt,
      tools: o.tools,
    });
    bounded.push(messages);
    yield finishEvent("done");
  };
  const ctx = baseCtx({
    // resolve → the tiny entry with an UNUSABLE summarizer model, forcing the
    // truncation fallback (no network, fully offline).
    resolve: (id: string) => ({ entry: { ...smallEntry, id }, languageModel: {} as never }),
    runTurnImpl,
  });

  const text = await runEngineSubagent("strategist", "think hard", ctx, { taskId: "t1" });
  assert.equal(text, "done", "the sub-run completes instead of overflowing");
  const messages = bounded[0];
  assert.equal(messages[0].content, TRUNCATION_NOTE, "the oversized window was truncated");
  assert.ok(
    estimateContextTokens(messages) < smallEntry.contextWindow,
    "the bounded window fits the model's context",
  );
});

// --- delegate: task lifecycle + parent stamping ------------------------------

test("delegate: task-start/task-done wrap the run and nested events carry parent = the call id", async () => {
  const events: TurnEvent[] = [];
  const tool = createDelegateTool(baseCtx({ runTurnImpl: scriptedLoop([], SUB_EVENTS) }));
  await tool.execute({ agent: "strategist", prompt: "Assess.", label: "assess" }, toolCtx(events));

  assert.deepEqual(events[0], {
    type: "task-start",
    id: "call-42",
    agent: "strategist",
    label: "assess",
  });
  assert.deepEqual(events.at(-1), {
    type: "task-done",
    id: "call-42",
    agent: "strategist",
    label: "assess",
    ok: true,
  });
  const nested = events.slice(1, -1);
  assert.deepEqual(
    nested.map((e) => e.type),
    ["text-delta", "tool-start", "tool-result"],
    "turn-start/step-finish/turn-finish stay internal to the sub-run",
  );
  for (const e of nested) {
    assert.equal("parent" in e ? e.parent : undefined, "call-42");
  }
});

// --- tier resolution ---------------------------------------------------------

test("delegate: tiers resolve via registry tags — research vs synthesis", async () => {
  const resolves: string[] = [];
  const ctx = baseCtx({
    resolve: fakeResolve(resolves),
    sourceTools: ["mcp__notion__*"],
    runTurnImpl: scriptedLoop([], [finishEvent("done")]),
  });
  const tool = createDelegateTool(ctx);
  await tool.execute({ agent: "researcher", prompt: "look" }, toolCtx());
  await tool.execute({ agent: "strategist", prompt: "think" }, toolCtx());
  assert.deepEqual(resolves, ["cheap-model", "big-model"]);
});

test("delegate: explicit model overrides beat the tags", async () => {
  const resolves: string[] = [];
  await runEngineSubagent(
    "analyst",
    "crunch",
    baseCtx({
      model: "exotic-model",
      resolve: fakeResolve(resolves),
      runTurnImpl: scriptedLoop([], [finishEvent("done")]),
    }),
    { taskId: "t1" },
  );
  assert.deepEqual(resolves, ["exotic-model"]);
});

test("delegate: the researcher is refused when no sources are connected", async () => {
  const events: TurnEvent[] = [];
  const tool = createDelegateTool(baseCtx({ runTurnImpl: scriptedLoop([], []) }));
  const out = (await tool.execute(
    { agent: "researcher", prompt: "look" },
    toolCtx(events),
  )) as ToolOutput;
  assert.equal(out.isError, true);
  assert.match(out.content, /sources are connected/);
  const done = events.at(-1);
  assert.equal(done?.type === "task-done" ? done.ok : undefined, false);
});

// --- custom agents -------------------------------------------------------------

test("custom agents: loaded from agents/*.md, any registry model, guard appended, no tools", async () => {
  saveCustomAgent({
    name: "reviewer",
    description: "Reviews product copy with a sharp eye.",
    model: "exotic-model",
    prompt: "You are the reviewer.",
  });
  const resolves: string[] = [];
  const captured: RunTurnOptions[] = [];
  const ctx = baseCtx({
    tools: [fakeTool("mcp__hemiunu-workspace__write_workspace_file")],
    resolve: fakeResolve(resolves),
    runTurnImpl: scriptedLoop(captured, [finishEvent("LGTM")]),
  });

  // Discoverable: the roster (and the delegate description) name it.
  const roster = availableEngineAgents(ctx);
  assert.ok(roster.some((a) => a.name === "reviewer"));
  assert.match(createDelegateTool(ctx).description, /reviewer/);

  const out = (await createDelegateTool(ctx).execute(
    { agent: "reviewer", prompt: "Review this." },
    toolCtx(),
  )) as ToolOutput;
  assert.equal(out.content, "LGTM");
  assert.deepEqual(resolves, ["exotic-model"], "a custom agent may name ANY registry model");
  const o = captured[0];
  assert.ok((o.systemPrompt ?? "").startsWith("You are the reviewer."));
  assert.ok((o.systemPrompt ?? "").includes(SUBAGENT_GUARD));
  assert.deepEqual(o.tools, [], "custom agents are reasoning-only");
});

test("delegate: an unknown agent returns an error listing the available agents", async () => {
  const tool = createDelegateTool(baseCtx({ runTurnImpl: scriptedLoop([], []) }));
  const out = (await tool.execute({ agent: "nonexistent", prompt: "x" }, toolCtx())) as ToolOutput;
  assert.equal(out.isError, true);
  assert.match(out.content, /Unknown agent 'nonexistent'/);
  assert.match(out.content, /strategist/);
});

// --- abort propagation ----------------------------------------------------------

test("delegate: aborting the parent turn cancels the sub-run", async () => {
  const runTurnImpl = async function* (o: RunTurnOptions): AsyncGenerator<TurnEvent> {
    const signal = o.abortController!.signal;
    if (!signal.aborted) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    }
    yield finishEvent("", "aborted");
  };
  const parent = new AbortController();
  const events: TurnEvent[] = [];
  const tool = createDelegateTool(baseCtx({ runTurnImpl }));
  const pending = tool.execute(
    { agent: "strategist", prompt: "long think" },
    toolCtx(events, { signal: parent.signal }),
  ) as Promise<ToolOutput>;
  parent.abort();
  const out = await pending;
  assert.equal(out.isError, true);
  assert.match(out.content, /aborted/);
  const done = events.at(-1);
  assert.equal(done?.type === "task-done" ? done.ok : undefined, false);
});

// --- auto-approve with the policy backstop ---------------------------------------

test("sub-runs auto-approve, but a persistent 'block' still refuses the tool", async () => {
  const executed: string[] = [];
  const proto = fakeTool("mcp__hemiunu-prototype__save_prototype", () => {
    executed.push("ran");
    return { content: "saved" };
  });
  // The fake loop drives ONE call through the sub-run's REAL pipeline.
  const outputs: ToolOutput[] = [];
  const runTurnImpl = async function* (o: RunTurnOptions): AsyncGenerator<TurnEvent> {
    const out = await o.executor!.execute(
      { id: "s1", name: proto.name, input: { files: {} } },
      innerCtx(),
    );
    outputs.push(out);
    yield finishEvent(out.content);
  };
  const ctx = baseCtx({ tools: [proto], runTurnImpl });

  setToolPolicy(proto.name, "block");
  try {
    await runEngineSubagent("prototyper", "build", ctx, { taskId: "t1" });
    assert.equal(outputs[0].isError, true);
    assert.match(outputs[0].content, /Blocked/);
    assert.deepEqual(executed, [], "a blocked tool must never run, even auto-approved");
  } finally {
    setToolPolicy(proto.name, "ask");
  }

  const text = await runEngineSubagent("prototyper", "build", ctx, { taskId: "t2" });
  assert.equal(text, "saved", "without the block, the sub-run auto-approves (no gate wired)");
  assert.deepEqual(executed, ["ran"]);
});

// --- parallel: fan-out on the engine with per-task write scopes -------------------

test("parallel: per-task write scopes are enforced by the sub-run pipeline", async () => {
  const written: string[] = [];
  const writeTool = fakeTool("mcp__hemiunu-workspace__write_workspace_file", (input) => {
    written.push((input as { path: string }).path);
    return { content: "written" };
  });
  // Both tasks try to write A.tsx — which must already exist so the
  // out-of-scope task hits the overwrite denial (new files are write-if-absent).
  const target = join(activeProtoDir(), "src/components/A.tsx");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "existing", "utf8");

  const runTurnImpl = async function* (o: RunTurnOptions): AsyncGenerator<TurnEvent> {
    const out = await o.executor!.execute(
      { id: "w1", name: writeTool.name, input: { path: o.prompt, content: "new" } },
      innerCtx(),
    );
    yield finishEvent(out.isError ? `DENIED: ${out.content}` : `WROTE ${o.prompt}`);
  };
  const [parallel] = createOrchestratorTools(baseCtx({ tools: [writeTool], runTurnImpl }));
  const events: TurnEvent[] = [];
  const out = (await parallel.execute(
    {
      tasks: [
        {
          agent: "designer",
          label: "a",
          prompt: "src/components/A.tsx",
          writes: ["src/components/A.tsx"],
        },
        {
          agent: "designer",
          label: "b",
          prompt: "src/components/A.tsx",
          writes: ["src/components/B.tsx"],
        },
      ],
    },
    toolCtx(events, { toolCallId: "pcall" }),
  )) as ToolOutput;

  assert.match(out.content, /## a — designer\nWROTE src\/components\/A\.tsx/);
  assert.match(out.content, /## b — designer\nDENIED:/);
  assert.match(out.content, /outside your scope/);
  assert.deepEqual(written, ["src/components/A.tsx"], "only the in-scope task may write");

  // Task ids derive from the delegating call id; lifecycle events pair up.
  const starts = events.filter((e) => e.type === "task-start");
  assert.deepEqual(
    starts.map((e) => (e.type === "task-start" ? e.id : "")),
    ["pcall:0", "pcall:1"],
  );
  const dones = events.filter((e) => e.type === "task-done");
  assert.deepEqual(
    dones.map((e) => (e.type === "task-done" ? e.ok : undefined)).sort(),
    [true, true],
    "a denied write is a completed task (the denial is the subagent's feedback)",
  );
});

test("parallel: unscoped concurrent designers are refused before anything runs", async () => {
  const captured: RunTurnOptions[] = [];
  const [parallel] = createOrchestratorTools(
    baseCtx({ runTurnImpl: scriptedLoop(captured, [finishEvent("x")]) }),
  );
  const events: TurnEvent[] = [];
  const out = (await parallel.execute(
    {
      tasks: [
        { agent: "designer", label: "a", prompt: "x", writes: ["src/A.tsx"] },
        { agent: "designer", label: "b", prompt: "y" },
      ],
    },
    toolCtx(events),
  )) as ToolOutput;
  assert.match(out.content, /Refused/);
  assert.match(out.content, /writes/);
  assert.equal(captured.length, 0, "no subagent may start on a refused fan-out");
  assert.equal(events.length, 0);
});
