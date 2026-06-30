import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  attachmentsBlock,
  attachmentsFor,
  deleteAttachment,
  deleteKnowledgeOverride,
  hasKnowledgeOverride,
  knowledgeDoc,
  listAttachments,
  saveAttachment,
  saveKnowledgeOverride,
  shippedKnowledge,
} from "./overlay";
import { buildMemoryGraph } from "./memorygraph";

let root: string;
let appRoot: string;
let prevHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hemiunu-overlay-"));
  appRoot = mkdtempSync(join(tmpdir(), "hemiunu-app-"));
  // A shipped knowledge pack to override.
  mkdirSync(join(appRoot, "context", "knowledge"), { recursive: true });
  writeFileSync(join(appRoot, "context", "knowledge", "design.md"), "SHIPPED design pack", "utf8");
  prevHome = process.env.HEMIUNU_HOME;
  process.env.HEMIUNU_HOME = appRoot;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HEMIUNU_HOME;
  else process.env.HEMIUNU_HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(appRoot, { recursive: true, force: true });
});

test("attachments: saved file is found, round-trips, and filters by agent", () => {
  saveAttachment({
    title: "Glossary",
    description: "terms",
    agents: ["researcher"],
    body: "ARR = …",
    root,
  });
  const list = listAttachments(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, "glossary");
  assert.deepEqual(list[0].agents, ["researcher"]);

  // Attached to researcher only — present for researcher, absent for main.
  assert.equal(attachmentsFor("researcher", root).length, 1);
  assert.equal(attachmentsFor("main", root).length, 0);
  assert.match(attachmentsBlock("researcher", root), /ARR = …/);
  assert.equal(attachmentsBlock("main", root), "");
});

test("attachments: '*' attaches to every agent; delete removes it", () => {
  saveAttachment({ title: "House style", agents: ["*"], body: "Be concise.", root });
  assert.equal(attachmentsFor("main", root).length, 1);
  assert.equal(attachmentsFor("designer", root).length, 1);
  assert.equal(deleteAttachment("house-style", root), true);
  assert.equal(listAttachments(root).length, 0);
  assert.equal(deleteAttachment("house-style", root), false);
});

test("knowledge override wins over the shipped pack and revert restores it", () => {
  assert.equal(shippedKnowledge("design"), "SHIPPED design pack");
  assert.equal(knowledgeDoc("design", root), ""); // no override yet
  assert.equal(hasKnowledgeOverride("design", root), false);

  saveKnowledgeOverride("design", "MY custom design pack", root);
  assert.equal(hasKnowledgeOverride("design", root), true);
  assert.equal(knowledgeDoc("design", root), "MY custom design pack");
  assert.equal(shippedKnowledge("design"), "SHIPPED design pack"); // original untouched

  assert.equal(deleteKnowledgeOverride("design", root), true);
  assert.equal(knowledgeDoc("design", root), ""); // reverted → falls back to shipped
});

test("buildMemoryGraph: emits the real agent→file access edges", () => {
  saveAttachment({ title: "Notes", agents: ["analyst"], body: "x", root });
  const { nodes, links } = buildMemoryGraph(root);
  const ids = new Set(nodes.map((n) => n.id));

  // Agents + core memory nodes exist.
  for (const id of [
    "agent:main",
    "agent:researcher",
    "agent:prototyper",
    "persona:soul",
    "user:user",
  ]) {
    assert.ok(ids.has(id), `missing node ${id}`);
  }
  const hasLink = (s: string, t: string) => links.some((l) => l.source === s && l.target === t);

  // main hubs persona (read) + user.md (write); the design pack binds to prototyper.
  assert.ok(hasLink("agent:main", "persona:soul"));
  assert.ok(hasLink("agent:main", "user:user"));
  assert.ok(hasLink("agent:prototyper", "knowledge:design"));
  // The coordinator delegates to each subagent (main → subagent edge).
  assert.ok(
    links.some(
      (l) =>
        l.source === "agent:main" && l.target === "agent:researcher" && l.access === "delegate",
    ),
  );
  // Subagents do NOT read soul/user.
  assert.ok(!hasLink("agent:researcher", "persona:soul"));
  // The attachment links to its target agent only.
  assert.ok(hasLink("agent:analyst", "context:notes"));
  assert.ok(!hasLink("agent:main", "context:notes"));
});
