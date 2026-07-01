import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import {
  createAgentHooks,
  createToolCapHook,
  createWorkspaceGuardHook,
  createWriteScopeGuardHook,
} from "./toolcap";
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

// --- write-scope guard: parallel designers confined to their assigned files ---
const scopeGuard = createWriteScopeGuardHook(["src/components/Header.tsx"]).PreToolUse![0].hooks[0];

async function scopeWrite(
  path: string,
  toolName = "mcp__hemiunu-workspace__write_workspace_file",
): Promise<{ hookSpecificOutput?: { permissionDecision?: string } }> {
  return (await (scopeGuard as (i: unknown) => Promise<unknown>)({
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { path, content: "x" },
  })) as { hookSpecificOutput?: { permissionDecision?: string } };
}

test("write-scope: a write to the assigned file is allowed", async () => {
  assert.deepEqual(await scopeWrite("src/components/Header.tsx"), {});
});

test("write-scope: a brand-new out-of-scope file is allowed (write-if-absent)", async () => {
  const rel = "src/components/__scopetest_new__.tsx";
  rmSync(join(activeProtoDir(), rel), { force: true });
  assert.deepEqual(await scopeWrite(rel), {});
});

test("write-scope: overwriting an existing out-of-scope file is denied", async () => {
  const rel = "src/__scopetest_shared__.css";
  const abs = join(activeProtoDir(), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "shared", "utf8");
  try {
    const res = await scopeWrite(rel);
    assert.equal(res.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    rmSync(abs, { force: true });
  }
});

test("write-scope: scaffolding tools are denied for a scoped build", async () => {
  const res = await scopeWrite("index.html", "mcp__hemiunu-prototype__save_prototype");
  assert.equal(res.hookSpecificOutput?.permissionDecision, "deny");
});

test("write-scope: createAgentHooks wires the scope guard only when a scope is given", () => {
  const without = createAgentHooks().PreToolUse ?? [];
  const with_ = createAgentHooks({ writeScope: ["src/components/Header.tsx"] }).PreToolUse ?? [];
  // policy-block + workspace-guard by default; the scope guard is the third,
  // added only when a non-empty writeScope is passed.
  assert.equal(with_.length, without.length + 1);
});
