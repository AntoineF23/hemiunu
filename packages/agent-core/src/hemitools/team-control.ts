// HemiTool port of the hemiunu-team-control server (control.ts
// createTeamControlServer). Handlers unchanged; only the wrappers change.

import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { addTeammate, removeTeammate, requestControl } from "../control";
import { listTeams } from "../github";
import { defineTool, ok } from "./helpers";

export function createTeamControlTools(): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-team-control__create_team",
      description:
        "Create a new private team repo for the current work and switch into it (keeping this conversation). Use when the user has no team and wants this feature to have its own repo. Name it after the feature, short kebab-case.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("Short kebab-case repo name derived from the request, e.g. 'churn-dashboard'."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ name }) {
        return ok(await requestControl({ type: "create-team", name }));
      },
    }),
    defineTool({
      name: "mcp__hemiunu-team-control__switch_team",
      description:
        "Switch the current work into one of the user's existing teams (call list_teams first to see them). Use when the user has no team and wants to work inside an existing one.",
      inputSchema: z.object({
        repo: z.string().describe("The team repo to switch to, as owner/name."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ repo }) {
        return ok(await requestControl({ type: "switch-team", repo }));
      },
    }),
    defineTool({
      name: "mcp__hemiunu-team-control__list_teams",
      description: "List the user's existing teams (repos), e.g. to offer them as a choice.",
      inputSchema: z.object({}),
      permission: "ask",
      readOnly: true,
      async execute() {
        const teams = listTeams();
        return ok(teams.length ? teams.join("\n") : "(no teams yet)");
      },
    }),
    defineTool({
      name: "mcp__hemiunu-team-control__rename_team",
      description:
        "Rename the CURRENT team — renames its GitHub repo (the owner is unchanged), updates the saved team, and moves the local working copy. Use when the user wants this team/feature named differently. Confirm the new name with the user first; pass a short kebab-case name.",
      inputSchema: z.object({
        name: z.string().describe("New short kebab-case repo name, e.g. 'adaptive-safety-floor'."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ name }) {
        return ok(await requestControl({ type: "rename-team", name }));
      },
    }),
    defineTool({
      name: "mcp__hemiunu-team-control__add_teammate",
      description:
        "Add a teammate to the CURRENT team by their GitHub username — gives them write access to the repo (for org/private repos GitHub sends an invitation to accept). Use when the user asks to add or invite someone.",
      inputSchema: z.object({
        username: z.string().describe("The teammate's GitHub username."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ username }) {
        return ok(await addTeammate(username));
      },
    }),
    defineTool({
      name: "mcp__hemiunu-team-control__remove_teammate",
      description:
        "Remove a teammate from the CURRENT team by their GitHub username. Only works if the user has owner (admin) rights on the repo; otherwise it explains they can't. Confirm with the user before removing someone.",
      inputSchema: z.object({
        username: z.string().describe("The teammate's GitHub username."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ username }) {
        return ok(await removeTeammate(username));
      },
    }),
  ];
}
