import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface AgentContext {
  /** Persona — a committed app asset (context/soul.md, ships with the code). */
  soul: string;
  /** Global per-user memory — facts about the user, carried across all projects. */
  user: string;
  /** Per-project memory — the agent's notes about the launch folder (HEMIUNU.md). */
  memory: string;
}

export type MemoryTarget = "user" | "memory";

const DEFAULT_SOUL =
  "You are Hemiunu, a product agent for a product team. Be professional and concise, with simple, precise vocabulary. Answer directly; if you lack information, say so in one line.";

/** Persona file, relative to the app/install dir. */
const SOUL_FILE = join("context", "soul.md");
/** Global per-user memory file (in the user data dir) + its committed template. */
const USER_FILE = "user.md";
const USER_TEMPLATE = join("context", "user.md.example");
/** Per-project memory file — at the root of the launch folder (CLAUDE.md-style). */
export const PROJECT_MEMORY_FILE = "HEMIUNU.md";

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/**
 * The three independent homes the context is assembled from. Each defaults to
 * `appRoot` (which defaults to cwd), so a single-directory caller — e.g. a test
 * that drops every file in one temp dir — still works with no roots passed.
 */
export interface ContextRoots {
  /** Install dir — committed assets (soul.md, knowledge/, templates). */
  appRoot?: string;
  /** Per-user data dir (e.g. ~/.hemiunu) — the global user.md. */
  userRoot?: string;
  /** Launch folder — the per-project HEMIUNU.md. */
  projectRoot?: string;
}

function resolveRoots(r: ContextRoots): Required<ContextRoots> {
  const appRoot = r.appRoot ?? process.cwd();
  return {
    appRoot,
    userRoot: r.userRoot ?? appRoot,
    projectRoot: r.projectRoot ?? appRoot,
  };
}

/**
 * Load the agent's context from its three homes:
 * - soul.md    — persona, ships with the app (appRoot)
 * - user.md    — global per-user memory, in the user data dir (userRoot)
 * - HEMIUNU.md — per-project memory, in the launch folder (projectRoot)
 *
 * Reads and the `remember` writes target the same paths, so memory is consistent
 * across sessions and independent of which folder hemiunu was launched in.
 */
export function loadContext(r: ContextRoots = {}): AgentContext {
  const { appRoot, userRoot, projectRoot } = resolveRoots(r);
  return {
    soul: read(join(appRoot, SOUL_FILE)) || DEFAULT_SOUL,
    user: read(join(userRoot, USER_FILE)),
    memory: read(join(projectRoot, PROJECT_MEMORY_FILE)),
  };
}

/** Assemble the system prompt: soul + (global user facts) + (this project's notes). */
export function buildSystemPrompt(ctx: AgentContext): string {
  const parts = [ctx.soul];
  if (ctx.user) parts.push(`\n\n## What you know about the user\n${ctx.user}`);
  if (ctx.memory) parts.push(`\n\n## Notes on this project\n${ctx.memory}`);
  return parts.join("");
}

/**
 * Append a durable note (used by the `remember` tool):
 * - target 'user'   → the global per-user memory (user.md in `userRoot`)
 * - target 'memory' → this project's notes (HEMIUNU.md in `projectRoot`, the
 *   launch folder) — like a CLAUDE.md, scoped to the folder you're working in.
 * The file (and its directory) is created on demand.
 */
export function remember(
  target: MemoryTarget,
  note: string,
  r: ContextRoots = {},
): void {
  const { userRoot, projectRoot } = resolveRoots(r);
  const file =
    target === "user"
      ? join(userRoot, USER_FILE)
      : join(projectRoot, PROJECT_MEMORY_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n- ${note.trim()}`, "utf8");
}

/**
 * Seed the global per-user memory on first run: copy the committed
 * `context/user.md.example` template (from appRoot) to `user.md` in the user
 * data dir (userRoot) if it's missing, so the file starts present but blank.
 * Per-project HEMIUNU.md is deliberately NOT seeded — it's created lazily the
 * first time the agent saves a project note, so launching in a folder you only
 * pass through never litters it with an empty memory file.
 */
export function seedContextFiles(r: ContextRoots = {}): void {
  const { appRoot, userRoot } = resolveRoots(r);
  const live = join(userRoot, USER_FILE);
  const template = join(appRoot, USER_TEMPLATE);
  if (!existsSync(live) && existsSync(template)) {
    mkdirSync(dirname(live), { recursive: true });
    copyFileSync(template, live);
  }
}
