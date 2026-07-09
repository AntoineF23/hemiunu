import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRepo } from "./github";

test("normalizeRepo: plain owner/name is unchanged", () => {
  assert.equal(normalizeRepo("acme/widget"), "acme/widget");
});

test("normalizeRepo: strips https URL, .git, and trailing slash", () => {
  assert.equal(normalizeRepo("https://github.com/acme/widget.git"), "acme/widget");
  assert.equal(normalizeRepo("https://github.com/acme/widget/"), "acme/widget");
});

test("normalizeRepo: strips ssh remote form", () => {
  assert.equal(normalizeRepo("git@github.com:acme/widget.git"), "acme/widget");
});

test("normalizeRepo: trims surrounding whitespace", () => {
  assert.equal(normalizeRepo("  acme/widget  "), "acme/widget");
});
