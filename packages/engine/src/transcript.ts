// TranscriptStore: the durable, provider-neutral conversation history. Rows
// hold AI SDK ModelMessages as JSON; compactions fold old rows into a summary
// without deleting them (superseded rows stay for replay/audit).

import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { ModelMessage } from "ai";

/**
 * The alias wall: everything outside the engine says TranscriptMessage; only
 * this alias knows it's the AI SDK's ModelMessage.
 */
export type TranscriptMessage = ModelMessage;

export interface LoadedTranscript {
  /** Latest compaction summary, if the history has been folded. */
  summary?: string;
  /** Live (non-superseded, post-compaction) messages in seq order. */
  messages: TranscriptMessage[];
}

export class TranscriptStore {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript (
        id              INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        message         TEXT NOT NULL,
        superseded_by   INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_conversation_seq
        ON transcript (conversation_id, seq);
      CREATE TABLE IF NOT EXISTS compactions (
        id              INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        summary         TEXT NOT NULL,
        covers_to_seq   INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
    `);
  }

  /** Next unused seq for a conversation (1-based). */
  nextSeq(conversationId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS max FROM transcript WHERE conversation_id = ?")
      .get(conversationId) as { max: number | null };
    return (row.max ?? 0) + 1;
  }

  /** Append messages, assigning consecutive seq numbers, atomically. */
  append(conversationId: string, messages: TranscriptMessage[]): void {
    if (messages.length === 0) return;
    const insert = this.db.prepare(
      "INSERT INTO transcript (conversation_id, seq, message, created_at) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    this.db.transaction(() => {
      let seq = this.nextSeq(conversationId);
      for (const message of messages) {
        insert.run(conversationId, seq++, JSON.stringify(message), now);
      }
    })();
  }

  /**
   * Load what the model should see: the latest compaction summary (if any)
   * plus all non-superseded messages after the compaction point.
   */
  load(conversationId: string): LoadedTranscript {
    const compaction = this.db
      .prepare(
        "SELECT summary, covers_to_seq FROM compactions WHERE conversation_id = ? " +
          "ORDER BY id DESC LIMIT 1",
      )
      .get(conversationId) as { summary: string; covers_to_seq: number } | undefined;
    const coversTo = compaction?.covers_to_seq ?? 0;

    const rows = this.db
      .prepare(
        "SELECT message FROM transcript WHERE conversation_id = ? AND seq > ? " +
          "AND superseded_by IS NULL ORDER BY seq",
      )
      .all(conversationId, coversTo) as { message: string }[];

    return {
      summary: compaction?.summary,
      messages: rows.map((r) => JSON.parse(r.message) as TranscriptMessage),
    };
  }

  /**
   * Record a compaction: the summary replaces every message with
   * seq <= coversToSeq, which are marked superseded (kept for replay).
   */
  recordCompaction(conversationId: string, summary: string, coversToSeq: number): void {
    this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO compactions (conversation_id, summary, covers_to_seq, created_at) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(conversationId, summary, coversToSeq, Date.now());
      this.db
        .prepare(
          "UPDATE transcript SET superseded_by = ? WHERE conversation_id = ? AND seq <= ? " +
            "AND superseded_by IS NULL",
        )
        .run(lastInsertRowid, conversationId, coversToSeq);
    })();
  }

  close(): void {
    this.db.close();
  }
}
