import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
// Pin the SDK home so spilledResult() has a known root to test against.
process.env.CLAUDE_CONFIG_DIR = "/tmp/hemiunu-agent-test";
const { readWindow, searchRegex, spilledResult } = await import("./iterate");
const AGENT_HOME = "/tmp/hemiunu-agent-test";

const SAMPLE = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

test("readWindow: a middle window is numbered and points to the next page", () => {
  const out = readWindow(SAMPLE, 3, 2);
  assert.equal(out, "3\tline 3\n4\tline 4\n\n[lines 3–4 of 10; read on with offset=5]");
});

test("readWindow: a window reaching the end has no 'read on' hint", () => {
  const out = readWindow(SAMPLE, 9, 50);
  assert.match(out, /\[lines 9–10 of 10\]$/);
  assert.doesNotMatch(out, /read on/);
});

test("readWindow: omitted offset starts at line 1", () => {
  const out = readWindow(SAMPLE, undefined, 2);
  assert.match(out, /^1\tline 1\n2\tline 2/);
  assert.match(out, /read on with offset=3/);
});

test("searchRegex: a valid pattern is used as a case-insensitive regex", () => {
  const re = searchRegex("foo.*bar");
  assert.ok(re.test("FOO baz BAR"));
  assert.ok(re.ignoreCase);
});

test("searchRegex: an invalid regex falls back to a literal match", () => {
  // An unbalanced paren would throw as a regex; the literal fallback matches it verbatim.
  const re = searchRegex("rgb(");
  assert.ok(re.test("color: rgb(0,0,0)"));
  assert.ok(!re.test("plain text"));
});

test("spilledResult: allows reading an SDK tool-result overflow file", () => {
  const p = join(AGENT_HOME, "projects/x/session/tool-results/mcp-dive-template.txt");
  assert.equal(spilledResult(p), p);
});

test("spilledResult: refuses secrets in the agent home (no tool-results segment)", () => {
  // .env, the GitHub token, sessions, the DB — all under the home but NOT spill files.
  assert.equal(spilledResult(join(AGENT_HOME, ".claude.json")), null);
  assert.equal(spilledResult(join(AGENT_HOME, "../.env")), null);
  assert.equal(spilledResult(join(AGENT_HOME, "../github.json")), null);
});

test("spilledResult: refuses paths outside the agent home", () => {
  assert.equal(spilledResult("/etc/passwd"), null);
  assert.equal(spilledResult("/tmp/elsewhere/tool-results/x.txt"), null);
});
