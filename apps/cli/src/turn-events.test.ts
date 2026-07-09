// The StreamMessage → TurnEvent cutover mapping, tested against scripted
// event streams (the runtime is mocked as a plain async generator — the same
// seam runtime.ts exposes as runTurnImpl). Every sink call is recorded so each
// mapping rule is asserted end to end without Ink or React.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PARALLEL_TOOL_ID, REMEMBER_TOOL_ID } from "@hemiunu/agent-core";
import { emptyUsage, type TurnEvent, type TurnUsage } from "@hemiunu/engine";
import type { ActivityEvent } from "@hemiunu/format";
import type { Item } from "./types";
import { createTurnRenderer, type TurnFinish, type TurnSinks } from "./turn-events";

// --- harness -----------------------------------------------------------------

interface Recorded {
  items: Item[];
  text: string[];
  thinking: string[];
  flushes: number;
  activity: ActivityEvent[];
  groupFlushes: number;
  folds: string[];
  statuses: string[];
  conversations: string[];
  plans: string[];
  steps: TurnUsage[];
  finishes: TurnFinish[];
}

function recorder(): { sinks: TurnSinks; rec: Recorded } {
  const rec: Recorded = {
    items: [],
    text: [],
    thinking: [],
    flushes: 0,
    activity: [],
    groupFlushes: 0,
    folds: [],
    statuses: [],
    conversations: [],
    plans: [],
    steps: [],
    finishes: [],
  };
  const sinks: TurnSinks = {
    push: (i) => rec.items.push(i),
    appendText: (t) => rec.text.push(t),
    appendThinking: (t) => rec.thinking.push(t),
    flushText: () => rec.flushes++,
    feedActivity: (e) => rec.activity.push(e),
    flushGroup: () => rec.groupFlushes++,
    foldResult: (s) => rec.folds.push(s),
    setStatus: (s) => rec.statuses.push(s),
    onConversation: (id) => rec.conversations.push(id),
    onPlan: (p) => rec.plans.push(p),
    onStep: (u) => rec.steps.push(u),
    onFinish: (f) => rec.finishes.push(f),
  };
  return { sinks, rec };
}

/** Drive the renderer exactly the way the App does: iterate a (mock) runtime
 *  stream — the injected-async-generator seam — and handle each event. */
async function render(events: TurnEvent[]): Promise<Recorded> {
  async function* stream(): AsyncGenerator<TurnEvent> {
    for (const e of events) yield e;
  }
  const { sinks, rec } = recorder();
  const renderer = createTurnRenderer(sinks);
  for await (const e of stream()) renderer.handle(e);
  return rec;
}

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({ ...emptyUsage(), ...over });

const finish = (over: Partial<Extract<TurnEvent, { type: "turn-finish" }>> = {}): TurnEvent => ({
  type: "turn-finish",
  text: "done",
  usage: usage({ steps: 1 }),
  costUsd: 0,
  stopReason: "end",
  ...over,
});

// --- text / reasoning streaming ------------------------------------------------

test("turn-start carries the conversation id and text-deltas stream incrementally", async () => {
  const rec = await render([
    { type: "turn-start", conversationId: "conv-1", model: "claude-opus-4.8" },
    { type: "text-delta", text: "Hel" },
    { type: "text-delta", text: "lo" },
    finish({ text: "Hello", costUsd: 0.12 }),
  ]);
  assert.deepEqual(rec.conversations, ["conv-1"]);
  assert.deepEqual(rec.text, ["Hel", "lo"]); // token streaming, chunk by chunk
  assert.equal(rec.finishes.length, 1);
  assert.equal(rec.finishes[0].costUsd, 0.12); // cost comes from the engine
  assert.equal(rec.finishes[0].stopReason, "end");
});

test("reasoning-deltas stream to the thinking sink and never to the answer", async () => {
  const rec = await render([
    { type: "reasoning-delta", text: "hmm " },
    { type: "reasoning-delta", text: "let me check" },
    { type: "text-delta", text: "Answer." },
    finish(),
  ]);
  assert.deepEqual(rec.thinking, ["hmm ", "let me check"]);
  assert.deepEqual(rec.text, ["Answer."]);
});

// --- tools & activity groups ----------------------------------------------------

test("a top-level tool-start flushes live prose and opens a tool activity group", async () => {
  const rec = await render([
    { type: "text-delta", text: "Looking…" },
    { type: "tool-start", id: "t1", name: "web_fetch", input: { url: "https://x.test" } },
    {
      type: "tool-result",
      id: "t1",
      name: "web_fetch",
      output: { content: "# A perfectly clean page title" },
    },
    finish(),
  ]);
  assert.equal(rec.flushes, 1, "prose is committed before the tool line");
  const tool = rec.activity.find((e) => e.type === "tool");
  assert.ok(tool && tool.type === "tool");
  assert.equal(tool.label, "web_fetch");
  assert.ok(rec.statuses.includes("running"));
  assert.ok(rec.statuses.includes("thinking"), "results return the status to thinking");
});

test("raw/noisy tool results are dropped; clean summaries fold into the group", async () => {
  const rec = await render([
    { type: "tool-start", id: "t1", name: "some_tool", input: {} },
    {
      type: "tool-result",
      id: "t1",
      name: "some_tool",
      output: { content: "raw: prose\nthat: is not a clean summary" },
    },
    { type: "tool-start", id: "t2", name: "some_tool", input: {} },
    {
      type: "tool-result",
      id: "t2",
      name: "some_tool",
      output: { content: JSON.stringify({ results: [1, 2, 3] }) },
    },
    finish(),
  ]);
  assert.deepEqual(rec.folds, ["3 results"]);
});

test("error tool results never fold into the activity stream", async () => {
  const rec = await render([
    { type: "tool-start", id: "t1", name: "some_tool", input: {} },
    {
      type: "tool-result",
      id: "t1",
      name: "some_tool",
      output: { content: "boom", isError: true },
    },
    finish(),
  ]);
  assert.deepEqual(rec.folds, []);
  assert.deepEqual(
    rec.items.filter((i) => i.kind === "error"),
    [],
    "ordinary tool failures are the model's to handle, not scrollback noise",
  );
});

// --- delegation (delegate / parallel / parent-stamped events) --------------------

test("a delegate run maps to a delegation group, sub narration, and an answer block", async () => {
  const rec = await render([
    {
      type: "tool-start",
      id: "d1",
      name: "delegate",
      input: { agent: "researcher", prompt: "find X" },
    },
    { type: "task-start", id: "d1", agent: "researcher", label: "find X" },
    { type: "text-delta", text: "Searching the sources…", parent: "d1" },
    { type: "tool-start", id: "s1", name: "mcp__notion__search", input: { q: "X" }, parent: "d1" },
    {
      type: "tool-result",
      id: "s1",
      name: "mcp__notion__search",
      output: { content: "hit" },
      parent: "d1",
    },
    { type: "task-done", id: "d1", agent: "researcher", label: "find X", ok: true },
    { type: "tool-result", id: "d1", name: "delegate", output: { content: "The answer is 42." } },
    finish(),
  ]);

  // The delegation opens once (tool-start), task-start of the SAME id doesn't re-feed.
  const delegatesFed = rec.activity.filter((e) => e.type === "delegate");
  assert.equal(delegatesFed.length, 1);
  assert.deepEqual(delegatesFed[0], { type: "delegate", agent: "researcher", label: "Researcher" });

  // The subagent's buffered narration lands as one indented sub line.
  const sub = rec.items.find((i) => i.kind === "text" && i.sub);
  assert.ok(sub && sub.kind === "text");
  assert.equal(sub.text, "Searching the sources…");

  // Its nested tool folds in as a subtool with the task's label.
  const subtool = rec.activity.find((e) => e.type === "subtool");
  assert.ok(subtool && subtool.type === "subtool");
  assert.equal(subtool.taskLabel, "find X");

  // task-done → subdone; the delegate's result prints as the full answer.
  assert.ok(rec.activity.some((e) => e.type === "subdone" && e.ok));
  const answer = rec.items.find((i) => i.kind === "answer");
  assert.ok(answer && answer.kind === "answer");
  assert.equal(answer.agent, "researcher");
  assert.equal(answer.text, "The answer is 42.");
  assert.ok(rec.groupFlushes >= 1, "the group commits above the answer");
  assert.ok(rec.statuses.includes("researching"));
});

test("a failed delegation surfaces as an error line, not an answer", async () => {
  const rec = await render([
    { type: "tool-start", id: "d1", name: "delegate", input: { agent: "researcher" } },
    {
      type: "tool-result",
      id: "d1",
      name: "delegate",
      output: { content: "Subagent 'researcher' failed: boom", isError: true },
    },
    finish(),
  ]);
  assert.ok(!rec.items.some((i) => i.kind === "answer"));
  const err = rec.items.find((i) => i.kind === "error");
  assert.ok(err && err.kind === "error");
  assert.match(err.text, /failed: boom/);
});

test("parallel fan-out: subtask task-starts join the one delegation group", async () => {
  const rec = await render([
    { type: "tool-start", id: "p1", name: PARALLEL_TOOL_ID, input: { tasks: [] } },
    { type: "task-start", id: "task-a", agent: "designer", label: "Header" },
    { type: "task-start", id: "task-b", agent: "designer", label: "Footer" },
    {
      type: "tool-start",
      id: "s1",
      name: "write_file",
      input: {},
      parent: "task-a",
    },
    { type: "task-done", id: "task-a", agent: "designer", label: "Header", ok: true },
    { type: "task-done", id: "task-b", agent: "designer", label: "Footer", ok: false },
    { type: "tool-result", id: "p1", name: PARALLEL_TOOL_ID, output: { content: "2 tasks ran" } },
    finish(),
  ]);
  const delegatesFed = rec.activity.filter((e) => e.type === "delegate");
  assert.equal(delegatesFed[0]?.agent, "parallel");
  // Both subtask starts feed the SAME "Working in parallel" delegation label.
  assert.ok(delegatesFed.slice(1).every((d) => d.label === "Working in parallel"));
  const subtool = rec.activity.find((e) => e.type === "subtool");
  assert.ok(subtool && subtool.type === "subtool");
  assert.equal(subtool.taskLabel, "Header", "nested events resolve their subtask by parent id");
  const dones = rec.activity.filter((e) => e.type === "subdone");
  assert.deepEqual(
    dones.map((d) => d.type === "subdone" && d.ok),
    [true, false],
  );
  const answer = rec.items.find((i) => i.kind === "answer");
  assert.ok(answer && answer.kind === "answer");
  assert.equal(answer.agent, "parallel");
});

// --- todo / plan / compaction / permission notes ---------------------------------

test("todo snapshots render as the ◷ plan progress note", async () => {
  const rec = await render([
    {
      type: "todo",
      todos: [
        { text: "Set up the page", status: "completed" },
        { text: "Build the header", status: "in_progress" },
        { text: "Wire the form", status: "pending" },
      ],
    },
    finish(),
  ]);
  const note = rec.items.find((i) => i.kind === "note");
  assert.ok(note && note.kind === "note");
  assert.equal(note.text, "◷ plan · 1/3 — Build the header");
});

test("plan-proposed reaches the plan sink; permission-notes stay silent", async () => {
  const rec = await render([
    { type: "permission-note", id: "t1", name: "web_fetch", decision: "auto" },
    { type: "permission-note", id: "t2", name: "save_prototype", decision: "user" },
    { type: "plan-proposed", plan: "1. do it" },
    finish(),
  ]);
  assert.deepEqual(rec.plans, ["1. do it"]);
  assert.deepEqual(rec.items, [], "permission notes add no scrollback lines");
});

test("compaction and error events land in scrollback; step-finish feeds usage", async () => {
  const step = usage({ inputTokens: 900, cacheReadTokens: 100, outputTokens: 50, steps: 1 });
  const rec = await render([
    { type: "compaction", summary: "folded" },
    { type: "step-finish", usage: step },
    { type: "error", message: "rate limited" },
    finish({ stopReason: "error" }),
  ]);
  assert.ok(rec.items.some((i) => i.kind === "note" && /compacted/.test(i.text)));
  assert.deepEqual(rec.steps, [step]);
  const err = rec.items.find((i) => i.kind === "error");
  assert.ok(err && err.kind === "error");
  assert.equal(err.text, "rate limited");
  assert.equal(rec.finishes[0].stopReason, "error");
});

// --- auto-approved narrating tools ------------------------------------------------

test("remember narrates from tool-start (the gate no longer sees auto tools)", async () => {
  const rec = await render([
    {
      type: "tool-start",
      id: "t1",
      name: REMEMBER_TOOL_ID,
      input: { note: "prefers dark mode" },
    },
    finish(),
  ]);
  const note = rec.items.find((i) => i.kind === "note");
  assert.ok(note && note.kind === "note");
  assert.equal(note.text, "✎ remembered: prefers dark mode");
});
