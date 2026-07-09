import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";
import { todayISO } from "./date";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import { slugify } from "./prototype";

/**
 * Per-MCP "source maps" — a per-user memory of what lives inside each connected
 * MCP server (filesystem, and any others the user adds). Each map is a Markdown file with flat
 * frontmatter (mcp + a one-line description, the discovery surface) and a body
 * holding the server's structure, the ids of key pages/databases with one-line
 * summaries, and how to query it. What's visible depends on the USER's access
 * rights, so these are per-user, stored under ~/.hemiunu/sources/<mcp>.md.
 *
 * Progressive disclosure (same as skills): loadSourceMaps() returns only the
 * lightweight frontmatter to surface to the agent every turn; the full map is
 * read on demand with get_source_map. The files are plain Markdown the user can
 * also edit by hand.
 */

/** Lightweight metadata for discovery (no body). */
export interface SourceMapMeta {
  /** The MCP server name this maps, e.g. "filesystem". */
  mcp: string;
  /** One line: what's inside this source + at what access level. */
  description: string;
  /** ISO date (YYYY-MM-DD) of the last scan, if recorded. */
  scanned?: string;
  /** Absolute path to the map's Markdown file. */
  path: string;
}

/** A fully-loaded source map (metadata + body). */
export interface SourceMap extends SourceMapMeta {
  body: string;
}

export interface SaveSourceMapOptions {
  mcp: string;
  description: string;
  body: string;
  /** Root the sources/ dir lives under (defaults to the per-user config dir). */
  root?: string;
}

/** Tool-availability wildcard for the sources server. */
export const SOURCE_TOOLS = "mcp__hemiunu-sources__*";
export const SAVE_SOURCE_MAP_TOOL_ID = "mcp__hemiunu-sources__save_source_map";
export const GET_SOURCE_MAP_TOOL_ID = "mcp__hemiunu-sources__get_source_map";

/** The per-user source-maps directory. */
export function sourceMapsDir(root: string = configDir()): string {
  return join(root, "sources");
}

function metaFrom(meta: Record<string, string>, nameBase: string, path: string): SourceMapMeta {
  return {
    mcp: slugify(meta.mcp || nameBase),
    description: meta.description ?? "",
    scanned: meta.scanned || undefined,
    path,
  };
}

/** List all source maps' metadata (sorted by mcp). Body is NOT read here. */
export function loadSourceMaps(root: string = configDir()): SourceMapMeta[] {
  const dir = sourceMapsDir(root);
  if (!existsSync(dir)) return [];
  const out: SourceMapMeta[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (!entry.endsWith(".md") || !statSync(full).isFile()) continue;
      const { meta } = parseFrontmatter(readFileSync(full, "utf8"));
      out.push(metaFrom(meta, entry.slice(0, -3), full));
    } catch {
      // Skip one unreadable/corrupt map rather than losing every map.
    }
  }
  return out.sort((a, b) => a.mcp.localeCompare(b.mcp));
}

/**
 * Load ONE source map (metadata + body), read fresh from disk so hand-edits to
 * the file take effect immediately — no restart or cache. Returns undefined if
 * no map exists for that server.
 */
export function loadSourceMap(mcp: string, root: string = configDir()): SourceMap | undefined {
  const slug = slugify(mcp);
  const file = join(sourceMapsDir(root), `${slug}.md`);
  if (!existsSync(file)) return undefined;
  const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
  return { ...metaFrom(meta, slug, file), body };
}

/** Delete a source map by mcp name (slugified to the filename). False if absent. */
export function deleteSourceMap(mcp: string, root: string = configDir()): boolean {
  const file = join(sourceMapsDir(root), `${slugify(mcp)}.md`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** Create or replace a source map. The mcp name is slugified into the filename. */
export function saveSourceMap({
  mcp,
  description,
  body,
  root = configDir(),
}: SaveSourceMapOptions): { mcp: string; path: string } {
  const slug = slugify(mcp);
  const dir = sourceMapsDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  writeFileSync(
    path,
    renderFrontmatter({ mcp: slug, description, scanned: todayISO() }, body),
    "utf8",
  );
  return { mcp: slug, path };
}
