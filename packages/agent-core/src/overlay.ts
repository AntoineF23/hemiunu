import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import { slugify } from "./prototype";

/**
 * The user "overlay" layer — per-user memory that merges OVER the shipped
 * defaults, all under ~/.hemiunu/context/:
 *
 *   context/attachments/<slug>.md   user context files, each attached (via the
 *                                   `agents:` frontmatter) to one or more agents
 *                                   and injected into their system prompt.
 *   context/knowledge/<name>.md     a user OVERRIDE of a shipped knowledge pack
 *                                   (context/knowledge/<name>.md in the install
 *                                   dir). Present → used instead of the original;
 *                                   delete → the shipped original is restored.
 *
 * soul.md stays a view-only shipped asset: rather than edit it, the user adds a
 * context file attached to `main`. This is additive — with no overlay dir the
 * agent behaves exactly as before.
 */

/** Install dir (committed assets: soul.md, knowledge/, templates). */
function appRoot(): string {
  return process.env.HEMIUNU_HOME ?? process.cwd();
}
function overlayDir(root: string): string {
  return join(root, "context");
}
function attachmentsDir(root: string): string {
  return join(overlayDir(root), "attachments");
}
function knowledgeOverrideDir(root: string): string {
  return join(overlayDir(root), "knowledge");
}
function shippedKnowledgeDir(): string {
  return join(appRoot(), "context", "knowledge");
}
/** Strip anything that could escape the knowledge dir; names are controlled. */
function safeName(name: string): string {
  return name.replace(/[^a-z0-9-]/gi, "");
}

// ---- attachments: user context files attached to agents ---------------------

export interface AttachmentMeta {
  slug: string;
  title: string;
  description: string;
  /** Agent names this file is injected into; "*"/"all" = every agent. */
  agents: string[];
  path: string;
}
export interface Attachment extends AttachmentMeta {
  body: string;
}

function parseAgents(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** All user context files (metadata only), sorted by title. */
export function listAttachments(root: string = configDir()): AttachmentMeta[] {
  const dir = attachmentsDir(root);
  if (!existsSync(dir)) return [];
  const out: AttachmentMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const { meta } = parseFrontmatter(readFileSync(path, "utf8"));
    const slug = entry.slice(0, -3);
    out.push({
      slug,
      title: meta.title || slug,
      description: meta.description ?? "",
      agents: parseAgents(meta.agents),
      path,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Load one context file (metadata + body), or undefined. */
export function loadAttachment(slug: string, root: string = configDir()): Attachment | undefined {
  const s = slugify(slug);
  const path = join(attachmentsDir(root), `${s}.md`);
  if (!existsSync(path)) return undefined;
  const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
  return {
    slug: s,
    title: meta.title || s,
    description: meta.description ?? "",
    agents: parseAgents(meta.agents),
    body,
    path,
  };
}

/** Context files injected into `agent`'s prompt ("*"/"all" matches every agent). */
export function attachmentsFor(agent: string, root: string = configDir()): Attachment[] {
  const a = agent.toLowerCase();
  return listAttachments(root)
    .filter((m) => m.agents.includes(a) || m.agents.includes("*") || m.agents.includes("all"))
    .map((m) => loadAttachment(m.slug, root))
    .filter((x): x is Attachment => Boolean(x));
}

/** Formatted prompt section of an agent's attached context (or "" if none). */
export function attachmentsBlock(agent: string, root: string = configDir()): string {
  const items = attachmentsFor(agent, root);
  if (!items.length) return "";
  const body = items.map((a) => `## ${a.title}\n${a.body}`).join("\n\n");
  return `\n\n# Attached context\nUser-provided context attached to you:\n\n${body}`;
}

export interface SaveAttachmentOptions {
  slug?: string;
  title: string;
  description?: string;
  agents: string[];
  body: string;
  root?: string;
}

/** Create or replace a context file. Slug derives from the explicit slug or title. */
export function saveAttachment({
  slug,
  title,
  description = "",
  agents,
  body,
  root = configDir(),
}: SaveAttachmentOptions): AttachmentMeta {
  const s = slugify(slug || title);
  if (!s) throw new Error("A title (or slug) is required.");
  const dir = attachmentsDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${s}.md`);
  const text = renderFrontmatter(
    { title, description: description || undefined, agents: agents.join(", ") },
    body,
  );
  writeFileSync(path, text, "utf8");
  return { slug: s, title, description, agents, path };
}

/** Delete a context file. Returns false if it didn't exist. */
export function deleteAttachment(slug: string, root: string = configDir()): boolean {
  const path = join(attachmentsDir(root), `${slugify(slug)}.md`);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

// ---- knowledge overrides ----------------------------------------------------

/** A user override body for a knowledge pack, or "" if none is set. */
export function knowledgeDoc(name: string, root: string = configDir()): string {
  const path = join(knowledgeOverrideDir(root), `${safeName(name)}.md`);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/** Whether the user has overridden a knowledge pack. */
export function hasKnowledgeOverride(name: string, root: string = configDir()): boolean {
  return existsSync(join(knowledgeOverrideDir(root), `${safeName(name)}.md`));
}

/** The shipped (original) knowledge pack body, from the install dir. */
export function shippedKnowledge(name: string): string {
  const path = join(shippedKnowledgeDir(), `${safeName(name)}.md`);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/** Save a user override for a knowledge pack. */
export function saveKnowledgeOverride(
  name: string,
  body: string,
  root: string = configDir(),
): string {
  const dir = knowledgeOverrideDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeName(name)}.md`);
  writeFileSync(path, `${body.trim()}\n`, "utf8");
  return path;
}

/** Revert: drop the override so the shipped original is used again. */
export function deleteKnowledgeOverride(name: string, root: string = configDir()): boolean {
  const path = join(knowledgeOverrideDir(root), `${safeName(name)}.md`);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Shipped knowledge pack names (slugs), excluding the README. */
export function listShippedKnowledge(): string[] {
  const dir = shippedKnowledgeDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -3))
    .sort();
}

// ---- persona + global user memory (raw reads for the panel) -----------------

/** The persona file (view-only shipped asset). */
export function readSoul(): string {
  const path = join(appRoot(), "context", "soul.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function userMemoryPath(root: string): string {
  return join(root, "user.md");
}

/** The global per-user memory (user.md). */
export function readUserMemory(root: string = configDir()): string {
  const path = userMemoryPath(root);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Replace user.md wholesale (the panel's edit-and-save). */
export function writeUserMemory(content: string, root: string = configDir()): string {
  const path = userMemoryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return path;
}
