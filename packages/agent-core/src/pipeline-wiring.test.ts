// Port of the SDK-era toolcap.test.ts (workspace guard, write-scope guard,
// output cap) plus end-to-end checks of the wired engine pipeline — policy
// block, truncation exemption, workspace binding, seen-tool bookkeeping.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createPipeline, type HemiTool, type ToolContext, type TurnEvent } from "@hemiunu/engine";
import { z } from "zod";
import {
  confineWriteDestinations,
  createHemiPipelineConfig,
  createWriteScopeCheck,
} from "./pipeline-wiring";
import { loadToolPolicy, setToolPolicy } from "./toolpolicy";
import { activeProtoDir } from "./workspace";
import { currentWorkspace } from "./workspace-context";

// Hermetic config root: configDir() reads HEMIUNU_CONFIG_DIR at call time, so
// activeProtoDir()/toolpolicy resolve here — never the user's real ~/.hemiunu.
process.env.HEMIUNU_CONFIG_DIR = mkdtempSync(join(tmpdir(), "hemi-wiring-test-"));

function ctx(events: TurnEvent[] = []): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "test",
    emit: (e) => events.push(e),
    mode: () => "default",
    setMode: () => {},
  };
}

const fakeTool = (name: string, writeDestKeys?: string[]): HemiTool => ({
  name,
  description: "",
  inputSchema: z.record(z.string(), z.unknown()),
  writeDestKeys,
  async execute() {
    return { content: "ok" };
  },
});

// --- workspace guard: file writes are confined to the prototype workspace ----

const downloadTool = fakeTool("mcp__canal-image__download_image");

test("guard: a relative destPath is confined under the workspace, keeping its subpath", () => {
  const dir = activeProtoDir();
  const next = confineWriteDestinations(downloadTool, {
    destPath: "public/artwork/logo.png",
    url: "https://x/y.png",
  });
  assert.equal(next.destPath, join(dir, "public/artwork/logo.png"));
  assert.equal(next.url, "https://x/y.png"); // non-path fields untouched
  assert.ok(isAbsolute(next.destPath as string));
});

test("guard: an absolute path outside the workspace is pulled in by basename", () => {
  const dir = activeProtoDir();
  const next = confineWriteDestinations(downloadTool, { destPath: "/etc/evil.png" });
  assert.equal(next.destPath, join(dir, "evil.png"));
});

test("guard: a destPath already inside the workspace is left unchanged", () => {
  const dir = activeProtoDir();
  const inside = join(dir, "public/photo.png");
  const next = confineWriteDestinations(downloadTool, { destPath: inside });
  assert.equal(next.destPath, inside);
});

test("guard: tools with no write-destination key are left alone", () => {
  const input = { query: "eiffel tower", page_size: 5 };
  assert.deepEqual(confineWriteDestinations(downloadTool, input), input);
});

test("guard: a tool's declared writeDestKeys override the default key list", () => {
  const dir = activeProtoDir();
  const t = fakeTool("mcp__custom__saver", ["target"]);
  const next = confineWriteDestinations(t, { target: "/etc/out.bin", destPath: "/etc/other.bin" });
  assert.equal(next.target, join(dir, "out.bin"));
  assert.equal(next.destPath, "/etc/other.bin", "non-declared keys are ignored when overridden");
});

// --- write-scope guard: parallel designers confined to their assigned files ---

const scopeCheck = createWriteScopeCheck(["src/components/Header.tsx"]);
const writeTool = fakeTool("mcp__hemiunu-workspace__write_workspace_file");

test("write-scope: a write to the assigned file is allowed", () => {
  assert.equal(
    scopeCheck(writeTool, { path: "src/components/Header.tsx", content: "x" }),
    undefined,
  );
});

test("write-scope: a brand-new out-of-scope file is allowed (write-if-absent)", () => {
  const rel = "src/components/__scopetest_new__.tsx";
  rmSync(join(activeProtoDir(), rel), { force: true });
  assert.equal(scopeCheck(writeTool, { path: rel, content: "x" }), undefined);
});

test("write-scope: overwriting an existing out-of-scope file is denied", () => {
  const rel = "src/__scopetest_shared__.css";
  const abs = join(activeProtoDir(), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "shared", "utf8");
  try {
    const denied = scopeCheck(writeTool, { path: rel, content: "x" });
    assert.ok(denied, "an out-of-scope overwrite must be denied");
    assert.match(denied ?? "", /outside your scope/);
  } finally {
    rmSync(abs, { force: true });
  }
});

test("write-scope: scaffolding tools are denied for a scoped build", () => {
  for (const name of [
    "mcp__hemiunu-prototype__save_prototype",
    "mcp__hemiunu-workspace__iterate_prototype",
  ]) {
    const denied = scopeCheck(fakeTool(name), { path: "index.html" });
    assert.match(denied ?? "", /scoped component build/);
  }
});

test("write-scope: non-write tools pass through", () => {
  assert.equal(
    scopeCheck(fakeTool("mcp__hemiunu-workspace__read_workspace_file"), { path: "App.tsx" }),
    undefined,
  );
});

// --- the wired pipeline (createHemiPipelineConfig end-to-end) -----------------

test("wired pipeline: a user 'block' is enforced even in auto-accepting (subagent) runs", async () => {
  let executed = false;
  const t: HemiTool = {
    ...fakeTool("mcp__blockedserver__danger"),
    async execute() {
      executed = true;
      return { content: "ran" };
    },
  };
  setToolPolicy(t.name, "block");
  try {
    const p = createPipeline(createHemiPipelineConfig({ tools: [t], autoAccept: true }));
    const out = await p.execute({ id: "1", name: t.name, input: {} }, ctx());
    assert.equal(out.isError, true);
    assert.equal(executed, false);
  } finally {
    setToolPolicy(t.name, "ask");
  }
});

test("wired pipeline: only a scoped run gets the write-scope guard", () => {
  const cfg = createHemiPipelineConfig({ tools: [] });
  assert.equal(cfg.checkWriteScope, undefined);
  const scoped = createHemiPipelineConfig({ tools: [], writeScope: ["src/App.tsx"] });
  assert.ok(scoped.checkWriteScope);
});

test("wired pipeline: mcp__ results are never truncated; others are capped", async () => {
  const big = "x".repeat(5000);
  const mcpTool: HemiTool = {
    ...fakeTool("mcp__figma__get_design_context"),
    async execute() {
      return { content: big };
    },
  };
  const plainTool: HemiTool = {
    ...fakeTool("web_fetch"),
    async execute() {
      return { content: big };
    },
  };
  const p = createPipeline(
    createHemiPipelineConfig({ tools: [mcpTool, plainTool], autoAccept: true, budgetTokens: 10 }),
  );
  const mcpOut = await p.execute({ id: "1", name: mcpTool.name, input: {} }, ctx());
  assert.equal(mcpOut.content.length, 5000, "an mcp__ result should pass through untouched");
  const plainOut = await p.execute({ id: "2", name: plainTool.name, input: {} }, ctx());
  assert.ok(plainOut.content.length < 5000);
  assert.match(plainOut.content, /truncated/i);
});

test("wired pipeline: handlers run inside the turn's workspace binding", async () => {
  let boundSession: string | undefined;
  const t: HemiTool = {
    ...fakeTool("mcp__probe__where"),
    async execute() {
      boundSession = currentWorkspace()?.localSessionId;
      return { content: "ok" };
    },
  };
  const p = createPipeline(createHemiPipelineConfig({ tools: [t], autoAccept: true }));
  const c = ctx();
  c.workspace = { repo: "", localSessionId: "session-42" };
  await p.execute({ id: "1", name: t.name, input: {} }, c);
  assert.equal(boundSession, "session-42");
});

test("wired pipeline: executed tools are recorded as seen (user MCPs only)", async () => {
  const t = fakeTool("mcp__someserver__sometool");
  const p = createPipeline(createHemiPipelineConfig({ tools: [t], autoAccept: true }));
  await p.execute({ id: "1", name: t.name, input: {} }, ctx());
  assert.ok(loadToolPolicy().seen.someserver?.includes(t.name));
});
