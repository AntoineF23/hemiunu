// Remembers which prototype a conversation produced, so resuming it from
// history can re-serve the files and show the artifact again. The live preview
// URL is ephemeral (random port, dies with the worker), so we persist the
// durable thing — the prototype DIRECTORY — keyed by conversation (SDK session)
// id, and restart a preview from it on demand.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "@hemiunu/agent-core";

export interface ArtifactRecord {
  /** Absolute directory the prototype was served from. */
  dir: string;
  /** The team repo, or null for a local prototype. */
  repo: string | null;
  title: string;
}

function storePath(): string {
  return join(configDir(), "web-artifacts.json");
}

function load(): Record<string, ArtifactRecord> {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, ArtifactRecord>;
  } catch {
    return {};
  }
}

export function recordArtifact(conversationId: string, rec: ArtifactRecord): void {
  const store = load();
  store[conversationId] = rec;
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function getArtifact(conversationId: string): ArtifactRecord | null {
  return load()[conversationId] ?? null;
}

export function removeArtifact(conversationId: string): void {
  const store = load();
  if (!(conversationId in store)) return;
  delete store[conversationId];
  writeFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
