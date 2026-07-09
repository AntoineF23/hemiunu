// The TurnEvent → ServerEvent mapping (turn-events.ts) — the web cutover's SSE
// heart. Each test injects a mock async generator of engine TurnEvents (exactly
// how turn.ts consumes runtime.runTurn) and asserts the wire events out.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnEvent } from "@hemiunu/engine";
import { ASK_USER_TOOL_ID, PARALLEL_TOOL_ID, REMEMBER_TOOL_ID } from "@hemiunu/agent-core";
import type { ServerEvent } from "../shared/protocol";
import { createTurnMapper, type TurnMapper } from "./turn-events";

/** A mock engine turn: an async generator over scripted TurnEvents. */
async function* turnOf(events: TurnEvent[]): AsyncGenerator<TurnEvent> {
  for (const e of events) yield e;
}

/** Drive the mapper the way turn.ts does and collect the wire events. */
async function mapped(
  events: TurnEvent[],
  mapper: TurnMapper = createTurnMapper(),
): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  for await (const e of turnOf(events)) out.push(...mapper.map(e));
  return out;
}

const usage = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 4000,
  cacheWriteTokens: 50,
  steps: 3,
};

test("turn-start becomes the session event (conversation id = resume token)", async () => {
  const mapper = createTurnMapper();
  const out = await mapped([{ type: "turn-start", conversationId: "c-1", model: "m" }], mapper);
  assert.deepEqual(out, [{ type: "session", sessionId: "c-1" }]);
  assert.equal(mapper.conversationId, "c-1");
});

test("text-delta streams token-level text and accumulates fullText", async () => {
  const mapper = createTurnMapper();
  const out = await mapped(
    [
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
    ],
    mapper,
  );
  assert.deepEqual(out, [
    { type: "text", delta: "Hel" },
    { type: "text", delta: "lo" },
  ]);
  assert.equal(mapper.fullText, "Hello");
});

test("reasoning deltas and permission notes stay internal", async () => {
  const out = await mapped([
    { type: "reasoning-delta", text: "thinking…" },
    { type: "permission-note", id: "t1", name: "web_fetch", decision: "user" },
  ]);
  assert.deepEqual(out, []);
});

test("tool-start/tool-result map to tool + result events", async () => {
  const out = await mapped([
    { type: "tool-start", id: "t1", name: "web_search", input: { query: "pyramids" } },
    {
      type: "tool-result",
      id: "t1",
      name: "web_search",
      output: { content: JSON.stringify({ results: [1, 2, 3] }) },
    },
  ]);
  assert.deepEqual(out, [
    { type: "tool", name: "web_search", preview: "“pyramids”" },
    { type: "result", text: "3 results" },
  ]);
});

test("raw/oversized/error tool results never leak into the feed", async () => {
  const out = await mapped([
    { type: "tool-result", id: "a", name: "x", output: { content: "raw YAML dump: - a\n- b" } },
    { type: "tool-result", id: "b", name: "x", output: { content: "boom", isError: true } },
  ]);
  assert.deepEqual(out, []);
});

test("delegate flows: tool-start opens a delegation, its result is the answer", async () => {
  const out = await mapped([
    {
      type: "tool-start",
      id: "d1",
      name: "delegate",
      input: { agent: "researcher", prompt: "Find X", label: "Find X" },
    },
    { type: "task-start", id: "d1", agent: "researcher", label: "Find X" },
    { type: "tool-start", id: "n1", name: "web_search", input: { query: "x" }, parent: "d1" },
    { type: "task-done", id: "d1", agent: "researcher", label: "Find X", ok: true },
    { type: "tool-result", id: "d1", name: "delegate", output: { content: "The full report." } },
  ]);
  assert.deepEqual(out, [
    { type: "tool", name: "researcher", preview: "Find X", delegate: true },
    { type: "subagent", label: "Find X", detail: "researcher · running", sub: true },
    { type: "subagent", label: "Find X", detail: "web_search", sub: true },
    { type: "subagent", label: "Find X", detail: "done", sub: true },
    { type: "answer", agent: "researcher", text: "The full report." },
  ]);
});

test("parallel summarizes its tasks and routes the combined result as answer", async () => {
  const out = await mapped([
    {
      type: "tool-start",
      id: "p1",
      name: PARALLEL_TOOL_ID,
      input: {
        tasks: [
          { agent: "researcher", prompt: "a", label: "A" },
          { agent: "designer", prompt: "b" },
        ],
      },
    },
    { type: "tool-result", id: "p1", name: PARALLEL_TOOL_ID, output: { content: "A: …\nB: …" } },
  ]);
  assert.deepEqual(out, [
    { type: "tool", name: "parallel", preview: "2 tasks · A, designer", delegate: true },
    { type: "answer", agent: "parallel", text: "A: …\nB: …" },
  ]);
});

test("subagent text deltas are buffered into whole narration lines", async () => {
  const out = await mapped([
    { type: "task-start", id: "s1", agent: "prototyper", label: "Build" },
    { type: "text-delta", text: "Building the ", parent: "s1" },
    { type: "text-delta", text: "Header\nNow the Foo", parent: "s1" },
    { type: "task-done", id: "s1", agent: "prototyper", label: "Build", ok: false },
  ]);
  assert.deepEqual(out, [
    { type: "subagent", label: "Build", detail: "prototyper · running", sub: true },
    { type: "subagent", label: "", detail: "Building the Header", sub: true },
    { type: "subagent", label: "", detail: "Now the Foo", sub: true },
    { type: "subagent", label: "Build", detail: "failed", sub: true },
  ]);
});

test("ask_user, todo_write and exit_plan_mode calls show no redundant tool line", async () => {
  const out = await mapped([
    { type: "tool-start", id: "a1", name: ASK_USER_TOOL_ID, input: { question: "?" } },
    { type: "tool-start", id: "a2", name: "todo_write", input: { todos: [] } },
    { type: "tool-start", id: "a3", name: "exit_plan_mode", input: { plan: "Plan." } },
  ]);
  assert.deepEqual(out, []);
});

test("todo snapshots become the plan-progress note", async () => {
  const out = await mapped([
    {
      type: "todo",
      todos: [
        { text: "scaffold", status: "completed" },
        { text: "build the header", status: "in_progress" },
        { text: "wire routes", status: "pending" },
      ],
    },
  ]);
  assert.deepEqual(out, [{ type: "note", text: "◷ plan · 1/3 — build the header" }]);
});

test("remember is auto-approved engine-side but keeps its confirmation note", async () => {
  const out = await mapped([
    { type: "tool-start", id: "r1", name: REMEMBER_TOOL_ID, input: { note: "Loves pyramids" } },
  ]);
  assert.deepEqual(out, [{ type: "note", text: "✎ remembered: Loves pyramids" }]);
});

test("spilled tool-result reads are relabeled, not shown as prototype work", async () => {
  const out = await mapped([
    {
      type: "tool-start",
      id: "w1",
      name: "mcp__hemiunu-workspace__read_workspace_file",
      input: { path: "/home/u/.hemiunu/projects/p/tool-results/r1.txt" },
    },
  ]);
  assert.deepEqual(out, [{ type: "tool", name: "read_saved_result", preview: "" }]);
});

test("prototype-writing tools mark the turn, including from subagents", async () => {
  const mapper = createTurnMapper();
  await mapped(
    [
      {
        type: "tool-start",
        id: "w2",
        name: "mcp__hemiunu-workspace__write_workspace_file",
        input: { path: "src/App.tsx", content: "x" },
        parent: "task-9",
      },
    ],
    mapper,
  );
  assert.equal(mapper.touchedPrototype, true);
});

test("plan-proposed is skipped when the gate already surfaced that plan", async () => {
  const mapper = createTurnMapper();
  mapper.planNoted("Do the thing.");
  const out = await mapped([{ type: "plan-proposed", plan: "Do the thing." }], mapper);
  assert.deepEqual(out, []);
  // …but an unseen plan (auto-accepted turns never hit the gate note) shows.
  const out2 = await mapped([{ type: "plan-proposed", plan: "Another plan." }], mapper);
  assert.deepEqual(out2, [{ type: "note", text: "Proposed plan:\nAnother plan." }]);
});

test("compaction and errors surface as note / error events", async () => {
  const out = await mapped([
    { type: "compaction", summary: "so far: …" },
    { type: "error", message: "rate limited" },
  ]);
  assert.deepEqual(out, [
    { type: "note", text: "⇣ context compacted — earlier history folded into a summary" },
    { type: "error", message: "rate limited" },
  ]);
});

test("turn-finish records usage/cost/stop; step-finish tracks context size", async () => {
  const mapper = createTurnMapper();
  const out = await mapped(
    [
      { type: "step-finish", usage },
      { type: "turn-finish", text: "done", usage, costUsd: 0.42, stopReason: "aborted" },
    ],
    mapper,
  );
  assert.deepEqual(out, []);
  assert.deepEqual(mapper.finish, { usage, costUsd: 0.42, stopReason: "aborted" });
  assert.deepEqual(mapper.lastStepUsage, usage);
});
