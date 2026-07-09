import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore, type TranscriptMessage } from "./transcript";

function withStore(fn: (store: TranscriptStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-engine-transcript-"));
  const store = new TranscriptStore(join(dir, "transcript.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const user = (text: string): TranscriptMessage => ({ role: "user", content: text });
const assistant = (text: string): TranscriptMessage => ({ role: "assistant", content: text });

test("transcript: append → load round-trips messages in order", () => {
  withStore((store) => {
    store.append("c1", [user("hello"), assistant("hi there")]);
    store.append("c1", [user("again")]);

    const { summary, messages } = store.load("c1");
    assert.equal(summary, undefined);
    assert.deepEqual(messages, [user("hello"), assistant("hi there"), user("again")]);
  });
});

test("transcript: nextSeq counts per conversation, starting at 1", () => {
  withStore((store) => {
    assert.equal(store.nextSeq("c1"), 1);
    store.append("c1", [user("a"), assistant("b")]);
    assert.equal(store.nextSeq("c1"), 3);
    assert.equal(store.nextSeq("other"), 1);
  });
});

test("transcript: compaction folds covered messages into the summary", () => {
  withStore((store) => {
    store.append("c1", [user("one"), assistant("two"), user("three")]);
    store.recordCompaction("c1", "user greeted twice", 2);
    store.append("c1", [assistant("four")]);

    const { summary, messages } = store.load("c1");
    assert.equal(summary, "user greeted twice");
    assert.deepEqual(messages, [user("three"), assistant("four")]);
  });
});

test("transcript: the latest compaction wins", () => {
  withStore((store) => {
    store.append("c1", [user("1"), assistant("2"), user("3"), assistant("4")]);
    store.recordCompaction("c1", "first summary", 2);
    store.recordCompaction("c1", "second summary", 3);

    const { summary, messages } = store.load("c1");
    assert.equal(summary, "second summary");
    assert.deepEqual(messages, [assistant("4")]);
  });
});

test("transcript: conversations are isolated", () => {
  withStore((store) => {
    store.append("c1", [user("for c1")]);
    store.append("c2", [user("for c2"), assistant("reply c2")]);
    store.recordCompaction("c1", "c1 summary", 1);

    const c1 = store.load("c1");
    assert.equal(c1.summary, "c1 summary");
    assert.deepEqual(c1.messages, []);

    const c2 = store.load("c2");
    assert.equal(c2.summary, undefined);
    assert.deepEqual(c2.messages, [user("for c2"), assistant("reply c2")]);
  });
});

test("transcript: loading an unknown conversation returns an empty transcript", () => {
  withStore((store) => {
    assert.deepEqual(store.load("ghost"), { summary: undefined, messages: [] });
  });
});
