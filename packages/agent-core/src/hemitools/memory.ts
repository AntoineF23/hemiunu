// HemiTool port of the hemiunu-memory server (tools.ts createMemoryServer).
// Handler unchanged; only the SDK tool() wrapper is replaced.

import { remember } from "@hemiunu/memory";
import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { configDir } from "../config";
import { defineTool, ok } from "./helpers";

/** `remember` — global facts about the USER. Auto-approved (transparent,
 *  low-risk: it only appends to the user's memory file). */
export function createMemoryTools(userRoot: string = configDir()): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-memory__remember",
      description:
        "Save a durable fact about the USER (their role, team, stable preferences) — global, kept across ALL their projects. Do NOT use this for facts about the current feature/project/product (target users, decisions, research findings) — use add_prototype_note for those, so they stay with the right feature.",
      inputSchema: z.object({ note: z.string() }),
      permission: "auto",
      readOnly: false,
      async execute({ note }) {
        remember(note, userRoot);
        return ok("Saved to your global user memory.");
      },
    }),
  ];
}
