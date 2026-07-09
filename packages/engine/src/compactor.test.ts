import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { TurnEvent, TurnUsage } from "./events";
import { emptyUsage } from "./events";
import type { ModelEntry, ResolvedModel } from "./models";
import type { HemiTool } from "./tool";
import { TranscriptStore, type TranscriptMessage } from "./transcript";
import { runTurn } from "./loop";
import {
  COMPACT_PROMPT,
  Compactor,
  TRUNCATION_NOTE,
  compactAt,
  estimateContextTokens,
  estimateToolTokens,
  summaryNote,
} from "./compactor";

// --- fixtures -------------------------------------------------------------

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 100, noCache: 85, cacheRead: 10, cacheWrite: 5 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function generateResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

function textStream(text: string) {
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

function toolCallStream(name: string, input: unknown, callId = "call-1") {
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

/** Usage whose input-side tokens (input + cacheRead + cacheWrite) sum to n. */
function ctxUsage(n: number): TurnUsage {
  return { ...emptyUsage(), inputTokens: n, steps: 1 };
}

const user = (text: string): TranscriptMessage => ({ role: "user", content: text });
const assistant = (text: string): TranscriptMessage => ({ role: "assistant", content: text });

const echoTool: HemiTool<{ value: string }> = {
  name: "echo",
  description: "Echo the value back.",
  inputSchema: z.object({ value: z.string() }),
  readOnly: true,
  async execute(input) {
    return { content: `echo:${input.value}` };
  },
};

// --- threshold math (ported from the old CLI's format.test.ts) -------------

test("compactAt clamps to [0.1, 0.95] and defaults to 0.5", () => {
  assert.equal(compactAt(undefined), 0.5);
  assert.equal(compactAt("0.7"), 0.7);
  assert.equal(compactAt("0.01"), 0.1); // clamped up
  assert.equal(compactAt("2"), 0.95); // clamped down
});

test("compactAt never yields NaN — a bad value must not disable compaction", () => {
  assert.equal(compactAt("banana"), 0.5);
  assert.ok(Number.isFinite(compactAt("")));
});

test("thresholdTokens = contextWindow × threshold; default threshold reads the env", () => {
  const store = new TranscriptStore(":memory:");
  const explicit = new Compactor({ transcript: store, threshold: 0.5 });
  assert.equal(explicit.thresholdTokens(entryFor({ contextWindow: 200_000 })), 100_000);

  const saved = process.env.HEMIUNU_COMPACT_THRESHOLD;
  try {
    process.env.HEMIUNU_COMPACT_THRESHOLD = "0.8";
    assert.equal(new Compactor({ transcript: store }).threshold, 0.8);
    delete process.env.HEMIUNU_COMPACT_THRESHOLD;
    assert.equal(new Compactor({ transcript: store }).threshold, 0.5);
  } finally {
    if (saved === undefined) delete process.env.HEMIUNU_COMPACT_THRESHOLD;
    else process.env.HEMIUNU_COMPACT_THRESHOLD = saved;
  }
  store.close();
});

// --- the check hook ---------------------------------------------------------

test("check: below the threshold nothing happens — no model call, no rows", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("unused")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c1", [user("hi"), assistant("hello")]);
  const messages = store.load("c1").messages;

  const outcome = await compactor.check({
    conversationId: "c1",
    messages,
    entry: entryFor({ contextWindow: 100_000 }),
    usage: ctxUsage(49_999),
  });

  assert.equal(outcome, undefined);
  assert.equal(summarizer.doGenerateCalls.length, 0);
  assert.equal(store.load("c1").summary, undefined);
  assert.equal(messages.length, 2); // untouched
  store.close();
});

test("check: crossing the threshold summarizes with COMPACT_PROMPT, supersedes, folds in place", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({
    doGenerate: [generateResult("- Goal: greet the assistant.")],
  });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c1", [user("hi"), assistant("hello"), user("tell me more")]);
  const messages = store.load("c1").messages;

  const outcome = await compactor.check({
    conversationId: "c1",
    messages,
    entry: entryFor({ contextWindow: 100_000 }),
    usage: ctxUsage(50_000), // exactly the threshold — >= fires
  });

  assert.deepEqual(outcome, { summary: "- Goal: greet the assistant." });

  // The summarizer saw the live history followed by COMPACT_PROMPT verbatim.
  const wire = summarizer.doGenerateCalls[0].prompt;
  const wireText = JSON.stringify(wire);
  assert.ok(wireText.includes("tell me more"));
  const last = wire.at(-1)!;
  assert.equal(last.role, "user");
  assert.deepEqual(last.content, [{ type: "text", text: COMPACT_PROMPT }]);

  // Durable state: one compaction row; every old row superseded (kept, hidden).
  const loaded = store.load("c1");
  assert.equal(loaded.summary, "- Goal: greet the assistant.");
  assert.deepEqual(loaded.messages, []);

  // The live window was folded in place to a single summary user message.
  assert.deepEqual(messages, [user(summaryNote("- Goal: greet the assistant."))]);
  store.close();
});

test("check: an earlier summary is handed to the summarizer to fold in", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("newer summary")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c1", [user("old"), assistant("old reply")]);
  store.recordCompaction("c1", "earlier summary", 2);
  store.append("c1", [user("newer question")]);
  const messages = store.load("c1").messages;

  await compactor.check({
    conversationId: "c1",
    messages,
    entry: entryFor({ contextWindow: 100 }),
    usage: ctxUsage(100),
  });

  const wire = summarizer.doGenerateCalls[0].prompt;
  assert.equal(wire[0].role, "system");
  assert.equal(wire[0].content, summaryNote("earlier summary"));
  assert.equal(store.load("c1").summary, "newer summary");
  store.close();
});

test("check: a summarizer failure is swallowed — context is left as-is", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({
    doGenerate: () => {
      throw new Error("provider down");
    },
  });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c1", [user("hi")]);
  const messages = store.load("c1").messages;

  const outcome = await compactor.check({
    conversationId: "c1",
    messages,
    entry: entryFor({ contextWindow: 100 }),
    usage: ctxUsage(100),
  });

  assert.equal(outcome, undefined);
  assert.deepEqual(messages, [user("hi")]); // not folded
  assert.equal(store.load("c1").summary, undefined); // nothing recorded
  store.close();
});

test("check: an empty summary is not recorded", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("   ")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c1", [user("hi")]);
  const messages = store.load("c1").messages;

  const outcome = await compactor.check({
    conversationId: "c1",
    messages,
    entry: entryFor({ contextWindow: 100 }),
    usage: ctxUsage(100),
  });

  assert.equal(outcome, undefined);
  assert.equal(store.load("c1").summary, undefined);
  store.close();
});

// --- manual entry point (/compact) -----------------------------------------

test("compactNow: summarizes the store's live messages and records the compaction", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("manual summary")] });
  const compactor = new Compactor({ transcript: store, resolvedModel: resolvedFor(summarizer) });
  store.append("c1", [user("q"), assistant("a")]);

  const summary = await compactor.compactNow("c1");

  assert.equal(summary, "manual summary");
  const loaded = store.load("c1");
  assert.equal(loaded.summary, "manual summary");
  assert.deepEqual(loaded.messages, []); // all rows superseded, none deleted
  assert.equal(store.nextSeq("c1"), 3); // rows still occupy their seqs
  store.close();
});

test("compactNow: throws when the conversation has nothing live to compact", async () => {
  const store = new TranscriptStore(":memory:");
  const compactor = new Compactor({
    transcript: store,
    resolvedModel: resolvedFor(new MockLanguageModelV4()),
  });
  await assert.rejects(() => compactor.compactNow("ghost"), /Nothing to compact/);
  store.close();
});

// --- wired into the loop -----------------------------------------------------

test("auto-compaction mid-turn: compaction event emitted, next step starts from the summary", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({
    doGenerate: [generateResult("- Goal: echo things.")],
  });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer, { id: "summarizer" }),
  });

  // Step 1 consumes 115 input-side tokens (100 + 10 + 5); the turn's model has
  // a 200-token window, so 115 >= 200 × 0.5 fires the check before step 2.
  const main = new MockLanguageModelV4({
    doStream: [toolCallStream("echo", { value: "hi" }), textStream("done")],
  });
  const events: TurnEvent[] = [];
  for await (const e of runTurn({
    prompt: "go",
    resume: "conv-auto",
    resolvedModel: resolvedFor(main, { contextWindow: 200 }),
    tools: [echoTool],
    transcript: store,
    compactionCheck: compactor.check,
  })) {
    events.push(e);
  }

  assert.deepEqual(
    events.map((e) => e.type),
    [
      "turn-start",
      "tool-start",
      "step-finish",
      "tool-result",
      "compaction",
      "text-delta",
      "step-finish",
      "turn-finish",
    ],
  );
  const compaction = events[4] as Extract<TurnEvent, { type: "compaction" }>;
  assert.equal(compaction.summary, "- Goal: echo things.");

  // Step 2 runs on the folded window: the summary, not the original history.
  const secondPrompt = JSON.stringify(main.doStreamCalls[1].prompt);
  assert.ok(secondPrompt.includes("- Goal: echo things."));
  assert.ok(!secondPrompt.includes("echo:hi"));

  // Durably: pre-compaction rows superseded; step-2 output lands after it.
  const loaded = store.load("conv-auto");
  assert.equal(loaded.summary, "- Goal: echo things.");
  assert.deepEqual(
    loaded.messages.map((m) => m.role),
    ["assistant"], // just step 2's text
  );
  store.close();
});

// --- resume assembly ----------------------------------------------------------

test("resume after compaction: summary rides in the system prompt, only tail messages replay — even on another model", async () => {
  const store = new TranscriptStore(":memory:");
  store.append("conv-r", [user("old question"), assistant("old answer")]);
  store.recordCompaction("conv-r", "user asked about pyramids", 2);
  store.append("conv-r", [user("mid question"), assistant("mid answer")]);

  // Resume on a DIFFERENT provider/model than the one that wrote the history —
  // the transcript is plain ModelMessages, so it replays as-is.
  const model = new MockLanguageModelV4({ doStream: [textStream("resumed")] });
  const events: TurnEvent[] = [];
  for await (const e of runTurn({
    prompt: "new question",
    resume: "conv-r",
    systemPrompt: "You are Hemiunu.",
    resolvedModel: resolvedFor(model, { id: "other-model", provider: "anthropic" }),
    transcript: store,
  })) {
    events.push(e);
  }

  assert.equal(
    (events[0] as Extract<TurnEvent, { type: "turn-start" }>).conversationId,
    "conv-r", // session_id is Hemiunu's own conversation id
  );

  const wire = model.doStreamCalls[0].prompt;
  assert.equal(wire[0].role, "system");
  assert.ok(String(wire[0].content).includes("You are Hemiunu."));
  assert.ok(String(wire[0].content).includes("Summary of the conversation so far:"));
  assert.ok(String(wire[0].content).includes("user asked about pyramids"));

  const wireText = JSON.stringify(wire);
  assert.ok(wireText.includes("mid question"));
  assert.ok(wireText.includes("mid answer"));
  assert.ok(wireText.includes("new question"));
  assert.ok(!wireText.includes("old question")); // superseded rows stay out
  store.close();
});

// --- pre-first-call estimation (the ContextWindowExceeded fix) --------------
// The transcript is provider-neutral, so a history built under a big-window
// model can be resumed / switched onto a smaller-window one. Before the first
// provider call usage is all zeros — the check must estimate the loaded
// context against the CURRENT entry's window and compact first, instead of
// shipping a request the provider rejects.

test("check: zero usage + oversized carried history → pre-compaction before any provider call", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("- Goal: carry on.")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  // ~1.5k estimated tokens of history, "built" under a huge-window model…
  store.append("c-pre", [user("x".repeat(2000)), assistant("x".repeat(2000)), user("continue")]);
  const messages = store.load("c-pre").messages;

  // …then checked under a small-window entry, with NO usage yet (turn start).
  const outcome = await compactor.check({
    conversationId: "c-pre",
    messages,
    entry: entryFor({ contextWindow: 1000 }),
    usage: emptyUsage(),
  });

  assert.deepEqual(outcome, { summary: "- Goal: carry on." });
  assert.deepEqual(messages, [user(summaryNote("- Goal: carry on."))]);
  assert.equal(store.load("c-pre").summary, "- Goal: carry on.");
  store.close();
});

test("check: zero usage + already-small history → no pre-compaction", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("unused")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c-small", [user("hi"), assistant("hello")]);
  const messages = store.load("c-small").messages;

  const outcome = await compactor.check({
    conversationId: "c-small",
    messages,
    entry: entryFor({ contextWindow: 1000 }),
    usage: emptyUsage(),
  });

  assert.equal(outcome, undefined);
  assert.equal(summarizer.doGenerateCalls.length, 0);
  assert.equal(messages.length, 2); // untouched
  store.close();
});

test("check: a fresh estimate over the threshold wins over a small STALE reported usage — the mid-turn re-check", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("- Goal: folded.")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  // Reported usage is from the LAST step (small: 10 tokens). A big tool result
  // was appended AFTER that step — the chars/4 estimate of the live window is
  // now WAY over the threshold. The estimate must win so the next provider
  // call compacts instead of overflowing (the deepseek-v3 172k bug).
  store.append("c-auth", [user("x".repeat(8000))]);
  const messages = store.load("c-auth").messages;

  const outcome = await compactor.check({
    conversationId: "c-auth",
    messages,
    entry: entryFor({ contextWindow: 1000 }),
    usage: ctxUsage(10),
  });

  assert.deepEqual(outcome, { summary: "- Goal: folded." });
  assert.equal(summarizer.doGenerateCalls.length, 1);
  store.close();
});

test("check: the system prompt counts toward the pre-call estimate", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("- Goal: fold.")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  // History alone is under the 500-token threshold; history + a fat system
  // prompt is over it.
  store.append("c-sys", [user("x".repeat(1200))]);
  const messages = store.load("c-sys").messages;

  const outcome = await compactor.check({
    conversationId: "c-sys",
    messages,
    entry: entryFor({ contextWindow: 1000 }),
    usage: emptyUsage(),
    system: "s".repeat(1200),
  });

  assert.deepEqual(outcome, { summary: "- Goal: fold." });
  store.close();
});

// --- tool-schema overhead in the estimate (the deepseek-v3 schema-blind bug) --
// ~58 tool schemas ride on EVERY request; a message-only estimate that ignores
// them under-counts the wire and ships a request the provider rejects.

test("estimateToolTokens: zero for none, counts name+description+schema, grows with the set", () => {
  assert.equal(estimateToolTokens([]), 0);
  const one = estimateToolTokens([echoTool]);
  assert.ok(one > 0);
  // An MCP tool carries raw JSON Schema (counted verbatim).
  const mcp: HemiTool = {
    name: "mcp__notion__search",
    description: "Search the connected Notion workspace for pages and databases.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: { query: { type: "string", description: "the search query" } },
        required: ["query"],
      },
    },
    async execute() {
      return { content: "" };
    },
  };
  const two = estimateToolTokens([echoTool, mcp]);
  assert.ok(two > one, "adding a tool raises the estimate");
});

test("check: the outgoing tool schemas count toward the estimate (a big tool set crosses the threshold that message-only would miss)", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("- Goal: tools.")] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  // Messages alone are well under the 500-token threshold…
  store.append("c-tools", [user("hi")]);
  const messages = store.load("c-tools").messages;
  const entry = entryFor({ contextWindow: 1000 });

  // …a fat tool set (long descriptions) pushes the wire over it.
  const fatTools: HemiTool[] = Array.from({ length: 30 }, (_, i) => ({
    name: `tool_number_${i}`,
    description: "A tool with a deliberately long description. ".repeat(6),
    inputSchema: z.object({ field: z.string().describe("a parameter with its own description") }),
    async execute() {
      return { content: "" };
    },
  }));

  // Message-only (no tools) → nothing fires.
  const none = await compactor.check({
    conversationId: "c-tools",
    messages,
    entry,
    usage: emptyUsage(),
  });
  assert.equal(none, undefined);
  assert.equal(summarizer.doGenerateCalls.length, 0);

  // Same history, but now the tool schemas are counted → compaction fires.
  const outcome = await compactor.check({
    conversationId: "c-tools",
    messages,
    entry,
    usage: emptyUsage(),
    tools: fatTools,
  });
  assert.deepEqual(outcome, { summary: "- Goal: tools." });
  store.close();
});

test("check: doomed even after compaction — the folded window is truncated behind the note", async () => {
  const store = new TranscriptStore(":memory:");
  // The summary itself is far bigger than the tiny window.
  const summarizer = new MockLanguageModelV4({ doGenerate: [generateResult("y".repeat(8000))] });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c-doom", [user("x".repeat(4000)), user("newest question")]);
  const messages = store.load("c-doom").messages;

  const entry = entryFor({ contextWindow: 400 });
  const outcome = await compactor.check({
    conversationId: "c-doom",
    messages,
    entry,
    usage: emptyUsage(),
  });

  // Compaction DID happen (recorded durably)…
  assert.deepEqual(outcome, { summary: "y".repeat(8000) });
  assert.equal(store.load("c-doom").summary, "y".repeat(8000));
  // …but the live window was truncated so the outgoing request can fit:
  // the note first, then whatever tail head fits the threshold budget.
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, TRUNCATION_NOTE);
  assert.ok(estimateContextTokens(messages) < entry.contextWindow);
  store.close();
});

test("check: compaction failure + request that cannot fit the window → truncated tail, not a doomed request", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({
    doGenerate: () => {
      throw new Error("summarizer down");
    },
  });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  store.append("c-fail", [user("x".repeat(2000)), user("y".repeat(2000)), user("z".repeat(400))]);
  const messages = store.load("c-fail").messages;

  const entry = entryFor({ contextWindow: 200 });
  const outcome = await compactor.check({
    conversationId: "c-fail",
    messages,
    entry,
    usage: emptyUsage(),
  });

  assert.equal(outcome, undefined); // nothing summarized
  assert.equal(store.load("c-fail").summary, undefined);
  assert.equal(messages[0].content, TRUNCATION_NOTE);
  assert.ok(estimateContextTokens(messages) < entry.contextWindow);
  store.close();
});

test("check: compaction failure with a merely-large (not doomed) history stays untouched — retries next step", async () => {
  const store = new TranscriptStore(":memory:");
  const summarizer = new MockLanguageModelV4({
    doGenerate: () => {
      throw new Error("summarizer down");
    },
  });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer),
  });
  // Over the 50% threshold but comfortably under the window itself.
  store.append("c-retry", [user("x".repeat(2400))]);
  const messages = store.load("c-retry").messages;

  const outcome = await compactor.check({
    conversationId: "c-retry",
    messages,
    entry: entryFor({ contextWindow: 2000 }),
    usage: emptyUsage(),
  });

  assert.equal(outcome, undefined);
  assert.equal(messages.length, 1); // NOT truncated — the request still fits
  assert.equal(messages[0].content, "x".repeat(2400));
  store.close();
});

// --- the exact production shape: 1M-window history continued on a 262,144 one

test("model switch: a transcript built under a 1M-window entry pre-compacts before the first call on a 262,144-window entry, and the outgoing estimate fits", async () => {
  const store = new TranscriptStore(":memory:");
  // A long conversation legally built under a 1M-window model (~150k tokens).
  const big = "x".repeat(300_000);
  store.append("conv-switch", [user(big), assistant(big)]);

  // Sanity: under the ORIGINAL 1M entry the same history triggers nothing.
  const idleSummarizer = new MockLanguageModelV4({ doGenerate: [generateResult("unused")] });
  const idle = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(idleSummarizer),
  });
  const none = await idle.check({
    conversationId: "conv-switch",
    messages: store.load("conv-switch").messages,
    entry: entryFor({ id: "claude-1m", contextWindow: 1_000_000 }),
    usage: emptyUsage(),
  });
  assert.equal(none, undefined);
  assert.equal(idleSummarizer.doGenerateCalls.length, 0);

  // The user switches to a qwen3-235b-shaped entry (262,144) and continues.
  const summarizer = new MockLanguageModelV4({
    doGenerate: [generateResult("- Goal: the long saga, condensed.")],
  });
  const compactor = new Compactor({
    transcript: store,
    threshold: 0.5,
    resolvedModel: resolvedFor(summarizer, { id: "summarizer" }),
  });
  const qwen = new MockLanguageModelV4({ doStream: [textStream("continuing")] });
  const events: TurnEvent[] = [];
  for await (const e of runTurn({
    prompt: "continue where we left off",
    resume: "conv-switch",
    resolvedModel: resolvedFor(qwen, { id: "qwen3-235b-instruct", contextWindow: 262_144 }),
    transcript: store,
    compactionCheck: compactor.check,
  })) {
    events.push(e);
  }

  // Compaction fired BEFORE the first provider call of the turn.
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn-start", "compaction", "text-delta", "step-finish", "turn-finish"],
  );

  // The request that actually went out fits the NEW model's window by the
  // engine's own estimate — and the giant history is gone from the wire.
  const wire = JSON.stringify(qwen.doStreamCalls[0].prompt);
  assert.ok(Math.ceil(wire.length / 4) < 262_144);
  assert.ok(!wire.includes("xxxxxxxxxx"));
  assert.ok(wire.includes("- Goal: the long saga, condensed."));
  store.close();
});
