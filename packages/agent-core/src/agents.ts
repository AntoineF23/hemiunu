import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import { slugify } from "./prototype";
import { SUBAGENT_NAMES } from "./subagents";

/**
 * User-defined subagents — each a Markdown file under ~/.hemiunu/agents/<name>.md
 * with frontmatter (name, description, optional model) and the system prompt as
 * the body. They're registered alongside the built-in subagents so the main
 * agent can summon them by description (see agent.ts). Reasoning-only for now
 * (no tools); the user owns the prompt and the model.
 */

export interface CustomAgentMeta {
  /** Slug used as the agent id the coordinator delegates to. */
  name: string;
  /** When to summon it — the discovery surface the main agent matches against. */
  description: string;
  /** Model id to run it on; falls back to the main model when unset. */
  model?: string;
  path: string;
}
export interface CustomAgent extends CustomAgentMeta {
  /** The agent's system prompt (the file body). */
  prompt: string;
}

function agentsDir(root: string): string {
  return join(root, "agents");
}

/** Names a custom agent may not take — the coordinator + the built-in subagents. */
const RESERVED = new Set<string>(["main", ...SUBAGENT_NAMES]);

/** Whether `name` is a built-in agent (not a user-defined one). */
export function isBuiltinAgent(name: string): boolean {
  return RESERVED.has(name);
}

export function listCustomAgents(root: string = configDir()): CustomAgentMeta[] {
  const dir = agentsDir(root);
  if (!existsSync(dir)) return [];
  const out: CustomAgentMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const { meta } = parseFrontmatter(readFileSync(path, "utf8"));
    out.push({
      name: slugify(meta.name || entry.slice(0, -3)),
      description: meta.description ?? "",
      model: meta.model || undefined,
      path,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadCustomAgent(name: string, root: string = configDir()): CustomAgent | undefined {
  const slug = slugify(name);
  const path = join(agentsDir(root), `${slug}.md`);
  if (!existsSync(path)) return undefined;
  const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
  return {
    name: slug,
    description: meta.description ?? "",
    model: meta.model || undefined,
    prompt: body,
    path,
  };
}

export interface SaveCustomAgentOptions {
  name: string;
  description: string;
  model?: string;
  prompt: string;
  root?: string;
}

/** Create or replace a user-defined subagent. */
export function saveCustomAgent({
  name,
  description,
  model,
  prompt,
  root = configDir(),
}: SaveCustomAgentOptions): CustomAgentMeta {
  const slug = slugify(name);
  if (!slug) throw new Error("An agent name is required.");
  if (RESERVED.has(slug)) throw new Error(`'${slug}' is a built-in agent — choose another name.`);
  const dir = agentsDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  writeFileSync(
    path,
    renderFrontmatter({ name: slug, description, model: model || undefined }, prompt),
    "utf8",
  );
  return { name: slug, description, model: model || undefined, path };
}

export function deleteCustomAgent(name: string, root: string = configDir()): boolean {
  const path = join(agentsDir(root), `${slugify(name)}.md`);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
