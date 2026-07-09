// The /scan flow on the ENGINE loop: run the scanner subagent for one MCP
// server in its OWN isolated, ephemeral context (research tier), scoped to that
// server's tools + the hemiunu-sources tools. This replaces the SDK-era
// query()-based runScan in sources.ts — same prompt, same reconcile semantics,
// same auto-approve model (the user typing /scan is the gate; a persistent
// policy "block" still wins via the wired pipeline).

import {
  createPipeline,
  loadModelRegistry,
  McpHost,
  modelForTag,
  resolveModel,
} from "@hemiunu/engine";
import { createSourcesTools } from "./hemitools/sources";
import { runTurn } from "@hemiunu/engine";
import { mcpOAuthHeaders } from "./mcp-oauth";
import { createHemiPipelineConfig } from "./pipeline-wiring";
import { loadSourceMap } from "./sources";
import { slugify } from "./prototype";
import { serverOf } from "./toolpolicy";

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

/** Everything runScan needs. */
export interface ScanOptions {
  /** The MCP server name to scan, e.g. "filesystem". */
  mcp: string;
  /** Connected MCP servers (from the registry) — must include the target. */
  mcpServers?: Record<string, unknown>;
  /** Per-tool-call progress (the scanner's MCP/save calls), for CLI visibility. */
  onTool?: (toolName: string) => void;
}

/**
 * Run the scanner subagent for one MCP server on the engine loop (research-
 * tagged model), scoped to that server's tools + the sources tools. Tools are
 * auto-approved — the user typing /scan is the gate (matching the parallel
 * sub-run permission model); a persistent policy "block" still refuses via the
 * pipeline. Returns the scanner's final summary text.
 */
export async function runScan(opts: ScanOptions): Promise<string> {
  const registry = loadModelRegistry();
  const modelId = modelForTag("research", registry, registry[0].id).id;
  const resolvedModel = resolveModel(modelId, registry);
  const existing = loadSourceMap(opts.mcp)?.body;
  const target = slugify(opts.mcp);

  // Connect ONLY the target server; its tools + the sources tools are the
  // scanner's whole surface (mirroring the SDK-era allowedTools scope).
  const serverCfg = opts.mcpServers?.[opts.mcp] ?? opts.mcpServers?.[target];
  const host = new McpHost({
    servers: serverCfg ? { [opts.mcp]: serverCfg } : {},
    headers: mcpOAuthHeaders,
  });
  try {
    const mcpTools = (await host.listTools()).filter(
      (t) => serverOf(t.name) === opts.mcp || serverOf(t.name) === target,
    );
    const tools = [...mcpTools, ...createSourcesTools()];
    const executor = createPipeline(createHemiPipelineConfig({ tools, autoAccept: true }));

    let text = "";
    for await (const e of runTurn({
      prompt: scanInstruction(opts.mcp, existing),
      systemPrompt: SCANNER_PROMPT,
      resolvedModel,
      tools,
      executor,
      // Deliberately NO transcript: the scan's history is ephemeral.
    })) {
      if (e.type === "tool-start") opts.onTool?.(e.name);
      if (e.type === "turn-finish") text = e.text;
    }
    return text;
  } finally {
    await host.close();
  }
}
