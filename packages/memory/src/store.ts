import Database, { type Database as DatabaseType } from "better-sqlite3";

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  model: string;
}

export interface MessageRow {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  ts: string;
  cost_usd: number | null;
}

/** SQLite-backed store persisting full conversations (list / resume / replay). */
export class ConversationStore {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        model      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        ts              TEXT NOT NULL,
        cost_usd        REAL
      );
      CREATE TABLE IF NOT EXISTS folder_trust (
        path       TEXT PRIMARY KEY,
        allowed    INTEGER NOT NULL,
        decided_at TEXT NOT NULL
      );
    `);
  }

  /** Remembered file-access decision for a folder (undefined = never asked). */
  getFolderTrust(path: string): boolean | undefined {
    const row = this.db.prepare("SELECT allowed FROM folder_trust WHERE path = ?").get(path) as
      | { allowed?: number }
      | undefined;
    return row ? row.allowed === 1 : undefined;
  }

  setFolderTrust(path: string, allowed: boolean): void {
    this.db
      .prepare(
        "INSERT INTO folder_trust (path, allowed, decided_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET allowed = excluded.allowed, decided_at = excluded.decided_at",
      )
      .run(path, allowed ? 1 : 0, new Date().toISOString());
  }

  /** Insert a conversation if it doesn't already exist (id = SDK session id). */
  ensureConversation(id: string, title: string, model: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO conversations (id, title, created_at, model) VALUES (?, ?, ?, ?)",
      )
      .run(id, title, new Date().toISOString(), model);
  }

  /** Replace a conversation's title (e.g. with an LLM-generated one). */
  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  addMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    costUsd: number | null = null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO messages (conversation_id, role, content, ts, cost_usd) VALUES (?, ?, ?, ?, ?)",
      )
      .run(conversationId, role, content, new Date().toISOString(), costUsd);
  }

  listConversations(limit = 20): ConversationRow[] {
    return this.db
      .prepare(
        "SELECT id, title, created_at, model FROM conversations ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as unknown as ConversationRow[];
  }

  getMessages(conversationId: string): MessageRow[] {
    return this.db
      .prepare(
        "SELECT id, conversation_id, role, content, ts, cost_usd FROM messages WHERE conversation_id = ? ORDER BY id ASC",
      )
      .all(conversationId) as unknown as MessageRow[];
  }

  close(): void {
    this.db.close();
  }
}
