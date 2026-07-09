import assert from "node:assert/strict";
import { test } from "node:test";
import { errText, fmtElapsed, kfmt, modelRow, tokfmt } from "./format";

test("kfmt rounds to whole thousands", () => {
  assert.equal(kfmt(245_000), "245k");
  assert.equal(kfmt(1_499), "1k");
  assert.equal(kfmt(1_500), "2k");
  assert.equal(kfmt(0), "0k");
});

test("errText extracts an Error's message and stringifies anything else", () => {
  assert.equal(errText(new Error("boom")), "boom");
  assert.equal(errText("plain"), "plain");
  assert.equal(errText(42), "42");
  assert.equal(errText(undefined), "undefined");
});

test("fmtElapsed renders seconds below a minute, m + s above", () => {
  assert.equal(fmtElapsed(0), "0s");
  assert.equal(fmtElapsed(9_400), "9s");
  assert.equal(fmtElapsed(60_000), "1m 0s");
  assert.equal(fmtElapsed(61_000), "1m 1s");
  assert.equal(fmtElapsed(3_599_000), "59m 59s");
});

test("tokfmt keeps small counts as-is, abbreviates thousands with one decimal", () => {
  assert.equal(tokfmt(999), "999");
  assert.equal(tokfmt(1_000), "1.0k");
  assert.equal(tokfmt(1_234), "1.2k");
  assert.equal(tokfmt(15_678), "15.7k");
});

test("modelRow marks the active entry and shows id, label, provider, window, tags", () => {
  const entry = {
    id: "claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    tags: ["synthesis"],
  };
  assert.equal(
    modelRow(entry, "claude-opus-4.8"),
    "● claude-opus-4.8 — Claude Opus 4.8 · anthropic · 1000k ctx · synthesis",
  );
  assert.equal(
    modelRow(entry, "gpt-5.2"),
    "○ claude-opus-4.8 — Claude Opus 4.8 · anthropic · 1000k ctx · synthesis",
  );
});

test("modelRow omits the tag suffix when an entry has no tags", () => {
  const row = modelRow(
    { id: "gpt-5.2", label: "GPT-5.2", provider: "openai", contextWindow: 400_000 },
    "gpt-5.2",
  );
  assert.equal(row, "● gpt-5.2 — GPT-5.2 · openai · 400k ctx");
});
