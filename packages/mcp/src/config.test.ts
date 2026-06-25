import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpRegistry } from "./config";

function withTempMcp<T>(servers: Record<string, unknown>, fn: (root: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-mcp-"));
  try {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadMcpRegistry: interpolates ${ENV} and emits one tool pattern per server", () => {
  process.env.HEMIUNU_TEST_TOKEN = "secret123";
  try {
    withTempMcp(
      {
        notion: {
          type: "http",
          url: "https://example.com",
          headers: { Authorization: "Bearer ${HEMIUNU_TEST_TOKEN}" },
        },
      },
      (dir) => {
        const reg = loadMcpRegistry(dir);
        assert.deepEqual(reg.toolPatterns, ["mcp__notion__*"]);
        const cfg = reg.mcpServers.notion as { headers: Record<string, string> };
        assert.equal(cfg.headers.Authorization, "Bearer secret123");
        assert.equal(reg.skipped.length, 0);
      },
    );
  } finally {
    delete process.env.HEMIUNU_TEST_TOKEN;
  }
});

test("loadMcpRegistry: skips a server whose ${ENV} var is unset", () => {
  delete process.env.HEMIUNU_DEFINITELY_UNSET;
  withTempMcp(
    { foo: { type: "http", url: "https://x", headers: { k: "${HEMIUNU_DEFINITELY_UNSET}" } } },
    (dir) => {
      const reg = loadMcpRegistry(dir);
      assert.equal(reg.toolPatterns.length, 0);
      assert.equal(reg.skipped[0]?.name, "foo");
      assert.match(reg.skipped[0]?.reason ?? "", /missing env/);
    },
  );
});

test("loadMcpRegistry: skips disabled servers", () => {
  withTempMcp({ bar: { type: "stdio", command: "echo", disabled: true } }, (dir) => {
    const reg = loadMcpRegistry(dir);
    assert.equal(reg.skipped[0]?.reason, "disabled");
    assert.equal(reg.toolPatterns.length, 0);
  });
});

test("loadMcpRegistry: ${CWD} resolves to the launch directory", () => {
  withTempMcp({ fs: { type: "stdio", command: "srv", args: ["${CWD}/data"] } }, (dir) => {
    const reg = loadMcpRegistry(dir);
    const cfg = reg.mcpServers.fs as { args: string[] };
    assert.equal(cfg.args[0], `${process.cwd()}/data`);
  });
});
