import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextWindowFor, removeUserEnv, upsertUserEnv } from "./config";

test("contextWindowFor: Opus 4.6+ serves the 1M window (both id spellings)", () => {
  assert.equal(contextWindowFor("claude-opus-4.8"), 1_000_000);
  assert.equal(contextWindowFor("claude-opus-4-8"), 1_000_000);
  assert.equal(contextWindowFor("claude-opus-4-7"), 1_000_000);
  assert.equal(contextWindowFor("claude-opus-4-6"), 1_000_000);
});

test("contextWindowFor: Sonnet 4.6 / 5 and Fable serve the 1M window", () => {
  assert.equal(contextWindowFor("claude-sonnet-4.6"), 1_000_000);
  assert.equal(contextWindowFor("claude-sonnet-4-6"), 1_000_000);
  assert.equal(contextWindowFor("claude-sonnet-5"), 1_000_000);
  assert.equal(contextWindowFor("claude-fable-5"), 1_000_000);
});

test("contextWindowFor: a [1m] suffix always selects the 1M window", () => {
  assert.equal(contextWindowFor("claude-opus-4.5[1m]"), 1_000_000);
  assert.equal(contextWindowFor("claude-sonnet-4.5[1M]"), 1_000_000);
});

test("contextWindowFor: Haiku and older Claude models stay at 200k", () => {
  assert.equal(contextWindowFor("claude-haiku-4-5"), 200_000);
  assert.equal(contextWindowFor("claude-opus-4-1"), 200_000);
  assert.equal(contextWindowFor("claude-sonnet-4-5"), 200_000);
});

test("contextWindowFor: non-Claude providers keep their known windows", () => {
  assert.equal(contextWindowFor("gemini-2.5-pro"), 1_000_000);
  assert.equal(contextWindowFor("grok-4"), 256_000);
  assert.equal(contextWindowFor("gpt-4o"), 128_000);
  assert.equal(contextWindowFor("some-unknown-model"), 128_000);
});

// --- ~/.hemiunu/.env line surgery (upsertUserEnv / removeUserEnv) ------------
// These write real files into a sandbox config dir (HEMIUNU_CONFIG_DIR) — the
// user's actual ~/.hemiunu is never touched.

function withConfigDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-config-"));
  const prev = process.env.HEMIUNU_CONFIG_DIR;
  process.env.HEMIUNU_CONFIG_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
    else process.env.HEMIUNU_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("upsertUserEnv: updates one line, preserving unrelated vars and comments", () => {
  withConfigDir((dir) => {
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "# my notes\nGITHUB_TOKEN=gh-abc\n\nOPENAI_API_KEY=sk-old\nHEMIUNU_MODEL=gpt-5.2\n",
    );
    const prev = process.env.OPENAI_API_KEY;
    try {
      upsertUserEnv("OPENAI_API_KEY", "sk-new");
      const text = readFileSync(envPath, "utf8");
      assert.match(text, /^# my notes$/m);
      assert.match(text, /^GITHUB_TOKEN=gh-abc$/m);
      assert.match(text, /^OPENAI_API_KEY=sk-new$/m);
      assert.match(text, /^HEMIUNU_MODEL=gpt-5\.2$/m);
      assert.doesNotMatch(text, /sk-old/);
      assert.equal(process.env.OPENAI_API_KEY, "sk-new"); // applied immediately
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

test("upsertUserEnv: creates a missing .env with owner-only (0600) permissions", () => {
  withConfigDir((dir) => {
    const prev = process.env.LITELLM_API_KEY;
    try {
      upsertUserEnv("LITELLM_API_KEY", "sk-lite");
      const st = statSync(join(dir, ".env"));
      assert.equal(st.mode & 0o777, 0o600);
    } finally {
      if (prev === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = prev;
    }
  });
});

test("removeUserEnv: removes only the target line and clears process.env", () => {
  withConfigDir((dir) => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "# keep me\nGITHUB_TOKEN=gh-abc\nOPENAI_API_KEY=sk-x\n");
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-x";
    try {
      removeUserEnv("OPENAI_API_KEY");
      const text = readFileSync(envPath, "utf8");
      assert.match(text, /^# keep me$/m);
      assert.match(text, /^GITHUB_TOKEN=gh-abc$/m);
      assert.doesNotMatch(text, /OPENAI_API_KEY/);
      assert.equal(process.env.OPENAI_API_KEY, undefined);
      removeUserEnv("NOT_THERE"); // missing key is a no-op
      assert.equal(readFileSync(envPath, "utf8"), text);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
