// HemiTool port of the hemiunu-prototype-knowledge server (prototypes.ts
// createPrototypeKnowledgeServer). Handlers unchanged; only wrappers change.

import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import {
  addPrototypeNote,
  getPrototypeKnowledge,
  updatePrototype,
  type NoteKind,
} from "../prototypes";
import { defineTool, ok } from "./helpers";

export function createPrototypeKnowledgeTools(): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-prototype-knowledge__add_prototype_note",
      description:
        "Append a durable note to THIS feature's PROTOTYPE.md (at the root of the current team's repo). Use proactively, on your own, whenever you learn something durable about the feature — a research finding, a decision + rationale ('decision'), an open question ('question'), user/stakeholder feedback ('feedback'), or anything else ('note'). Saved to GitHub and attributed to the signed-in user. This file is managed only through these tools — never use the filesystem to find or edit it.",
      inputSchema: z.object({
        kind: z.enum(["decision", "question", "feedback", "note"]).describe("Kind of entry."),
        text: z.string().describe("The note, in one clear line."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ kind, text }) {
        return ok(await addPrototypeNote(kind as NoteKind, text));
      },
    }),
    defineTool({
      name: "mcp__hemiunu-prototype-knowledge__get_prototype",
      description:
        "Read THIS feature's PROTOTYPE.md (repo root of the current team) — its goal, sources, decisions, open questions. Read it before improving it.",
      inputSchema: z.object({}),
      permission: "ask",
      readOnly: true,
      async execute() {
        return ok(await getPrototypeKnowledge());
      },
    }),
    defineTool({
      name: "mcp__hemiunu-prototype-knowledge__update_prototype",
      description:
        "Replace THIS feature's PROTOTYPE.md with an improved/restructured version (repo root). First read it with get_prototype, then pass the full improved Markdown body (frontmatter is handled for you). Use to organize accumulated knowledge into a clean brief.",
      inputSchema: z.object({
        content: z.string().describe("The full improved PROTOTYPE.md body (Markdown sections)."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ content }) {
        return ok(await updatePrototype(content));
      },
    }),
  ];
}
