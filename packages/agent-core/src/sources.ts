import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool, query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { configDir, loadConfig } from "./config";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import { slugify } from "./prototype";
import { createToolCapHook } from "./toolcap";

/**
 * Per-MCP "source maps" — a per-user memory of what lives inside each connected
 * MCP server (Notion, filesystem, …). Each map is a Markdown file with flat
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
  /** The MCP server name this maps, e.g. "notion". */
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
    if (!entry.endsWith(".md") || !statSync(full).isFile()) continue;
    const { meta } = parseFrontmatter(readFileSync(full, "utf8"));
    out.push(metaFrom(meta, entry.slice(0, -3), full));
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

/** Today's date as YYYY-MM-DD (local). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
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
    renderFrontmatter({ mcp: slug, description, scanned: today() }, body),
    "utf8",
  );
  return { mcp: slug, path };
}

/**
 * In-process MCP server exposing source-map read/write to any agent:
 *   save_source_map — write/replace a map (used by /scan and proactive updates)
 *   get_source_map  — read a map's full Markdown on demand (progressive disclosure)
 */
export function createSourcesServer(root: string = configDir()) {
  const saveTool = tool(
    "save_source_map",
    "Save (create or replace) the source map for an MCP server — a durable note of what's inside it: its structure, the ids of key pages/databases with one-line summaries, and how to query it. Use this after scanning a source, or when you notice during normal work that an existing map is out of date (correct or remove only facts you can verify are wrong; leave anything you can't confirm unchanged).",
    {
      mcp: z.string().describe("The MCP server name, e.g. 'notion' or 'filesystem'."),
      description: z
        .string()
        .describe(
          "One line: what's inside this source and at what access level. This is the discovery surface other agents see.",
        ),
      body: z
        .string()
        .describe(
          "The full map in Markdown: overview, key locations (with page/db ids + one-line summaries), and how to query.",
        ),
    },
    async ({ mcp, description, body }) => {
      const s = saveSourceMap({ mcp, description, body, root });
      return { content: [{ type: "text", text: `Saved source map for ${s.mcp} (${s.path}).` }] };
    },
    { annotations: { title: "Save source map", readOnlyHint: false } },
  );

  const getTool = tool(
    "get_source_map",
    "Read the full source map for an MCP server (structure, key page/db ids + summaries, how to query) — consult this before searching a source so you know where to look.",
    { mcp: z.string().describe("The MCP server name, e.g. 'notion'.") },
    async ({ mcp }) => {
      const m = loadSourceMap(mcp, root);
      if (!m) {
        return {
          content: [
            {
              type: "text",
              text: `No source map for '${mcp}' yet. Suggest the user run /scan ${mcp}.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `---\nmcp: ${m.mcp}\ndescription: ${m.description}${m.scanned ? `\nscanned: ${m.scanned}` : ""}\n---\n\n${m.body}`,
          },
        ],
      };
    },
    { annotations: { title: "Get source map", readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "hemiunu-sources",
    version: "0.0.0",
    tools: [saveTool, getTool],
  });
}

/** System prompt for the scanner subagent (runs on the cheap retrieval tier). */
export const SCANNER_PROMPT = `You are Hemiunu's source-scanner subagent. You are given ONE connected MCP server to map. Your job is to explore it and produce a reusable "source map" — a durable note of what lives inside it so any agent can later find information fast, without re-discovering the structure.

How to work:
- Use ONLY the tools of the named MCP server to explore (list/search/read its top-level structure, databases, key pages, folders). Run several calls — don't stop at the first result — but stay efficient; you are mapping structure, not reading everything.
- The map reflects only what THIS user can see (their access level). Note that access level in the description if relevant.
- Capture: a short overview of what the source is good for; the KEY locations (databases, top pages, important folders) each with its **id or path** and a ONE-LINE summary; and brief "how to query" tips (which tool + arguments to reach things).
- Record real ids/paths and real titles — never invent them. If something is empty or inaccessible, say so plainly rather than guessing.

Finish by calling save_source_map with: the mcp name, a one-line description (what's inside + access level), and the full map as Markdown. Then reply to the coordinator in one line with what you mapped. Do not address the end user directly.`;

/**
 * The per-scan instruction. When a map already exists it's embedded so the scan
 * RECONCILES rather than blindly overwrites: update changed facts, delete facts
 * that are no longer true, and KEEP anything the source can't confirm or deny
 * (this preserves human-added notes).
 */
export function scanInstruction(mcp: string, existing?: string): string {
  const base = `Scan the "${mcp}" MCP server and build (or refresh) its source map. Explore its structure with the ${mcp} tools, then save the map with save_source_map.`;
  if (!existing) return base;
  return `${base}

A previous map already exists (below). RECONCILE it with what you find now:
- Update facts that have changed (renamed/moved pages, new key databases, new ids).
- DELETE facts you can verify are no longer true.
- KEEP unchanged anything you cannot confirm or deny from the source itself — including human-written notes. When in doubt, leave it.

--- current map ---
${existing}
--- end current map ---`;
}

/** Everything runScan needs, beyond what loadConfig() provides. */
export interface ScanOptions {
  /** The MCP server name to scan, e.g. "notion". */
  mcp: string;
  /** Connected MCP servers (from the registry) — must include the target. */
  mcpServers?: Record<string, unknown>;
  /** Per-tool-call progress (the scanner's MCP/save calls), for CLI visibility. */
  onTool?: (toolName: string) => void;
}

/**
 * Run the scanner subagent for one MCP server in its OWN isolated context (same
 * shape as runSubagent) on the cheap retrieval tier, scoped to that server's
 * tools + the sources server. Tools are auto-approved — the user typing /scan is
 * the gate (matching the parallel sub-run permission model). Returns the
 * scanner's final summary text.
 */
export async function runScan(opts: ScanOptions): Promise<string> {
  const cfg = loadConfig();
  const existing = loadSourceMap(opts.mcp)?.body;
  const tools = [`mcp__${slugify(opts.mcp)}__*`, SOURCE_TOOLS];
  let text = "";
  for await (const m of query({
    prompt: scanInstruction(opts.mcp, existing),
    options: {
      model: cfg.researchModel,
      thinking: cfg.thinking,
      systemPrompt: SCANNER_PROMPT,
      hooks: createToolCapHook(),
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: cfg.apiKey,
        ...(cfg.baseUrl ? { ANTHROPIC_BASE_URL: cfg.baseUrl } : {}),
      } as Record<string, string>,
      mcpServers: {
        ...(opts.mcpServers ?? {}),
        "hemiunu-sources": createSourcesServer(),
      } as Options["mcpServers"],
      tools,
      allowedTools: tools,
    },
  })) {
    const msg = m as Record<string, any>;
    if (opts.onTool && msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use" && typeof b.name === "string") opts.onTool(b.name);
      }
    }
    if (msg.type === "result" && typeof msg.result === "string") text = msg.result;
  }
  return text;
}
