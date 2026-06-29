import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Tier } from "./atlas";
import { explainError } from "./explain";
import {
  addCollaborator,
  currentTeam,
  listTeams,
  removeCollaborator,
  repoAccess,
  resolveGithubToken,
  resolveRepo,
} from "./github";
import { currentWorkspace } from "./workspace-context";

/**
 * Add a teammate as a collaborator on the current team's repo. Shared by the
 * /team-add CLI command and the add_teammate tool, so both behave identically.
 */
export async function addTeammate(username: string): Promise<string> {
  const name = username.trim().replace(/^@/, "");
  if (!name) return "Give a GitHub username to add.";
  const repo = resolveRepo();
  if (!repo) return "No team selected — pick one with /team first.";
  const token = resolveGithubToken();
  if (!token) return "Not signed in to GitHub — run /github.";
  const r = await addCollaborator(token, repo, name);
  if ("error" in r) return `Couldn't add ${name}: ${explainError(r.error)}`;
  return r.status === "invited"
    ? `Invited ${name} to ${repo} — they'll get a GitHub invitation to accept.`
    : `Added ${name} to ${repo} with write access.`;
}

/**
 * Remove a teammate from the current team's repo. Only the repo OWNER (admin
 * rights) may do this — otherwise it refuses with a clear message.
 */
export async function removeTeammate(username: string): Promise<string> {
  const name = username.trim().replace(/^@/, "");
  if (!name) return "Give a GitHub username to remove.";
  const repo = resolveRepo();
  if (!repo) return "No team selected — pick one with /team first.";
  const token = resolveGithubToken();
  if (!token) return "Not signed in to GitHub — run /github.";
  const access = await repoAccess(token, repo);
  if ("error" in access)
    return `Couldn't check your rights on ${repo}: ${explainError(access.error)}`;
  if (!access.admin)
    return `You need owner (admin) rights on ${repo} to remove someone — ask the repo owner to do it.`;
  const r = await removeCollaborator(token, repo, name);
  if ("error" in r) return `Couldn't remove ${name}: ${explainError(r.error)}`;
  return `Removed ${name} from ${repo}.`;
}

/**
 * Agent → CLI control channel. Some actions (creating/switching a team) change
 * UI-owned state — the footer, the active conversation, the workspace — which an
 * in-process MCP tool can't set directly. So the tool emits a request and the
 * CLI (which registered a handler) performs it and returns a result. This
 * mirrors the CLI ← agent direction we already have via onSubagentEvent.
 */

/** One multiple-choice question the agent asks the user via the `ask_user` tool. */
export interface AskQuestion {
  /** The full question, ending in a question mark. */
  question: string;
  /** A short chip/tag label for the question (e.g. "Approach", "Scope"). */
  header: string;
  /** 2–4 mutually-exclusive choices (label + a one-line trade-off description). */
  options: { label: string; description?: string }[];
}

export type ControlEvent =
  | { type: "create-team"; name: string }
  | { type: "switch-team"; repo: string }
  | { type: "rename-team"; name: string }
  // Ask the user 1–4 multiple-choice questions and block until they answer. The
  // front-end renders a chooser and returns the selection(s) as a string.
  | { type: "ask-user"; questions: AskQuestion[] }
  // Announce a monument earned by publishing to main. Pushed (not returned as
  // tool text — that gets filtered out of the chat) so each front-end can render
  // a proper message with a link into the Atlas.
  | {
      type: "discovery";
      /** The ready-to-show, tier-specific announcement line. */
      line: string;
      /** The monument's catalog id — for building the Atlas deep link. */
      monumentId: string;
      /** Monument name + tier, for richer rendering. */
      name: string;
      tier: Tier;
    };

type ControlHandler = (e: ControlEvent) => Promise<string>;

let handler: ControlHandler | null = null;

/** The front-end registers (and clears) the handler that performs control requests. */
export function setControlHandler(h: ControlHandler | null): void {
  handler = h;
}

/** Whether an interactive front-end is listening — lets a tool fall back to its
 *  text result when there's nobody to push a message to (e.g. headless runs). */
export function hasControlHandler(): boolean {
  return handler !== null;
}

/** Ask the CLI to perform a control action; returns a human-readable result. */
export async function requestControl(e: ControlEvent): Promise<string> {
  if (!handler) return "No interactive session is available to do that.";
  try {
    const result = await handler(e);
    // create/switch/rename just changed the GLOBAL current team. Retarget the
    // LIVE turn's workspace binding to match, so the REST of this turn (its
    // activeProtoDir, commit_prototype, the recorded artifact) writes to the new
    // repo instead of the one bound at turn start — otherwise files built after
    // the team is created keep landing in the local folder. The binding is shared
    // by reference, so mutating .repo is seen by resolveRepo() immediately.
    const ws = currentWorkspace();
    const team = currentTeam();
    if (ws && team) ws.repo = team;
    return result;
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

  const addTeammateTool = tool(
    "add_teammate",
    "Add a teammate to the CURRENT team by their GitHub username — gives them write access to the repo (for org/private repos GitHub sends an invitation to accept). Use when the user asks to add or invite someone.",
    { username: z.string().describe("The teammate's GitHub username.") },
    async ({ username }) => ({
      content: [{ type: "text", text: await addTeammate(username) }],
    }),
    { annotations: { title: "Add teammate", readOnlyHint: false } },
  );

  const removeTeammateTool = tool(
    "remove_teammate",
    "Remove a teammate from the CURRENT team by their GitHub username. Only works if the user has owner (admin) rights on the repo; otherwise it explains they can't. Confirm with the user before removing someone.",
    { username: z.string().describe("The teammate's GitHub username.") },
    async ({ username }) => ({
      content: [{ type: "text", text: await removeTeammate(username) }],
    }),
    { annotations: { title: "Remove teammate", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-team-control",
    version: "0.0.0",
    tools: [createTool, switchTool, listTool, renameTool, addTeammateTool, removeTeammateTool],
  });
}

/** Tool-availability wildcard for the team-control server. */
export const TEAM_CONTROL_TOOLS = "mcp__hemiunu-team-control__*";
