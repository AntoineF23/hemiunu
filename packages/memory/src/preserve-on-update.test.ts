import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seedContextFiles } from "./context";
import { ConversationStore } from "./store";

// Regression guard for the promise that downloading a new version of the product
// never erases what the user already did. An update only replaces the app code
// (~/.hemiunu/app); user data lives in sibling paths and must survive the app
// re-initialising against it. These lock in the two invariants that make that
// true — for the two things a user most wants kept: conversations and md memory.

const tmp = () => mkdtempSync(join(tmpdir(), "hemiunu-preserve-"));

test("conversations survive a new app version opening the existing DB", () => {
  const dbPath = join(tmp(), "hemiunu.db");

  // Old version: create a conversation, its messages, and a folder-trust decision.
  const before = new ConversationStore(dbPath);
  before.ensureConversation("sess-1", "My first chat", "claude-opus-4.8");
  before.addMessage("sess-1", "user", "hello", null);
  before.addMessage("sess-1", "assistant", "hi there", 0.01);
  before.setFolderTrust("/Users/x/project", true);
  before.close();

  // New version boots on the SAME on-disk DB (CREATE TABLE IF NOT EXISTS must not
  // wipe anything). Everything the user had is still there.
  const after = new ConversationStore(dbPath);
  const convos = after.listConversations();
  assert.equal(convos.length, 1);
  assert.equal(convos[0].id, "sess-1");
  assert.equal(convos[0].title, "My first chat");

  const messages = after.getMessages("sess-1");
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "hello"],
      ["assistant", "hi there"],
    ],
  );

  assert.equal(after.getFolderTrust("/Users/x/project"), true);
  after.close();
});

test("seedContextFiles never overwrites an edited user.md", () => {
  const appRoot = tmp();
  const userRoot = tmp();
  // A shipped template (appRoot) and the user's own edited memory (userRoot).
  mkdirSync(join(appRoot, "context"), { recursive: true });
  writeFileSync(join(appRoot, "context", "user.md.example"), "# template\n", "utf8");
  const custom = "# me\n- I prefer concise answers\n- Role: PM\n";
  writeFileSync(join(userRoot, "user.md"), custom, "utf8");

  // Re-run seeding as happens on every boot after an update.
  seedContextFiles({ appRoot, userRoot });

  assert.equal(readFileSync(join(userRoot, "user.md"), "utf8"), custom);
});

test("seedContextFiles still creates user.md when missing (seeding not vacuous)", () => {
  const appRoot = tmp();
  const userRoot = tmp();
  mkdirSync(join(appRoot, "context"), { recursive: true });
  writeFileSync(join(appRoot, "context", "user.md.example"), "# template\n", "utf8");

  seedContextFiles({ appRoot, userRoot });

  assert.equal(readFileSync(join(userRoot, "user.md"), "utf8"), "# template\n");
});
