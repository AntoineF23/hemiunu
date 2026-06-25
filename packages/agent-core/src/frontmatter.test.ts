import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";

test("parseFrontmatter: no fence → everything is body", () => {
  const { meta, body } = parseFrontmatter("just some text\nmore");
  assert.deepEqual(meta, {});
  assert.equal(body, "just some text\nmore");
});

test("parseFrontmatter: reads flat key/values and trims quotes", () => {
  const { meta, body } = parseFrontmatter(
    `---\nmcp: notion\ndescription: "what's inside"\n---\n\nThe body.`,
  );
  assert.equal(meta.mcp, "notion");
  assert.equal(meta.description, "what's inside");
  assert.equal(body, "The body.");
});

test("parseFrontmatter: ignores malformed lines without a colon", () => {
  const { meta } = parseFrontmatter(`---\nok: yes\ngarbage line\n---\nbody`);
  assert.equal(meta.ok, "yes");
  assert.equal(Object.keys(meta).length, 1);
});

test("renderFrontmatter: round-trips and skips undefined values", () => {
  const text = renderFrontmatter({ mcp: "notion", description: "x", scanned: undefined }, "Body");
  const { meta, body } = parseFrontmatter(text);
  assert.equal(meta.mcp, "notion");
  assert.equal(meta.description, "x");
  assert.equal(meta.scanned, undefined);
  assert.equal(body, "Body");
});

test("renderFrontmatter: quotes values that would break the trivial parse", () => {
  const text = renderFrontmatter({ title: "a: b" }, "body");
  // The colon-bearing value must survive a parse round-trip intact.
  assert.equal(parseFrontmatter(text).meta.title, "a: b");
});
