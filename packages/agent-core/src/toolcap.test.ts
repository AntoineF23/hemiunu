import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createToolCapHook, createWorkspaceGuardHook } from "./toolcap";
import { activeProtoDir } from "./workspace";

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
  const res = await capHook(10)({ tool_name: "WebFetch", tool_response: big });
  const out = res.hookSpecificOutput?.updatedToolOutput ?? "";
  assert.ok(out.length < big.length, "output should be shorter than the input");
  assert.match(out, /truncated/i);
});

test("toolcap: MCP results are never truncated, regardless of size", async () => {
  const big = "x".repeat(5000);
  const res = await capHook(10)({
    tool_name: "mcp__claude_ai_Figma__get_design_context",
    tool_response: big,
  });
  assert.deepEqual(res, {}, "an mcp__ result should pass through untouched");
});

// --- workspace guard: file writes are confined to the prototype workspace ----
const guard = createWorkspaceGuardHook().PreToolUse![0].hooks[0];

async function confine(toolInput: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = (await (guard as (i: unknown) => Promise<unknown>)({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__canal-image__download_image",
    tool_input: toolInput,
  })) as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } };
  return out.hookSpecificOutput?.updatedInput ?? toolInput;
}

test("guard: a relative destPath is confined under the workspace, keeping its subpath", async () => {
  const dir = activeProtoDir();
  const next = await confine({ destPath: "public/artwork/logo.png", url: "https://x/y.png" });
  assert.equal(next.destPath, join(dir, "public/artwork/logo.png"));
  assert.equal(next.url, "https://x/y.png"); // non-path fields untouched
  assert.ok(isAbsolute(next.destPath as string));
});

test("guard: an absolute path outside the workspace is pulled in by basename", async () => {
  const dir = activeProtoDir();
  const next = await confine({ destPath: "/etc/evil.png" });
  assert.equal(next.destPath, join(dir, "evil.png"));
});

test("guard: a destPath already inside the workspace is left unchanged", async () => {
  const dir = activeProtoDir();
  const inside = join(dir, "public/photo.png");
  const next = await confine({ destPath: inside });
  assert.equal(next.destPath, inside);
});

test("guard: tools with no write-destination key are left alone", async () => {
  const input = { query: "eiffel tower", page_size: 5 };
  assert.deepEqual(await confine(input), input);
});
