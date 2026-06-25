import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolCapHook } from "./toolcap";

// The hook callback only reads `input`; cast to a 1-arg fn so the test doesn't
// depend on the SDK's exact callback arity.
function capHook(budgetTokens: number) {
  const hook = createToolCapHook(budgetTokens);
  return hook.PostToolUse![0].hooks[0] as (input: unknown) => Promise<{
    hookSpecificOutput?: { updatedToolOutput: string };
  }>;
}

test("toolcap: results within budget pass through untouched", async () => {
  const res = await capHook(10)({ tool_response: "short" }); // ~40 char budget
  assert.deepEqual(res, {});
});

test("toolcap: oversized results are capped and carry a truncation notice", async () => {
  const big = "x".repeat(5000);
  const res = await capHook(10)({ tool_response: big });
  const out = res.hookSpecificOutput?.updatedToolOutput ?? "";
  assert.ok(out.length < big.length, "output should be shorter than the input");
  assert.match(out, /truncated/i);
});
