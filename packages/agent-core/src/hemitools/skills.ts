// HemiTool port of the hemiunu-skills server (skills.ts createSkillsServer).
// Handlers unchanged; only wrappers change.

import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { configDir } from "../config";
import { loadSkill, loadSkills, saveSkill } from "../skills";
import { defineTool, ok } from "./helpers";

export function createSkillsTools(root: string = configDir()): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-skills__save_skill",
      description:
        "Create or replace a reusable skill (a saved procedure the user can later run as /<name>). Write clear step-by-step instructions in the body; use $ARGUMENTS where the user's input should be inserted. Only do this when the user asks to save/create/update a skill.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("Short kebab-case command name, e.g. 'weekly-report'. Becomes the /command."),
        description: z
          .string()
          .describe(
            "One line: what the skill does and when to use it (this is how it's discovered).",
          ),
        body: z
          .string()
          .describe(
            "The skill instructions in Markdown. Put $ARGUMENTS where the user's input goes.",
          ),
        argument_hint: z
          .string()
          .optional()
          .describe("Optional hint for the expected argument(s), e.g. '[week]'."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ name, description, body, argument_hint }) {
        try {
          const s = saveSkill({ name, description, body, argumentHint: argument_hint, root });
          return ok(`Saved skill /${s.name} (${s.path}). The user can run it with /${s.name}.`);
        } catch (e) {
          return ok(e instanceof Error ? e.message : String(e));
        }
      },
    }),
    defineTool({
      name: "mcp__hemiunu-skills__list_skills",
      description: "List the user's saved skills with their descriptions.",
      inputSchema: z.object({}),
      permission: "ask",
      readOnly: true,
      async execute() {
        const list = loadSkills(root);
        return ok(
          list.length
            ? list.map((s) => `/${s.name} — ${s.description}`).join("\n")
            : "(no skills saved yet)",
        );
      },
    }),
    defineTool({
      name: "mcp__hemiunu-skills__get_skill",
      description:
        "Read a saved skill's full Markdown (frontmatter + body) — use this to follow a skill yourself, or before editing one with save_skill.",
      inputSchema: z.object({
        name: z.string().describe("The skill's command name, e.g. 'weekly-report'."),
      }),
      permission: "ask",
      readOnly: true,
      async execute({ name }) {
        const s = loadSkill(name, root);
        if (!s) return ok(`No skill named '${name}'.`);
        return ok(`---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}`);
      },
    }),
  ];
}
