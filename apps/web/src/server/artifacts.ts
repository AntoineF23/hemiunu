// Remembers which prototype a conversation produced, so resuming it from
// history can re-serve the files and show the artifact again. The live preview
// URL is ephemeral (random port, dies with the worker), so we persist the
// durable thing — the prototype DIRECTORY — keyed by conversation (SDK session)
// id, and restart a preview from it on demand.
//
// The store is held in memory and persisted with a debounced async write:
// recordArtifact is called from inside the live turn's streaming loop, where a
// synchronous read-modify-write of the JSON file per event would block the
// single-threaded worker. Entries are capped (oldest evicted) so the file can't
// grow unbounded across months of conversations.
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "@hemiunu/agent-core";

export interface ArtifactRecord {
  /** Absolute directory the prototype was served from. */
  dir: string;
  /** The team repo, or null for a local prototype. */
  repo: string | null;
  title: string;
}

/** Keep the most recent N conversations' artifacts; older ones are evicted. */
const MAX_ENTRIES = 200;
const FLUSH_DEBOUNCE_MS = 250;

function storePath(): string {
  return join(configDir(), "web-artifacts.json");
}

// Map preserves insertion order → the first key is the oldest entry.
let store: Map<string, ArtifactRecord> | null = null;

function loaded(): Map<string, ArtifactRecord> {
  if (store) return store;
  try {
    const obj = JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, ArtifactRecord>;
    store = new Map(Object.entries(obj));
  } catch {
    store = new Map();
  }
  return store;
}

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const snapshot = `${JSON.stringify(Object.fromEntries(loaded()), null, 2)}\n`;
    try {
      mkdirSync(configDir(), { recursive: true });
    } catch {
      /* flush below will surface the real failure */
    }
    void writeFile(storePath(), snapshot, "utf8").catch((e) => {
      console.error(`couldn't persist web-artifacts.json: ${e instanceof Error ? e.message : e}`);
    });
  }, FLUSH_DEBOUNCE_MS);
  // Don't hold the process open just to flush a bookkeeping file.
  flushTimer.unref?.();
}

export function recordArtifact(conversationId: string, rec: ArtifactRecord): void {
  const s = loaded();
  // Re-insert so the entry moves to the "newest" end of the Map's order.
  s.delete(conversationId);
  s.set(conversationId, rec);
  while (s.size > MAX_ENTRIES) {
    const oldest = s.keys().next().value;
    if (oldest === undefined) break;
    s.delete(oldest);
  }
  scheduleFlush();
}

export function getArtifact(conversationId: string): ArtifactRecord | null {
  return loaded().get(conversationId) ?? null;
}

export function removeArtifact(conversationId: string): void {
  const s = loaded();
  if (!s.delete(conversationId)) return;
  scheduleFlush();
}
