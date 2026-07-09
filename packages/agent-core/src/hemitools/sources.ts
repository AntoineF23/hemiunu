// HemiTool port of the hemiunu-sources server (sources.ts
// createSourcesServer). Handlers unchanged; only wrappers change. Both tools
// are auto-approved — they only touch ~/.hemiunu/sources (local & low-risk).

import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { configDir } from "../config";
import { loadSourceMap, saveSourceMap } from "../sources";
import { defineTool, ok } from "./helpers";

export function createSourcesTools(root: string = configDir()): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-sources__save_source_map",
      description:
        "Save (create or replace) the source map for an MCP server — a durable note of what's inside it: its structure, the ids of key pages/databases with one-line summaries, and how to query it. Use this after scanning a source, or when you notice during normal work that an existing map is out of date (correct or remove only facts you can verify are wrong; leave anything you can't confirm unchanged).",
      inputSchema: z.object({
        mcp: z.string().describe("The MCP server name, e.g. 'filesystem'."),
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
      }),
      permission: "auto",
      readOnly: false,
      async execute({ mcp, description, body }) {
        const s = saveSourceMap({ mcp, description, body, root });
        return ok(`Saved source map for ${s.mcp} (${s.path}).`);
      },
    }),
    defineTool({
      name: "mcp__hemiunu-sources__get_source_map",
      description:
        "Read the full source map for an MCP server (structure, key page/db ids + summaries, how to query) — consult this before searching a source so you know where to look.",
      inputSchema: z.object({
        mcp: z.string().describe("The MCP server name, e.g. 'filesystem'."),
      }),
      permission: "auto",
      readOnly: true,
      async execute({ mcp }) {
        const m = loadSourceMap(mcp, root);
        if (!m) return ok(`No source map for '${mcp}' yet. Suggest the user run /scan ${mcp}.`);
        return ok(
          `---\nmcp: ${m.mcp}\ndescription: ${m.description}${m.scanned ? `\nscanned: ${m.scanned}` : ""}\n---\n\n${m.body}`,
        );
      },
    }),
  ];
}
