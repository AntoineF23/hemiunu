import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listTeams } from "./github";

/**
 * Agent → CLI control channel. Some actions (creating/switching a team) change
 * UI-owned state — the footer, the active conversation, the workspace — which an
 * in-process MCP tool can't set directly. So the tool emits a request and the
 * CLI (which registered a handler) performs it and returns a result. This
 * mirrors the CLI ← agent direction we already have via onSubagentEvent.
 */

export type ControlEvent =
  | { type: "create-team"; name: string }
  | { type: "switch-team"; repo: string }
  | { type: "rename-team"; name: string };

type ControlHandler = (e: ControlEvent) => Promise<string>;

let handler: ControlHandler | null = null;

/** The CLI registers (and clears) the handler that performs control requests. */
export function setControlHandler(h: ControlHandler | null): void {
  handler = h;
}

/** Ask the CLI to perform a control action; returns a human-readable result. */
export async function requestControl(e: ControlEvent): Promise<string> {
  if (!handler) return "No interactive session is available to do that.";
  try {
    return await handler(e);
  } catch (err) {
    return `Couldn't complete that: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * In-process MCP server for the no-team onboarding flow: let the agent create a
 * team repo, switch into an existing team, or list teams — driving the CLI so
 * the footer/conversation/workspace stay consistent.
 */
export function createTeamControlServer() {
  const createTool = tool(
    "create_team",
    "Create a new private team repo for the current work and switch into it (keeping this conversation). Use when the user has no team and wants this feature to have its own repo. Name it after the feature, short kebab-case.",
    {
      name: z
        .string()
        .describe("Short kebab-case repo name derived from the request, e.g. 'churn-dashboard'."),
    },
    async ({ name }) => ({
      content: [{ type: "text", text: await requestControl({ type: "create-team", name }) }],
    }),
    { annotations: { title: "Create team", readOnlyHint: false } },
  );

  const switchTool = tool(
    "switch_team",
    "Switch the current work into one of the user's existing teams (call list_teams first to see them). Use when the user has no team and wants to work inside an existing one.",
    { repo: z.string().describe("The team repo to switch to, as owner/name.") },
    async ({ repo }) => ({
      content: [{ type: "text", text: await requestControl({ type: "switch-team", repo }) }],
    }),
    { annotations: { title: "Switch team", readOnlyHint: false } },
  );

  const listTool = tool(
    "list_teams",
    "List the user's existing teams (repos), e.g. to offer them as a choice.",
    {},
    async () => {
      const teams = listTeams();
      return {
        content: [{ type: "text", text: teams.length ? teams.join("\n") : "(no teams yet)" }],
      };
    },
    { annotations: { title: "List teams", readOnlyHint: true } },
  );

  const renameTool = tool(
    "rename_team",
    "Rename the CURRENT team — renames its GitHub repo (the owner is unchanged), updates the saved team, and moves the local working copy. Use when the user wants this team/feature named differently. Confirm the new name with the user first; pass a short kebab-case name.",
    {
      name: z.string().describe("New short kebab-case repo name, e.g. 'adaptive-safety-floor'."),
    },
    async ({ name }) => ({
      content: [{ type: "text", text: await requestControl({ type: "rename-team", name }) }],
    }),
    { annotations: { title: "Rename team", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-team-control",
    version: "0.0.0",
    tools: [createTool, switchTool, listTool, renameTool],
  });
}

/** Tool-availability wildcard for the team-control server. */
export const TEAM_CONTROL_TOOLS = "mcp__hemiunu-team-control__*";
