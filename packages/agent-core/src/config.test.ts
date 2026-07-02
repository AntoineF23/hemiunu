import assert from "node:assert/strict";
import { test } from "node:test";
import { contextWindowFor } from "./config";

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
