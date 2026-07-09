import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { TurnEvent } from "./events";
import { DirectExecutor } from "./executor";
import {
  createPipeline,
  matchToolName,
  MAX_SELF_REPAIR_ATTEMPTS,
  type PipelineConfig,
} from "./pipeline";
import type { HemiTool, ToolContext } from "./tool";

function ctx(events: TurnEvent[] = []): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "test",
    emit: (e) => events.push(e),
    mode: () => "default",
    setMode: () => {},
  };
}

const echoTool: HemiTool = {
  name: "mcp__test__echo",
  description: "echoes",
  inputSchema: z.object({ msg: z.string() }),
  async execute(input) {
    return { content: (input as { msg: string }).msg };
  },
};

const autoTool: HemiTool = {
  name: "mcp__test__auto",
  description: "auto-approved",
  inputSchema: z.object({}),
  permission: "auto",
  async execute() {
    return { content: "ran" };
  },
};

function pipe(overrides: Partial<PipelineConfig> = {}) {
  return createPipeline({ tools: [echoTool, autoTool], ...overrides });
}

const call = (name: string, input: unknown, id = "t1") => ({ id, name, input });

// --- policy block -------------------------------------------------------------

test("pipeline: a policy 'block' refuses the call before anything runs", async () => {
  let executed = false;
  const t: HemiTool = { ...echoTool, execute: async () => ((executed = true), { content: "x" }) };
  const p = createPipeline({ tools: [t], policy: () => "block", autoAccept: true });
  const out = await p.execute(call(t.name, { msg: "hi" }), ctx());
  assert.equal(out.isError, true);
  assert.match(out.content, /Blocked/i);
  assert.equal(executed, false, "a blocked tool must never execute — even under auto-accept");
});

test("pipeline: 'block' wins over an 'auto' tool permission", async () => {
  const p = createPipeline({ tools: [autoTool], policy: () => "block" });
  const out = await p.execute(call(autoTool.name, {}), ctx());
  assert.equal(out.isError, true);
});

test("pipeline: unknown tools return an error result", async () => {
  const out = await pipe({ autoAccept: true }).execute(call("nope", {}), ctx());
  assert.equal(out.isError, true);
  assert.match(out.content, /Unknown tool/);
});

// --- the gate ------------------------------------------------------------------

test("pipeline: permission 'auto' skips the interactive gate", async () => {
  let asked = 0;
  const events: TurnEvent[] = [];
  const p = pipe({
    canUseTool: async () => ((asked += 1), { behavior: "allow" }),
  });
  const out = await p.execute(call(autoTool.name, {}), ctx(events));
  assert.equal(out.content, "ran");
  assert.equal(asked, 0);
  const note = events.find((e) => e.type === "permission-note");
  assert.equal(note && "decision" in note ? note.decision : undefined, "auto");
});

test("pipeline: policy 'allow' and the session alwaysAllow set skip the prompt", async () => {
  let asked = 0;
  const gate = async () => ((asked += 1), { behavior: "allow" as const });
  const byPolicy = pipe({ policy: () => "allow", canUseTool: gate });
  assert.equal((await byPolicy.execute(call(echoTool.name, { msg: "a" }), ctx())).content, "a");
  const bySet = pipe({ alwaysAllow: new Set([echoTool.name]), canUseTool: gate });
  assert.equal((await bySet.execute(call(echoTool.name, { msg: "b" }), ctx())).content, "b");
  assert.equal(asked, 0);
});

test("pipeline: the gate parks the call and an approval runs it", async () => {
  let resolveGate!: (r: { behavior: "allow" }) => void;
  const p = pipe({
    canUseTool: () => new Promise((res) => (resolveGate = res)),
  });
  const events: TurnEvent[] = [];
  const pending = p.execute(call(echoTool.name, { msg: "approved" }), ctx(events));
  await new Promise((r) => setImmediate(r)); // parked, not resolved
  resolveGate({ behavior: "allow" });
  const out = await pending;
  assert.equal(out.content, "approved");
  const note = events.find((e) => e.type === "permission-note");
  assert.equal(note && "decision" in note ? note.decision : undefined, "user");
});

test("pipeline: a gate deny returns the denial as an error result", async () => {
  let executed = false;
  const t: HemiTool = { ...echoTool, execute: async () => ((executed = true), { content: "x" }) };
  const p = createPipeline({
    tools: [t],
    canUseTool: async () => ({ behavior: "deny", message: "Denied by user." }),
  });
  const out = await p.execute(call(t.name, { msg: "hi" }), ctx());
  assert.equal(out.isError, true);
  assert.equal(out.content, "Denied by user.");
  assert.equal(executed, false);
});

test("pipeline: the gate's updatedInput replaces the call input", async () => {
  const p = pipe({
    canUseTool: async () => ({ behavior: "allow", updatedInput: { msg: "rewritten" } }),
  });
  const out = await p.execute(call(echoTool.name, { msg: "original" }), ctx());
  assert.equal(out.content, "rewritten");
});

test("pipeline: concurrent prompts are serialized, one menu at a time", async () => {
  const order: string[] = [];
  const resolvers: ((r: { behavior: "allow" }) => void)[] = [];
  const p = pipe({
    canUseTool: (_name, input) =>
      new Promise((res) => {
        order.push(`ask:${(input as { msg: string }).msg}`);
        resolvers.push(res);
      }),
  });
  const a = p.execute(call(echoTool.name, { msg: "first" }, "a"), ctx());
  const b = p.execute(call(echoTool.name, { msg: "second" }, "b"), ctx());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["ask:first"], "the second prompt must wait for the first answer");
  resolvers[0]({ behavior: "allow" });
  await a;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["ask:first", "ask:second"]);
  resolvers[1]({ behavior: "allow" });
  assert.equal((await b).content, "second");
});

test("pipeline: a deny does not wedge the prompt chain", async () => {
  let n = 0;
  const p = pipe({
    canUseTool: async () =>
      ++n === 1 ? { behavior: "deny", message: "no" } : { behavior: "allow" },
  });
  assert.equal((await p.execute(call(echoTool.name, { msg: "a" }), ctx())).isError, true);
  assert.equal((await p.execute(call(echoTool.name, { msg: "b" }), ctx())).content, "b");
});

test("pipeline: autoAccept passes gated tools without a prompt", async () => {
  let asked = 0;
  const p = pipe({
    autoAccept: true,
    canUseTool: async () => ((asked += 1), { behavior: "allow" }),
  });
  assert.equal((await p.execute(call(echoTool.name, { msg: "go" }), ctx())).content, "go");
  assert.equal(asked, 0);
});

test("pipeline: no gate wired (non-interactive) auto-approves", async () => {
  const out = await pipe().execute(call(echoTool.name, { msg: "eval" }), ctx());
  assert.equal(out.content, "eval");
});

// --- validation & self-repair ---------------------------------------------------

test("pipeline: malformed args return a self-repair error result", async () => {
  const out = await pipe({ autoAccept: true }).execute(call(echoTool.name, { msg: 42 }), ctx());
  assert.equal(out.isError, true);
  assert.match(out.content, /Invalid arguments for mcp__test__echo/);
  assert.match(out.content, /Re-emit the call/);
});

test("pipeline: self-repair is capped, then tells the model to stop retrying", async () => {
  const p = pipe({ autoAccept: true });
  for (let i = 1; i < MAX_SELF_REPAIR_ATTEMPTS; i++) {
    const out = await p.execute(call(echoTool.name, { msg: i }, `bad${i}`), ctx());
    assert.match(out.content, /Re-emit the call/, `attempt ${i} should still invite a retry`);
  }
  const capped = await p.execute(call(echoTool.name, { msg: 99 }, "badN"), ctx());
  assert.match(capped.content, /Self-repair limit reached/);
  assert.match(capped.content, /do NOT retry/i);
});

test("pipeline: a valid call resets the self-repair counter", async () => {
  const p = pipe({ autoAccept: true });
  await p.execute(call(echoTool.name, { msg: 1 }), ctx()); // invalid
  await p.execute(call(echoTool.name, { msg: 2 }), ctx()); // invalid
  await p.execute(call(echoTool.name, { msg: "ok" }), ctx()); // valid — resets
  const out = await p.execute(call(echoTool.name, { msg: 3 }), ctx());
  assert.match(out.content, /attempt 1 of/, "the counter should restart after a valid call");
});

// --- weak-model repair ladder -----------------------------------------------------

test("ladder rung 1: a case/punctuation-drift name is corrected once, then coached", async () => {
  const p = pipe({ autoAccept: true });
  // First misspelling: silently corrected, the tool runs.
  const out = await p.execute(call("MCP__Test__Echo", { msg: "fixed" }), ctx());
  assert.equal(out.isError, undefined);
  assert.equal(out.content, "fixed");
  // Same misspelling again: the crutch is gone — corrective error names the real tool.
  const again = await p.execute(call("MCP__Test__Echo", { msg: "x" }, "t2"), ctx());
  assert.equal(again.isError, true);
  assert.match(again.content, /Did you mean 'mcp__test__echo'/);
});

test("ladder rung 1: a bare MCP tool name owned by exactly one server is corrected", async () => {
  const out = await pipe({ autoAccept: true }).execute(call("echo", { msg: "bare" }), ctx());
  assert.equal(out.content, "bare");
});

test("ladder rung 1: a near-miss gets a 'did you mean' suggestion under the repair cap", async () => {
  const out = await pipe({ autoAccept: true }).execute(
    call("mcp__test__ecko", { msg: "x" }),
    ctx(),
  );
  assert.equal(out.isError, true);
  assert.match(out.content, /Unknown tool: mcp__test__ecko/);
  assert.match(out.content, /Did you mean 'mcp__test__echo'\?/);
  assert.match(out.content, /attempt 1 of 3/);
});

test("ladder rung 1: unknown-name repair shares the 3-attempt cap", async () => {
  const p = pipe({ autoAccept: true });
  for (let i = 1; i < MAX_SELF_REPAIR_ATTEMPTS; i++) {
    const out = await p.execute(call("mcp__test__ecko", { msg: "x" }, `u${i}`), ctx());
    assert.match(out.content, /Did you mean/, `attempt ${i} should still suggest`);
  }
  const capped = await p.execute(call("mcp__test__ecko", { msg: "x" }, "uN"), ctx());
  assert.match(capped.content, /Self-repair limit reached/);
  assert.match(capped.content, /do NOT retry/i);
});

test("ladder rung 1: a policy 'block' on the REAL tool still wins after correction", async () => {
  const p = createPipeline({
    tools: [echoTool],
    policy: (n) => (n === echoTool.name ? "block" : "ask"),
    autoAccept: true,
  });
  const out = await p.execute(call("Echo", { msg: "x" }), ctx());
  assert.equal(out.isError, true);
  assert.match(out.content, /Blocked by your tool policy/);
});

test("ladder rung 2: stringified-JSON arguments are parsed and the call runs", async () => {
  const out = await pipe({ autoAccept: true }).execute(
    call(echoTool.name, '{"msg":"decoded"}'),
    ctx(),
  );
  assert.equal(out.isError, undefined);
  assert.equal(out.content, "decoded");
});

test("ladder rung 2: an undecodable string input gets the targeted string error", async () => {
  const out = await pipe({ autoAccept: true }).execute(call(echoTool.name, "msg=hi"), ctx());
  assert.equal(out.isError, true);
  assert.match(out.content, /plain string, not a JSON object/);
  assert.match(out.content, /Re-emit the call/);
});

test("ladder rung 3: missing and EMPTY required fields are named (JSON-schema tools)", async () => {
  const t: HemiTool = {
    name: "mcp__acme__note",
    description: "",
    inputSchema: {
      jsonSchema: { type: "object", required: ["note"], properties: { note: { type: "string" } } },
    },
    async execute() {
      return { content: "ok" };
    },
  };
  const p = createPipeline({ tools: [t], autoAccept: true });
  const missing = await p.execute(call(t.name, {}), ctx());
  assert.equal(missing.isError, true);
  assert.match(missing.content, /note: required/);
  const empty = await p.execute(call(t.name, { note: "  " }, "t2"), ctx());
  assert.equal(empty.isError, true);
  assert.match(empty.content, /note: required \(was empty/);
  const ok = await p.execute(call(t.name, { note: "real" }, "t3"), ctx());
  assert.equal(ok.content, "ok");
});

test("matchToolName: confident for drift/bare names, suggestion for near-miss, none afar", () => {
  const tools = [echoTool, autoTool];
  assert.equal(matchToolName("Echo", tools)?.confident, true);
  assert.equal(matchToolName("mcp_test_echo", tools)?.confident, true);
  const near = matchToolName("mcp__test__ecko", tools);
  assert.equal(near?.tool.name, echoTool.name);
  assert.equal(near?.confident, false);
  assert.equal(matchToolName("completely_different", tools), undefined);
  assert.equal(matchToolName("", tools), undefined);
});

// --- guards, execution, truncation ----------------------------------------------

test("pipeline: confineWrites rewrites the input before execution", async () => {
  const seen: unknown[] = [];
  const t: HemiTool = {
    name: "writer",
    description: "",
    inputSchema: z.object({ destPath: z.string() }),
    async execute(input) {
      seen.push(input);
      return { content: "ok" };
    },
  };
  const p = createPipeline({
    tools: [t],
    autoAccept: true,
    confineWrites: (_tool, input) => ({ ...input, destPath: "/workspace/safe.png" }),
  });
  await p.execute(call("writer", { destPath: "/etc/evil.png" }), ctx());
  assert.deepEqual(seen, [{ destPath: "/workspace/safe.png" }]);
});

test("pipeline: checkWriteScope denies out-of-scope writes", async () => {
  let executed = false;
  const t: HemiTool = { ...echoTool, execute: async () => ((executed = true), { content: "x" }) };
  const p = createPipeline({
    tools: [t],
    autoAccept: true,
    checkWriteScope: () => "out of scope",
  });
  const out = await p.execute(call(t.name, { msg: "hi" }), ctx());
  assert.equal(out.isError, true);
  assert.equal(out.content, "out of scope");
  assert.equal(executed, false);
});

test("pipeline: handlers run inside runInWorkspace", async () => {
  let inWorkspace = false;
  let sawFlag = false;
  const t: HemiTool = {
    name: "probe",
    description: "",
    inputSchema: z.object({}),
    permission: "auto",
    async execute() {
      sawFlag = inWorkspace;
      return { content: "ok" };
    },
  };
  const p = createPipeline({
    tools: [t],
    runInWorkspace: async (_ctx, fn) => {
      inWorkspace = true;
      try {
        return await fn();
      } finally {
        inWorkspace = false;
      }
    },
  });
  await p.execute(call("probe", {}), ctx());
  assert.equal(sawFlag, true, "execute() must run inside the injected wrapper");
});

test("pipeline: a throwing handler becomes an error result", async () => {
  const t: HemiTool = {
    name: "boom",
    description: "",
    inputSchema: z.object({}),
    permission: "auto",
    async execute() {
      throw new Error("kaput");
    },
  };
  const out = await createPipeline({ tools: [t] }).execute(call("boom", {}), ctx());
  assert.equal(out.isError, true);
  assert.equal(out.content, "kaput");
});

test("pipeline: oversized results are truncated to the budget with a notice", async () => {
  const t: HemiTool = {
    name: "bigdump",
    description: "",
    inputSchema: z.object({}),
    permission: "auto",
    async execute() {
      return { content: "x".repeat(5000) };
    },
  };
  const p = createPipeline({ tools: [t], resultBudgetTokens: 10 }); // ~40 chars
  const out = await p.execute(call("bigdump", {}), ctx());
  assert.ok(out.content.length < 5000);
  assert.match(out.content, /truncated/i);
});

test("pipeline: results within budget pass through untouched", async () => {
  const p = createPipeline({ tools: [autoTool], resultBudgetTokens: 10 });
  assert.equal((await p.execute(call(autoTool.name, {}), ctx())).content, "ran");
});

test("pipeline: exempt tools are never truncated, regardless of size", async () => {
  const t: HemiTool = {
    name: "mcp__figma__get_design_context",
    description: "",
    inputSchema: z.object({}),
    permission: "auto",
    async execute() {
      return { content: "x".repeat(5000) };
    },
  };
  const p = createPipeline({
    tools: [t],
    resultBudgetTokens: 10,
    exemptFromTruncation: (name) => name.startsWith("mcp__"),
  });
  const out = await p.execute(call(t.name, {}), ctx());
  assert.equal(out.content.length, 5000);
});

test("pipeline: the hard ceiling caps even a truncation-exempt result (exemption is not unbounded)", async () => {
  const t: HemiTool = {
    name: "mcp__figma__get_design_context",
    description: "",
    inputSchema: z.object({}),
    permission: "auto",
    async execute() {
      return { content: "x".repeat(5000) };
    },
  };
  const p = createPipeline({
    tools: [t],
    resultBudgetTokens: 10, // exempt tools skip THIS
    exemptFromTruncation: (name) => name.startsWith("mcp__"),
    hardResultCapTokens: 100, // …but never exceed ~400 chars, exempt or not
  });
  const out = await p.execute(call(t.name, {}), ctx());
  assert.ok(out.content.length < 5000, "a single oversized exempt result is capped");
  assert.match(out.content, /truncated/i);
});

test("pipeline: onExecuted bookkeeping fires after a run", async () => {
  const seen: string[] = [];
  const p = pipe({ autoAccept: true, onExecuted: (n) => seen.push(n) });
  await p.execute(call(echoTool.name, { msg: "hi" }), ctx());
  assert.deepEqual(seen, [echoTool.name]);
});

test("pipeline: the handler sees its own tool-call id (subagent parent stamping)", async () => {
  const ids: (string | undefined)[] = [];
  const t: HemiTool = {
    name: "who_called",
    description: "",
    inputSchema: z.object({}),
    permission: "auto",
    async execute(_input, c) {
      ids.push(c.toolCallId);
      return { content: "ok" };
    },
  };
  await createPipeline({ tools: [t] }).execute(call("who_called", {}, "call-77"), ctx());
  const direct = new DirectExecutor([t]);
  await direct.execute(call("who_called", {}, "call-88"), ctx());
  assert.deepEqual(ids, ["call-77", "call-88"]);
});
