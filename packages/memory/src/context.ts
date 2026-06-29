import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AgentContext {
  /** Persona — a committed app asset (context/soul.md, ships with the code). */
  soul: string;
  /** Global per-user memory — facts about the USER, carried across all projects. */
  user: string;
}

const DEFAULT_SOUL =
  "You are Hemiunu, a product agent for a product team. Be professional and concise, with simple, precise vocabulary. Answer directly; if you lack information, say so in one line.";

/** Persona file, relative to the app/install dir. */
const SOUL_FILE = join("context", "soul.md");
/** Global per-user memory file (in the user data dir) + its committed template. */
const USER_FILE = "user.md";
const USER_TEMPLATE = join("context", "user.md.example");

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/**
 * Where the context's two pieces live. soul.md ships with the app; user.md is
 * the GLOBAL per-user memory in the user data dir (~/.hemiunu). Both default to
 * `appRoot` so a single-dir caller (e.g. a test) works with no roots passed.
 *
 * NOTE: there is deliberately no per-folder ("launch directory") memory here —
 * feature/project knowledge lives in the team's PROTOTYPE.md (see the prototypes
 * module), which is team-aware and never writes into an unrelated launch folder.
 */
export interface ContextRoots {
  /** Install dir — committed assets (soul.md, knowledge/, templates). */
  appRoot?: string;
  /** Per-user data dir (e.g. ~/.hemiunu) — the global user.md. */
  userRoot?: string;
}

function resolveRoots(r: ContextRoots): Required<ContextRoots> {
  const appRoot = r.appRoot ?? process.cwd();
  return { appRoot, userRoot: r.userRoot ?? appRoot };
}

/** Load soul.md (persona, appRoot) + the global user.md (userRoot). */
export function loadContext(r: ContextRoots = {}): AgentContext {
  const { appRoot, userRoot } = resolveRoots(r);
  return {
    soul: read(join(appRoot, SOUL_FILE)) || DEFAULT_SOUL,
    user: read(join(userRoot, USER_FILE)),
  };
}

/**
 * How the running prototype preview reaches the user differs by surface, so the
 * agent must know which it's on: the web app embeds it INLINE (no link to give);
 * the CLI has no display, so the localhost URL is the only way to see it and the
 * agent SHOULD share it on request. Keyed on HEMIUNU_NO_OPEN (set by the web).
 */
function previewSurfaceNote(): string {
  return process.env.HEMIUNU_NO_OPEN
    ? 'PREVIEW SURFACE — you are in the Hemiunu APP, which embeds the live prototype preview INLINE in the chat. Refer to it as "the preview above"; there is NO separate localhost link to give (the user already sees it), so don\'t surface a URL or tell them to open a browser.'
    : "PREVIEW SURFACE — you are in a TERMINAL (CLI) with no inline display: the live prototype preview runs in the user's browser at a localhost URL. When they ask to see it or for the link, GIVE them that localhost URL — it's in the result of save_prototype / iterate_prototype (shown as \"Live preview: http://localhost:PORT\"). Never claim there is no link, and never paste an ASCII/text mock as a substitute.";
}

/** Assemble the system prompt: persona + (global facts about the user) + surface note. */
export function buildSystemPrompt(ctx: AgentContext): string {
  const parts = [ctx.soul];
  if (ctx.user) parts.push(`\n\n## What you know about the user\n${ctx.user}`);
  parts.push(`\n\n## Showing the prototype\n${previewSurfaceNote()}`);
  return parts.join("");
}

/**
 * Append a durable USER-global note (the `remember` tool) to user.md in
 * `userRoot` (the agent's core, ~/.hemiunu) — never the launch folder. This is
 * only for facts about the user themselves; feature/project facts go to the
 * team's PROTOTYPE.md via the prototypes module.
 */
export function remember(note: string, userRoot: string = process.cwd()): void {
  const file = join(userRoot, USER_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n- ${note.trim()}`, "utf8");
}

/**
 * Seed the global per-user memory on first run: copy the committed
 * `context/user.md.example` template (from appRoot) to `user.md` in the user
 * data dir (userRoot) if it's missing, so the file starts present but blank.
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
