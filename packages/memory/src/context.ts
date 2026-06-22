import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

export interface AgentContext {
  soul: string;
  user: string;
  memory: string;
}

export type MemoryTarget = "user" | "memory";

const DEFAULT_SOUL =
  "You are Hemiunu, a product agent for a product team. Be professional and concise, with simple, precise vocabulary. Answer directly; if you lack information, say so in one line.";

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

export function contextDir(root: string = process.cwd()): string {
  return join(root, "context");
}

/** Load soul.md / user.md / memory.md from the context/ directory. */
export function loadContext(root: string = process.cwd()): AgentContext {
  const dir = contextDir(root);
  return {
    soul: read(join(dir, "soul.md")) || DEFAULT_SOUL,
    user: read(join(dir, "user.md")),
    memory: read(join(dir, "memory.md")),
  };
}

/** Assemble the system prompt: soul + (learned user facts) + (durable memory). */
export function buildSystemPrompt(ctx: AgentContext): string {
  const parts = [ctx.soul];
  if (ctx.user) parts.push(`\n\n## What you know about the user\n${ctx.user}`);
  if (ctx.memory) parts.push(`\n\n## Durable memory\n${ctx.memory}`);
  return parts.join("");
}

/** Append a durable note to user.md or memory.md (used by the `remember` tool). */
export function remember(
  target: MemoryTarget,
  note: string,
  root: string = process.cwd(),
): void {
  const dir = contextDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, target === "user" ? "user.md" : "memory.md");
  appendFileSync(file, `\n- ${note.trim()}`, "utf8");
}
