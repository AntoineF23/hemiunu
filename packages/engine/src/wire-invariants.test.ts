// Wire-invariant harness: proves what each AI-SDK provider adapter ACTUALLY
// puts on the wire when the loop's wire view (wireMessages → balanceToolMessages)
// is fed an adversarial history. A capturing fetch is injected through the
// resolveModel seam, so every case runs the real adapter with zero network:
// the fetch records JSON.parse(init.body) and throws, generateText's failure
// is swallowed, and the assertions run against the captured request body.
//
// Four provider families × the adversarial fixture matrix. The invariants are
// family-specific because each wire dialect encodes tool pairing differently:
//   openai            — responses API `input` items (function_call / _output)
//   openai-compatible — chat completions (assistant.tool_calls / role:"tool")
//   anthropic         — tool_use blocks answered by leading tool_result blocks
//                       in the FIRST user message after their assistant turn
//   google            — functionResponse parts matching the immediately
//                       preceding model turn's functionCall parts
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText, jsonSchema, type ToolSet } from "ai";
import { wireMessages } from "./loop";
import { resolveModel, type ModelEntry } from "./models";
import type { TranscriptMessage } from "./transcript";

process.env.HEMIUNU_WIRE_TEST_KEY = "wire-test-key";

const SYSTEM = "You are a wire-invariant probe.";

const TOOLS: ToolSet = {
  echo: {
    description: "Echo the value back.",
    inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
  },
};

function entryFor(over: Partial<ModelEntry> & Pick<ModelEntry, "id" | "provider">): ModelEntry {
  return {
    label: over.id,
    model: "wire-probe-model",
    apiKeyEnv: "HEMIUNU_WIRE_TEST_KEY",
    contextWindow: 128_000,
    supports: { tools: true },
    ...over,
  };
}

/** Run the REAL adapter on the loop's exact wire view; return the captured body. */
async function captureBody(entry: ModelEntry, history: TranscriptMessage[]): Promise<unknown> {
  let captured: unknown;
  const capture: typeof globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    throw new Error("wire-invariants: request captured");
  };
  const resolved = resolveModel(entry.id, [entry], { fetch: capture });
  const failure = await generateText({
    model: resolved.languageModel,
    messages: wireMessages(SYSTEM, history, entry),
    allowSystemInMessages: true,
    tools: TOOLS,
    maxRetries: 0,
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (captured === undefined) {
    const why = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`no request captured — the adapter rejected the messages before fetch: ${why}`);
  }
  return captured;
}

// --- fixture builders -------------------------------------------------------

const user = (text: string): TranscriptMessage => ({ role: "user", content: text });
const textPart = (text: string) => ({ type: "text" as const, text });
const callPart = (id: string) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: "echo",
  input: { value: id },
});
const asst = (...parts: (ReturnType<typeof textPart> | ReturnType<typeof callPart>)[]) =>
  ({ role: "assistant", content: parts }) as TranscriptMessage;
const results = (...ids: string[]): TranscriptMessage => ({
  role: "tool",
  content: ids.map((id) => ({
    type: "tool-result",
    toolCallId: id,
    toolName: "echo",
    output: { type: "text", value: `ok:${id}` },
  })),
});

/** The adversarial matrix. Every entry is a fresh history per invocation. */
const FIXTURES: Record<string, () => TranscriptMessage[]> = {
  // The healthy multi-step chain — must always pass, before and after any fix.
  "clean multi-step chain": () => [
    user("please echo twice"),
    asst(textPart("calling"), callPart("c1")),
    results("c1"),
    asst(callPart("c2")),
    results("c2"),
    user("and then?"),
  ],
  // A persisted orphan (crash between appends / corrupted resume).
  "orphaned tool result at head": () => [user("earlier question"), results("stale-1")],
  // A streamed call that never got a result (interrupted step).
  "dangling assistant tool-call": () => [
    user("go"),
    asst(textPart("let me check"), callPart("c1")),
  ],
  // Two results for one id — strict providers reject duplicates (keep LAST).
  "duplicate tool results": () => [user("go"), asst(callPart("c1")), results("c1"), results("c1")],
  // Result recorded BEFORE its call in array order (proxied step reordering).
  "out-of-order pair": () => [user("go"), results("c1"), asst(callPart("c1"))],
  // Compaction splice: a summary user message lands between the pair.
  "compaction splice between pair": () => [
    user("go"),
    asst(callPart("c1")),
    user("Summary of the conversation so far: …"),
    results("c1"),
  ],
  // Same splice against a parallel-call step with results split across messages.
  "compaction splice, parallel calls": () => [
    user("go"),
    asst(callPart("c1"), callPart("c2")),
    user("Summary of the conversation so far: …"),
    results("c1"),
    results("c2"),
  ],
  // Truncation cut the head mid-pair: the note leads, the orphan result follows.
  "truncation head cut mid-pair": () => [
    user("[Note: earlier conversation history was dropped…]"),
    results("c1"),
    asst(callPart("c2")),
    results("c2"),
  ],
  // Two assistant messages in a row (snapshot quirks / injected calls).
  "consecutive assistant messages": () => [
    user("go"),
    asst(textPart("thinking.")),
    asst(callPart("c1")),
    results("c1"),
  ],
  // The same tool-call id introduced twice (keep FIRST, one answer).
  "duplicate tool-call ids": () => [
    user("go"),
    asst(callPart("c1")),
    results("c1"),
    asst(callPart("c1")),
    results("c1"),
  ],
  // An empty text part riding with the call must not derail pairing.
  "empty-text assistant tool-call": () => [
    user("go"),
    asst(textPart(""), callPart("c1")),
    results("c1"),
  ],
  // Reasoning parts ride along with the call (reasoning-capable families).
  "reasoning part with tool-call": () => [
    user("go"),
    {
      role: "assistant",
      content: [{ type: "reasoning", text: "thinking it through" }, callPart("c1")],
    },
    results("c1"),
  ],
  // ensureAssistantToolCalls appended a fresh assistant carrying the call.
  "injected-call shape": () => [
    user("go"),
    asst(textPart("on it")),
    asst(callPart("c1")),
    results("c1"),
    asst(textPart("done")),
    user("next"),
  ],
};

// --- family-specific invariants ----------------------------------------------

interface ChatMessage {
  role: string;
  tool_call_id?: string;
  tool_calls?: { id: string }[];
}

/** openai-compatible (chat completions): every `tool` message's id introduced by
 *  the nearest preceding assistant, contiguous after it in call order, no
 *  duplicate ids, no consecutive assistant messages, nothing left unanswered. */
function checkChatCompletions(body: unknown): void {
  const messages = (body as { messages: ChatMessage[] }).messages;
  assert.ok(Array.isArray(messages), "chat body must carry messages[]");
  const introduced = new Set<string>();
  const pending: string[] = [];
  let prevRole = "";
  for (const m of messages) {
    if (m.role === "assistant") {
      assert.notEqual(prevRole, "assistant", "consecutive assistant messages");
      assert.equal(pending.length, 0, `assistant message while results pending: ${pending}`);
      for (const tc of m.tool_calls ?? []) {
        assert.ok(!introduced.has(tc.id), `duplicate tool_call id ${tc.id}`);
        introduced.add(tc.id);
        pending.push(tc.id);
      }
    } else if (m.role === "tool") {
      assert.ok(pending.length > 0, "tool message with no preceding unanswered tool_calls");
      assert.equal(m.tool_call_id, pending.shift(), "tool results must follow in call order");
    } else {
      assert.equal(pending.length, 0, `${m.role} message interleaved before tool results`);
    }
    prevRole = m.role;
  }
  assert.equal(pending.length, 0, `unanswered tool_calls at end: ${pending}`);
}

interface ResponsesItem {
  type?: string;
  role?: string;
  call_id?: string;
}

/** openai (responses API): every function_call_output's call_id introduced by a
 *  preceding function_call, no duplicate calls or outputs, every call answered,
 *  and outputs arrive in global call order. (Adjacency is NOT asserted here —
 *  the adapter itself interleaves message items between a call and its output;
 *  that IS the dialect's canonical form.) */
function checkResponses(body: unknown): void {
  const input = (body as { input: ResponsesItem[] }).input;
  assert.ok(Array.isArray(input), "responses body must carry input[]");
  const calls: string[] = [];
  const outputs: string[] = [];
  for (const item of input) {
    if (item.type === "function_call") {
      assert.ok(item.call_id && !calls.includes(item.call_id), `duplicate call ${item.call_id}`);
      calls.push(item.call_id);
    } else if (item.type === "function_call_output") {
      const id = item.call_id ?? "";
      assert.ok(calls.includes(id), `output ${id} not introduced by a preceding function_call`);
      assert.ok(!outputs.includes(id), `duplicate function_call_output ${id}`);
      outputs.push(id);
    }
  }
  assert.deepEqual(outputs, calls, "every call answered exactly once, in call order");
}

interface AnthropicBlock {
  type: string;
  id?: string;
  tool_use_id?: string;
}

/** anthropic: tool_result blocks appear only as the LEADING blocks of the first
 *  user message after their tool_use assistant turn, exactly answering its ids
 *  in call order; no duplicate tool_use ids; roles never repeat back-to-back. */
function checkAnthropic(body: unknown): void {
  const messages = (body as { messages: { role: string; content: AnthropicBlock[] | string }[] })
    .messages;
  assert.ok(Array.isArray(messages), "anthropic body must carry messages[]");
  const introduced = new Set<string>();
  let pending: string[] = [];
  let prevRole = "";
  for (const m of messages) {
    assert.notEqual(m.role, prevRole, `consecutive ${m.role} messages`);
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      assert.equal(pending.length, 0, `assistant turn while tool_results pending: ${pending}`);
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        assert.ok(b.id && !introduced.has(b.id), `duplicate tool_use id ${b.id}`);
        introduced.add(b.id);
        pending.push(b.id);
      }
    } else {
      const resultIds = blocks
        .filter((b) => b.type === "tool_result")
        .map((b) => b.tool_use_id ?? "");
      if (pending.length > 0) {
        assert.deepEqual(resultIds, pending, "first user turn must answer exactly, in call order");
        for (let i = 0; i < resultIds.length; i++) {
          assert.equal(blocks[i].type, "tool_result", "tool_result blocks must lead the message");
        }
        pending = [];
      } else {
        assert.deepEqual(resultIds, [], "tool_result with no unanswered tool_use");
      }
    }
    prevRole = m.role;
  }
  assert.equal(pending.length, 0, `unanswered tool_use at end: ${pending}`);
}

interface GooglePart {
  functionCall?: { id?: string; name: string };
  functionResponse?: { id?: string; name: string };
}

/** google: a user turn's functionResponse parts must exactly match (id + name,
 *  in order) the functionCall parts of the immediately preceding model turn;
 *  no duplicate call ids; no model turn while responses are still owed. */
function checkGoogle(body: unknown): void {
  const contents = (body as { contents: { role: string; parts?: GooglePart[] }[] }).contents;
  assert.ok(Array.isArray(contents), "google body must carry contents[]");
  const introduced = new Set<string>();
  let pending: { id: string; name: string }[] = [];
  for (const c of contents) {
    const parts = c.parts ?? [];
    if (c.role === "model") {
      assert.equal(pending.length, 0, "model turn while functionResponses pending");
      for (const p of parts) {
        if (!p.functionCall) continue;
        const id = p.functionCall.id ?? p.functionCall.name;
        assert.ok(!introduced.has(id), `duplicate functionCall id ${id}`);
        introduced.add(id);
        pending.push({ id, name: p.functionCall.name });
      }
    } else {
      const responses = parts
        .filter((p) => p.functionResponse)
        .map((p) => ({
          id: p.functionResponse?.id ?? p.functionResponse?.name ?? "",
          name: p.functionResponse?.name ?? "",
        }));
      if (pending.length > 0) {
        assert.deepEqual(responses, pending, "responses must match the preceding model turn");
        pending = [];
      } else {
        assert.deepEqual(responses, [], "functionResponse with no unanswered functionCall");
      }
    }
  }
  assert.equal(pending.length, 0, "unanswered functionCalls at end");
}

// --- the matrix ----------------------------------------------------------------

const FAMILIES: { entry: ModelEntry; check: (body: unknown) => void }[] = [
  {
    entry: entryFor({
      id: "wire-anthropic",
      provider: "anthropic",
      supports: { tools: true, caching: true }, // exercise the cacheControl marks too
    }),
    check: checkAnthropic,
  },
  { entry: entryFor({ id: "wire-openai", provider: "openai" }), check: checkResponses },
  { entry: entryFor({ id: "wire-google", provider: "google" }), check: checkGoogle },
  {
    entry: entryFor({
      id: "wire-compat",
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:9/v1",
    }),
    check: checkChatCompletions,
  },
];

for (const { entry, check } of FAMILIES) {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test(`wire invariants: ${entry.provider} × ${name}`, async () => {
      check(await captureBody(entry, fixture()));
    });
  }
}
