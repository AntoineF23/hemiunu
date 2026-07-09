import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import { slugify } from "./prototype";

/**
 * User-level reusable skills. Each skill is a Markdown file with the canonical
 * Claude "SKILL.md" structure — YAML frontmatter (name + description, the
 * description being the discovery surface the agent matches against) followed by
 * the instruction body. Stored per-user under ~/.hemiunu/skills, so they persist
 * across sessions and projects. Two shapes are supported:
 *   skills/<name>.md            (flat — the common case)
 *   skills/<name>/SKILL.md      (directory — for skills that bundle files)
 *
 * Progressive disclosure: loadSkills() returns only the lightweight metadata
 * (always cheap to surface to the model); the full body is read on demand by
 * loadSkill() when a skill is actually invoked.
 */

/** Lightweight metadata for discovery (no body). */
export interface SkillMeta {
  /** Slug / slash-command name, e.g. "weekly-report". */
  name: string;
  /** One line: what it does + when to use it. Drives discovery. */
  description: string;
  /** Optional hint shown for the expected argument(s). */
  argumentHint?: string;
  /** Absolute path to the skill's Markdown file. */
  path: string;
}

/** A fully-loaded skill (metadata + instruction body). */
export interface Skill extends SkillMeta {
  body: string;
}

export interface SaveSkillOptions {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  /** Root the skills/ dir lives under (defaults to the per-user config dir). */
  root?: string;
}

export interface SavedSkill {
  name: string;
  path: string;
}

/** Built-in CLI command names a skill may not shadow. */
const RESERVED = new Set([
  "new",
  "clear",
  "compact",
  "models",
  "setup",
  "trust",
  "list",
  "resume",
  "mcp",
  "mcp-auth",
  "help",
  "exit",
  "quit",
  "skills",
  "skill",
  "github",
  "cloudflare",
  "team",
  "team-new",
  "team-rename",
  "team-add",
  "team-remove",
  "restore",
  "settings",
]);

/** The per-user skills directory. */
export function skillsDir(root: string = configDir()): string {
  return join(root, "skills");
}

/** Render a skill to canonical SKILL.md text. */
function render(
  meta: { name: string; description: string; argumentHint?: string },
  body: string,
): string {
  return renderFrontmatter(
    { name: meta.name, description: meta.description, "argument-hint": meta.argumentHint },
    body,
  );
}

function metaFrom(meta: Record<string, string>, nameBase: string, path: string): SkillMeta {
  return {
    name: slugify(meta.name || nameBase),
    description: meta.description ?? "",
    argumentHint: meta["argument-hint"],
    path,
  };
}

/** List all saved skills' metadata (sorted by name). Body is NOT read here. */
export function loadSkills(root: string = configDir()): SkillMeta[] {
  const dir = skillsDir(root);
  if (!existsSync(dir)) return [];
  const out: SkillMeta[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let file: string | undefined;
    let nameBase: string | undefined;
    if (entry.endsWith(".md") && statSync(full).isFile()) {
      file = full;
      nameBase = entry.slice(0, -3);
    } else if (statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"))) {
      file = join(full, "SKILL.md");
      nameBase = entry;
    }
    if (!file || !nameBase) continue;
    const { meta } = parseFrontmatter(readFileSync(file, "utf8"));
    out.push(metaFrom(meta, nameBase, file));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load ONE skill (metadata + body), read fresh from disk so hand-edits to the
 * file take effect immediately — no restart or cache. Returns undefined if the
 * skill doesn't exist. Accepts the flat `<name>.md` or `<name>/SKILL.md` form.
 */
export function loadSkill(name: string, root: string = configDir()): Skill | undefined {
  const slug = slugify(name);
  const dir = skillsDir(root);
  const file = [join(dir, `${slug}.md`), join(dir, slug, "SKILL.md")].find((p) => existsSync(p));
  if (!file) return undefined;
  const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
  return { ...metaFrom(meta, slug, file), body };
}

/**
 * Create or replace a skill. The name is slugified into the file name; names
 * that collide with built-in commands are rejected. Always writes the flat
 * `<name>.md` form.
 */
export function saveSkill({
  name,
  description,
  body,
  argumentHint,
  root = configDir(),
}: SaveSkillOptions): SavedSkill {
  const slug = slugify(name);
  if (RESERVED.has(slug)) {
    throw new Error(`'${slug}' is a reserved command name — choose a different skill name.`);
  }
  const dir = skillsDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  writeFileSync(path, render({ name: slug, description, argumentHint }, body), "utf8");
  return { name: slug, path };
}

/**
 * Delete a skill by name (either the flat `<name>.md` or the `<name>/SKILL.md`
 * directory form). Returns false if it didn't exist. Reserved names can't be
 * created, so they never reach here.
 */
export function deleteSkill(name: string, root: string = configDir()): boolean {
  const slug = slugify(name);
  const dir = skillsDir(root);
  const flat = join(dir, `${slug}.md`);
  const nested = join(dir, slug, "SKILL.md");
  if (existsSync(flat)) {
    rmSync(flat);
    return true;
  }
  if (existsSync(nested)) {
    rmSync(dirname(nested), { recursive: true, force: true }); // drop the whole skill dir
    return true;
  }
  return false;
}

/**
 * Expand a skill body for execution: substitute `$ARGUMENTS` (all args) and
 * `$1`, `$2`, … (positional). If the body has no placeholder and args were
 * given, append them so a "do X to <input>" skill still receives its input.
 */
export function expandSkill(skill: Skill, args: string): string {
  const trimmed = args.trim();
  const argv = trimmed ? trimmed.split(/\s+/) : [];
  const hadPlaceholder = /\$ARGUMENTS\b|\$\d+/.test(skill.body);
  let body = skill.body
    .replace(/\$ARGUMENTS\b/g, trimmed)
    .replace(/\$(\d+)/g, (_, n: string) => argv[Number(n) - 1] ?? "");
  if (!hadPlaceholder && trimmed) body += `\n\n${trimmed}`;
  return body.trim();
}

/** Tool-availability wildcard for the skills server. */
export const SKILL_TOOLS = "mcp__hemiunu-skills__*";
