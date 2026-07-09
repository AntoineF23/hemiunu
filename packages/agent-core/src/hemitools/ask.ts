// HemiTool port of the hemiunu-ask server (ask.ts createAskServer).
// Handler unchanged; only the SDK tool() wrapper is replaced.

import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { requestControl } from "../control";
import { defineTool, ok } from "./helpers";

/** `ask_user` — asking the user IS the action; never gate it behind a
 *  "may I ask?" prompt (auto-approved by every front-end). */
export function createAskTools(): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-ask__ask_user",
      description:
        "Ask the user 1–4 multiple-choice questions and wait for their answer before continuing. Use ONLY when you genuinely need the user to decide between options (design direction, scope, an ambiguous request) — not for things you can reasonably assume. Each question has a short `header` (a chip label), the `question` text (end with a question mark), and 2–4 `options`, each a concise `label` plus a one-line `description` of its trade-off. Returns the user's selection(s).",
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              question: z.string().describe("The full question, ending in a question mark."),
              header: z.string().describe("Very short chip label, e.g. 'Approach' or 'Scope'."),
              options: z
                .array(
                  z.object({
                    label: z.string().describe("Concise choice text (1–5 words)."),
                    description: z
                      .string()
                      .optional()
                      .describe("One line on what this choice means / its trade-off."),
                  }),
                )
                .min(2)
                .max(4)
                .describe("2–4 mutually-exclusive choices."),
            }),
          )
          .min(1)
          .max(4)
          .describe("1–4 questions to ask."),
      }),
      permission: "auto",
      readOnly: true,
      async execute({ questions }) {
        return ok(await requestControl({ type: "ask-user", questions }));
      },
    }),
  ];
}
