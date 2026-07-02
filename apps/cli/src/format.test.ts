import assert from "node:assert/strict";
import { test } from "node:test";
import { compactAt, errText, fmtElapsed, kfmt, tokfmt } from "./format";

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

test("compactAt clamps to [0.1, 0.95] and defaults to 0.5", () => {
  assert.equal(compactAt(undefined), 0.5);
  assert.equal(compactAt("0.7"), 0.7);
  assert.equal(compactAt("0.01"), 0.1); // clamped up
  assert.equal(compactAt("2"), 0.95); // clamped down
});

test("compactAt never yields NaN — a bad value must not disable compaction", () => {
  assert.equal(compactAt("banana"), 0.5);
  assert.ok(Number.isFinite(compactAt("")));
});
