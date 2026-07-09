import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { TurnEvent } from "./events";
import type { ModelEntry, ResolvedModel } from "./models";
import type { HemiTool } from "./tool";
import { TranscriptStore } from "./transcript";
import { currentWorkspace } from "./workspace";
import type { TranscriptMessage } from "./transcript";
import type { ToolCall } from "./executor";
import {
  balanceToolMessages,
  ensureAssistantToolCalls,
  PLAN_EXIT_TOOL,
  runTurn,
  wireShape,
  type RunTurnOptions,
} from "./loop";

// --- fixtures -------------------------------------------------------------

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 100, noCache: 85, cacheRead: 10, cacheWrite: 5 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

type StreamResult = { stream: ReadableStream<LanguageModelV4StreamPart> };

function textStream(text: string): StreamResult {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
      ],
    }),
  };
}

function toolCallStream(name: string, input: unknown, callId = "call-1"): StreamResult {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: callId, toolName: name, input: JSON.stringify(input) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
      ],
    }),
  };
}

function entryFor(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "mock-model",
    label: "Mock model",
    provider: "openai",
    model: "mock",
    contextWindow: 128_000,
    supports: { tools: true },
    ...over,
  };
}

function resolvedFor(model: MockLanguageModelV4, over: Partial<ModelEntry> = {}): ResolvedModel {
  return { entry: entryFor(over), languageModel: model };
}

const echoTool: HemiTool<{ value: string }> = {
  name: "echo",
  description: "Echo the value back.",
  inputSchema: z.object({ value: z.string() }),
  readOnly: true,
  async execute(input) {
    return { content: `echo:${input.value}` };
  },
};

async function collect(opts: RunTurnOptions): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const e of runTurn(opts)) events.push(e);
  return events;
}

function finishOf(events: TurnEvent[]): Extract<TurnEvent, { type: "turn-finish" }> {
  const last = events.at(-1);
  assert.equal(last?.type, "turn-finish");
  return last as Extract<TurnEvent, { type: "turn-finish" }>;
}

// --- tests ----------------------------------------------------------------

test("single-step text turn: event order, streamed deltas, usage mapping", async () => {
  const model = new MockLanguageModelV4({ doStream: [textStream("Hello")] });
  const events = await collect({ prompt: "hi", resolvedModel: resolvedFor(model) });

  assert.deepEqual(
    events.map((e) => e.type),
    ["turn-start", "text-delta", "step-finish", "turn-finish"],
  );
  const start = events[0] as Extract<TurnEvent, { type: "turn-start" }>;
  assert.equal(start.model, "mock-model");
  assert.ok(start.conversationId.length > 0);
  const finish = finishOf(events);
  assert.equal(finish.text, "Hello");
  assert.equal(finish.stopReason, "end");
  assert.deepEqual(finish.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    steps: 1,
  });
  assert.equal(finish.costUsd, 0); // no cost table on the entry
});

test("multi-step tool round-trip: executor runs, results feed the next step, usage/cost accumulate", async () => {
  const model = new MockLanguageModelV4({
    doStream: [toolCallStream("echo", { value: "hi" }), textStream("done")],
  });
  const store = new TranscriptStore(":memory:");
  const events = await collect({
    prompt: "go",
    resume: "conv-tools",
    resolvedModel: resolvedFor(model, {
      cost: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    }),
    tools: [echoTool],
    transcript: store,
  });

  assert.deepEqual(
    events.map((e) => e.type),
    [
      "turn-start",
      "tool-start",
      "step-finish",
      "tool-result",
      "text-delta",
      "step-finish",
      "turn-finish",
    ],
  );
  const start = events[1] as Extract<TurnEvent, { type: "tool-start" }>;
  assert.equal(start.name, "echo");
  assert.deepEqual(start.input, { value: "hi" }); // parsed, not a JSON string
  const result = events[3] as Extract<TurnEvent, { type: "tool-result" }>;
  assert.equal(result.id, start.id);
  assert.deepEqual(result.output, { content: "echo:hi" });

  // The second model call must see the tool result in its prompt.
  assert.equal(model.doStreamCalls.length, 2);
  const secondPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
  assert.ok(secondPrompt.includes("echo:hi"));

  // Usage sums both steps; cost comes from the registry cost table.
  const finish = finishOf(events);
  assert.equal(finish.text, "done");
  assert.deepEqual(finish.usage, {
    inputTokens: 200,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    steps: 2,
  });
  // (200*3 + 40*15 + 20*0.3 + 10*3.75) / 1e6
  assert.ok(Math.abs(finish.costUsd - 0.0012435) < 1e-12);

  // Transcript rows: user, assistant(tool-call), tool, assistant(text).
  const persisted = store.load("conv-tools").messages;
  assert.deepEqual(
    persisted.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  store.close();
});

test("abort mid-stream: turn ends with stopReason aborted", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "t1" });
        },
        pull(c) {
          c.enqueue({ type: "text-delta", id: "t1", delta: "x" }); // never finishes
        },
      }),
    }),
  });
  const abortController = new AbortController();
  const events: TurnEvent[] = [];
  for await (const e of runTurn({
    prompt: "hi",
    resolvedModel: resolvedFor(model),
    abortController,
  })) {
    events.push(e);
    if (e.type === "text-delta") abortController.abort();
  }
  assert.equal(finishOf(events).stopReason, "aborted");
  assert.ok(!events.some((e) => e.type === "step-finish")); // step never completed
});

test("abort between steps: a tool aborting stops the loop before the next model call", async () => {
  const abortController = new AbortController();
  const stopTool: HemiTool = {
    name: "stop_it",
    description: "Abort the turn.",
    inputSchema: z.object({}),
    async execute() {
      abortController.abort();
      return { content: "stopping" };
    },
  };
  const model = new MockLanguageModelV4({
    doStream: [toolCallStream("stop_it", {}), textStream("never reached")],
  });
  const events = await collect({
    prompt: "stop",
    resolvedModel: resolvedFor(model),
    tools: [stopTool],
    abortController,
  });
  assert.equal(model.doStreamCalls.length, 1);
  assert.equal(finishOf(events).stopReason, "aborted");
});

test("max-steps guard: loop stops after maxSteps model round-trips", async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => toolCallStream("echo", { value: "again" }, `call-${++call}`),
  });
  const events = await collect({
    prompt: "loop forever",
    resolvedModel: resolvedFor(model),
    tools: [echoTool],
    maxSteps: 2,
  });
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(events.filter((e) => e.type === "step-finish").length, 2);
  const finish = finishOf(events);
  assert.equal(finish.stopReason, "max-steps");
  assert.equal(finish.usage.steps, 2);
});

test("plan mode: only read-only tools + exit_plan_mode are advertised, until setMode exits", async () => {
  const writeTool: HemiTool = {
    name: "write_file",
    description: "Write a file.",
    inputSchema: z.object({ path: z.string() }),
    async execute() {
      return { content: "written" };
    },
  };
  const exitPlan: HemiTool = {
    name: PLAN_EXIT_TOOL,
    description: "Leave plan mode.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      ctx.setMode("default");
      return { content: "plan approved" };
    },
  };
  const model = new MockLanguageModelV4({
    doStream: [toolCallStream(PLAN_EXIT_TOOL, {}), textStream("executing now")],
  });
  const events = await collect({
    prompt: "plan it",
    resolvedModel: resolvedFor(model),
    tools: [echoTool, writeTool, exitPlan],
    permissionMode: "plan",
  });

  const names = (i: number) => model.doStreamCalls[i].tools?.map((t) => t.name);
  assert.deepEqual(names(0), ["echo", PLAN_EXIT_TOOL]); // write_file filtered out
  assert.deepEqual(names(1), ["echo", "write_file", PLAN_EXIT_TOOL]); // back after setMode
  assert.equal(finishOf(events).stopReason, "end");
});

test("anthropic prompt caching: breakpoints on the system prompt and last messages", async () => {
  const anthropicModel = new MockLanguageModelV4({ doStream: [textStream("cached")] });
  await collect({
    prompt: "hi",
    systemPrompt: "You are Hemiunu.",
    resolvedModel: resolvedFor(anthropicModel, {
      provider: "anthropic",
      supports: { tools: true, caching: true },
    }),
  });
  const prompt = anthropicModel.doStreamCalls[0].prompt;
  const cacheControl = (i: number) =>
    (prompt[i].providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl;
  assert.equal(prompt[0].role, "system");
  assert.deepEqual(cacheControl(0), { type: "ephemeral" });
  assert.deepEqual(cacheControl(prompt.length - 1), { type: "ephemeral" });

  // Non-Anthropic models get no cache-control metadata.
  const openaiModel = new MockLanguageModelV4({ doStream: [textStream("plain")] });
  await collect({
    prompt: "hi",
    systemPrompt: "You are Hemiunu.",
    resolvedModel: resolvedFor(openaiModel),
  });
  assert.ok(!JSON.stringify(openaiModel.doStreamCalls[0].prompt).includes("cacheControl"));
});

test("ALS relay: tool executions see the turn's workspace via currentWorkspace()", async () => {
  const whereTool: HemiTool = {
    name: "where",
    description: "Report the bound workspace.",
    inputSchema: z.object({}),
    readOnly: true,
    async execute() {
      return { content: currentWorkspace()?.repo ?? "none" };
    },
  };
  const model = new MockLanguageModelV4({
    doStream: [toolCallStream("where", {}), textStream("done")],
  });
  const events = await collect({
    prompt: "where am I?",
    resolvedModel: resolvedFor(model),
    tools: [whereTool],
    workspace: { repo: "acme/site" },
  });
  const result = events.find((e) => e.type === "tool-result") as Extract<
    TurnEvent,
    { type: "tool-result" }
  >;
  assert.deepEqual(result.output, { content: "acme/site" });
});

test("resume: a second turn replays the persisted history to the model", async () => {
  const store = new TranscriptStore(":memory:");
  const first = new MockLanguageModelV4({ doStream: [textStream("first answer")] });
  await collect({
    prompt: "first question",
    resume: "conv-resume",
    resolvedModel: resolvedFor(first),
    transcript: store,
  });
  assert.equal(store.load("conv-resume").messages.length, 2); // user + assistant

  const second = new MockLanguageModelV4({ doStream: [textStream("second answer")] });
  await collect({
    prompt: "second question",
    resume: "conv-resume",
    resolvedModel: resolvedFor(second),
    transcript: store,
  });
  const replayed = JSON.stringify(second.doStreamCalls[0].prompt);
  assert.ok(replayed.includes("first question"));
  assert.ok(replayed.includes("first answer"));
  assert.equal(store.load("conv-resume").messages.length, 4);
  store.close();
});

test("compaction hook: called once per step with the live message window", async () => {
  const model = new MockLanguageModelV4({
    doStream: [toolCallStream("echo", { value: "x" }), textStream("done")],
  });
  const seen: number[] = [];
  await collect({
    prompt: "go",
    resolvedModel: resolvedFor(model),
    tools: [echoTool],
    compactionCheck: ({ messages }) => {
      seen.push(messages.length);
    },
  });
  // Step 1 sees [user]; step 2 sees [user, assistant, tool].
  assert.deepEqual(seen, [1, 3]);
});

test("tool errors surface as error outputs, not thrown turns", async () => {
  const failTool: HemiTool = {
    name: "explode",
    description: "Always fails.",
    inputSchema: z.object({}),
    async execute() {
      throw new Error("boom");
    },
  };
  const model = new MockLanguageModelV4({
    doStream: [toolCallStream("explode", {}), textStream("recovered")],
  });
  const events = await collect({
    prompt: "try it",
    resolvedModel: resolvedFor(model),
    tools: [failTool],
  });
  const result = events.find((e) => e.type === "tool-result") as Extract<
    TurnEvent,
    { type: "tool-result" }
  >;
  assert.equal(result.output.isError, true);
  assert.ok(result.output.content.includes("boom"));
  assert.equal(finishOf(events).stopReason, "end");
});

test("promptHints: the entry's family addenda append after the caller's system prompt", async () => {
  const model = new MockLanguageModelV4({ doStream: [textStream("ok")] });
  await collect({
    prompt: "who are you?",
    systemPrompt: "You are Hemiunu, a product agent.",
    resolvedModel: resolvedFor(model, {
      promptHints: ["Say the word Hemiunu explicitly.", "Never answer with a menu."],
    }),
  });
  const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
  assert.match(prompt, /Model-specific adjustments/);
  assert.match(prompt, /Say the word Hemiunu explicitly\./);
  assert.match(prompt, /Never answer with a menu\./);
  // The soul still leads; the addendum follows it in the SAME system message.
  assert.ok(
    prompt.indexOf("You are Hemiunu, a product agent.") <
      prompt.indexOf("Model-specific adjustments"),
    "the caller's system prompt must come first",
  );
});

test("promptHints: entries without hints leave the system prompt untouched", async () => {
  const model = new MockLanguageModelV4({ doStream: [textStream("ok")] });
  await collect({
    prompt: "hi",
    systemPrompt: "Base prompt.",
    resolvedModel: resolvedFor(model),
  });
  const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
  assert.ok(!prompt.includes("Model-specific adjustments"));
});

// --- tool-call / tool-result balancing ------------------------------------

const asstCall = (id: string, name = "echo"): TranscriptMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: name, input: { value: id } }],
});
const toolResult = (...ids: string[]): TranscriptMessage => ({
  role: "tool",
  content: ids.map((id) => ({
    type: "tool-result",
    toolCallId: id,
    toolName: "echo",
    output: { type: "text", value: `ok:${id}` },
  })),
});
const userMsg = (text: string): TranscriptMessage => ({ role: "user", content: text });

test("balanceToolMessages: drops an orphaned tool output with no preceding tool-call", () => {
  const history = [userMsg("hi"), toolResult("c1")];
  const out = balanceToolMessages(history);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user"],
  );
});

test("balanceToolMessages: a balanced pair passes through by reference, unchanged", () => {
  const history = [userMsg("hi"), asstCall("c1"), toolResult("c1")];
  const out = balanceToolMessages(history);
  assert.equal(out.length, 3);
  out.forEach((m, i) => assert.equal(m, history[i])); // same references — no copy
});

test("balanceToolMessages: drops a trailing dangling assistant tool-call (no result)", () => {
  const history = [userMsg("hi"), asstCall("c1")];
  const out = balanceToolMessages(history);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user"],
  );
});

test("balanceToolMessages: keeps assistant text when its dangling tool-call is dropped", () => {
  const history: TranscriptMessage[] = [
    userMsg("hi"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool-call", toolCallId: "c1", toolName: "echo", input: {} },
      ],
    },
  ];
  const out = balanceToolMessages(history);
  assert.equal(out.length, 2);
  const asst = out[1] as Extract<TranscriptMessage, { role: "assistant" }>;
  assert.deepEqual(asst.content, [{ type: "text", text: "let me check" }]);
});

test("balanceToolMessages: in a mixed tool message, drops only the orphaned output", () => {
  const history = [userMsg("hi"), asstCall("c1"), toolResult("c1", "c2")];
  const out = balanceToolMessages(history);
  const tool = out.at(-1) as Extract<TranscriptMessage, { role: "tool" }>;
  assert.deepEqual(
    tool.content.filter((p) => p.type === "tool-result").map((p) => p.toolCallId),
    ["c1"], // c2 had no preceding tool-call
  );
});

test("balanceToolMessages: duplicate results for one id keep the LAST", () => {
  const result = (value: string): TranscriptMessage => ({
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "c1", toolName: "echo", output: { type: "text", value } },
    ],
  });
  const out = balanceToolMessages([userMsg("hi"), asstCall("c1"), result("first"), result("last")]);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  const tool = out[2] as Extract<TranscriptMessage, { role: "tool" }>;
  const kept = tool.content.filter((p) => p.type === "tool-result");
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].output, { type: "text", value: "last" });
});

test("balanceToolMessages: out-of-order pair becomes adjacent — no dangling call", () => {
  // The result was recorded BEFORE its call in array order (proxied step
  // reordering); the old balancer dropped the result and kept a dangling call.
  const out = balanceToolMessages([userMsg("hi"), toolResult("c1"), asstCall("c1")]);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  const tool = out[2] as Extract<TranscriptMessage, { role: "tool" }>;
  assert.deepEqual(
    tool.content.filter((p) => p.type === "tool-result").map((p) => p.toolCallId),
    ["c1"],
  );
});

test("balanceToolMessages: a compaction splice between the pair is relocated after it", () => {
  const summary = userMsg("Summary of the conversation so far: …");
  const out = balanceToolMessages([userMsg("q"), asstCall("c1"), summary, toolResult("c1")]);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "tool", "user"],
  );
  assert.equal(out[3], summary); // the splice rides after the pair, by reference
});

test("balanceToolMessages: consecutive assistant messages merge, incl. providerOptions", () => {
  const a1: TranscriptMessage = {
    role: "assistant",
    content: [{ type: "text", text: "thinking." }],
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
  const a2: TranscriptMessage = {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "echo", input: {} }],
    providerOptions: { openai: { store: false } },
  };
  const out = balanceToolMessages([userMsg("hi"), a1, a2, toolResult("c1")]);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  const asst = out[1] as Extract<TranscriptMessage, { role: "assistant" }>;
  assert.deepEqual(
    (asst.content as { type: string }[]).map((p) => p.type),
    ["text", "tool-call"],
  );
  assert.deepEqual(asst.providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
    openai: { store: false },
  });
});

test("balanceToolMessages: multi-assistant chain with ONE tool message answering both", () => {
  const out = balanceToolMessages([
    userMsg("hi"),
    asstCall("c1"),
    asstCall("c2"),
    toolResult("c1", "c2"),
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  const asst = out[1] as Extract<TranscriptMessage, { role: "assistant" }>;
  assert.deepEqual(
    (asst.content as { toolCallId: string }[]).map((p) => p.toolCallId),
    ["c1", "c2"],
  );
  const tool = out[2] as Extract<TranscriptMessage, { role: "tool" }>;
  assert.deepEqual(
    tool.content.filter((p) => p.type === "tool-result").map((p) => p.toolCallId),
    ["c1", "c2"], // one tool message, results in call order
  );
});

test("balanceToolMessages: a duplicated tool-call id keeps the FIRST introduction", () => {
  const out = balanceToolMessages([
    userMsg("hi"),
    asstCall("c1"),
    toolResult("c1"),
    asstCall("c1"), // same id introduced again — dropped
    toolResult("c1"),
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
});

test("balanceToolMessages: a canonical multi-step chain passes through by reference", () => {
  const history = [
    userMsg("hi"),
    asstCall("c1"),
    toolResult("c1"),
    asstCall("c2"),
    toolResult("c2"),
    { role: "assistant", content: "done" } as TranscriptMessage,
    userMsg("next"),
  ];
  const out = balanceToolMessages(history);
  assert.equal(out, history); // the SAME array — zero copies on the hot path
});

test("ensureAssistantToolCalls: no-op when the snapshot already carries every call", () => {
  const snapshot = [asstCall("c1")];
  const calls: ToolCall[] = [{ id: "c1", name: "echo", input: { value: "c1" } }];
  assert.equal(ensureAssistantToolCalls(snapshot, calls), snapshot); // same reference
});

test("ensureAssistantToolCalls: injects a call missing from the assistant snapshot", () => {
  // The stream reported c1 but the persisted assistant message is text-only.
  const snapshot: TranscriptMessage[] = [{ role: "assistant", content: "on it" }];
  const calls: ToolCall[] = [{ id: "c1", name: "echo", input: { value: "x" } }];
  const out = ensureAssistantToolCalls(snapshot, calls);
  const asst = out[0] as Extract<TranscriptMessage, { role: "assistant" }>;
  assert.deepEqual(asst.content, [
    { type: "text", text: "on it" },
    { type: "tool-call", toolCallId: "c1", toolName: "echo", input: { value: "x" } },
  ]);
  // The resulting history now balances against a tool result for c1.
  assert.deepEqual(
    balanceToolMessages([...out, toolResult("c1")]).map((m) => m.role),
    ["assistant", "tool"],
  );
});

test("ensureAssistantToolCalls: appends a fresh assistant message when the snapshot has none", () => {
  const calls: ToolCall[] = [{ id: "c1", name: "echo", input: {} }];
  const out = ensureAssistantToolCalls([], calls);
  assert.deepEqual(out, [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "echo", input: {} }],
    },
  ]);
});

test("ensureAssistantToolCalls: appends fresh when the FINAL message is not an assistant", () => {
  // The last assistant is mid-array — injecting there would put the call
  // before the messages that follow it. The call must land LAST instead.
  const snapshot: TranscriptMessage[] = [
    { role: "assistant", content: "on it" },
    toolResult("earlier"),
  ];
  const calls: ToolCall[] = [{ id: "c1", name: "echo", input: {} }];
  const out = ensureAssistantToolCalls(snapshot, calls);
  assert.equal(out.length, 3);
  assert.equal(out[0], snapshot[0]); // untouched, by reference
  assert.deepEqual(out[2], {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "echo", input: {} }],
  });
});

test("wireShape: roles + part types + tool ids — never content", () => {
  const shape = wireShape([
    { role: "system", content: "SECRET system" },
    userMsg("SECRET question"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "SECRET answer" },
        { type: "tool-call", toolCallId: "c1", toolName: "echo", input: { value: "SECRET" } },
      ],
    },
    toolResult("c1"),
  ]);
  assert.equal(shape, "system | user | assistant[text tool-call:c1] | tool[tool-result:c1]");
  assert.ok(!shape.includes("SECRET"));
});

test("resume: a persisted orphaned tool output never reaches the provider", async () => {
  const store = new TranscriptStore(":memory:");
  // Seed a wedged transcript: a tool output with no preceding assistant call.
  store.append("conv-orphan", [userMsg("earlier question"), toolResult("stale-1")]);

  const model = new MockLanguageModelV4({ doStream: [textStream("recovered")] });
  const events = await collect({
    prompt: "continue",
    resume: "conv-orphan",
    resolvedModel: resolvedFor(model),
    transcript: store,
  });

  // The turn completes instead of the provider rejecting the orphan.
  assert.equal(finishOf(events).stopReason, "end");
  // No tool-role message reached the wire.
  assert.ok(!model.doStreamCalls[0].prompt.some((m) => m.role === "tool"));
  assert.ok(!JSON.stringify(model.doStreamCalls[0].prompt).includes("stale-1"));
  store.close();
});
