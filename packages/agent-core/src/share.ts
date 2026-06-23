import { existsSync } from "node:fs";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { githubViewer, resolveGithubToken, resolveRepo } from "./github";
import { stopPreview } from "./preview";
import { vercelDeploy } from "./vercel";
import { commitAndPush, discardWorkspace, workspacePath } from "./workspace";

/**
 * Sharing a prototype: commit + push the local workspace to its repo, and
 * (on demand) deploy it to a shareable Vercel URL. The agent should reach for
 * these only when the user wants to save/share — see the persona.
 */

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function createShareServer() {
  const commitTool = tool(
    "commit_prototype",
    "Save the current prototype's changes to its repo: stage, commit, and push. to='checkpoint' pushes a branch you can review/preview; to='main' publishes to the default branch and clears the local workspace. Always confirm with the user before pushing to main.",
    {
      message: z.string().describe("Commit message summarizing the changes."),
      to: z.enum(["checkpoint", "main"]).describe("Where to push: a checkpoint branch, or main (done)."),
    },
    async ({ message, to }) => {
      const repo = resolveRepo();
      if (!repo) return text("No team selected — pick one (/team) first.");
      const token = resolveGithubToken();
      if (!token) return text("Not signed in to GitHub — run /github.");
      if (!existsSync(workspacePath(repo))) return text("No local workspace — run iterate_prototype first.");
      const login = (await githubViewer(token)) ?? undefined;
      const r = await commitAndPush(repo, { message, token, login, toMain: to === "main" });
      if (!r.ok) return text(r.note);
      if (to === "main") {
        const binned = discardWorkspace(repo, "pushed to main");
        stopPreview();
        return text(
          `Pushed to ${r.branch} and cleared the local workspace${binned ? " (a snapshot is in the recycle bin)" : ""}. Next iteration re-syncs from the latest.`,
        );
      }
      return text(`${r.note}. Open a PR for it, or share a preview with deploy_prototype.`);
    },
    { annotations: { title: "Commit prototype", readOnlyHint: false } },
  );

  const deployTool = tool(
    "deploy_prototype",
    "Deploy the current prototype to a shareable Vercel URL. Use ONLY when the user wants to share it (ask first). prod=true for the production URL, else a preview. If Vercel isn't connected, the result explains how — relay it to the user rather than retrying.",
    { prod: z.boolean().optional().describe("Deploy to production (default: a preview URL).") },
    async ({ prod }) => {
      const repo = resolveRepo();
      if (!repo) return text("No team selected — pick one (/team) first.");
      const dir = workspacePath(repo);
      if (!existsSync(dir)) return text("No local workspace — run iterate_prototype first.");
      const r = await vercelDeploy(dir, { prod });
      if ("url" in r) return text(`Deployed${prod ? " to production" : ""}: ${r.url}`);
      if (r.notInstalled) return text(r.error);
      if (r.needsLogin)
        return text(
          "Not connected to Vercel. Ask the user to run /vercel <token> (recommended — no browser) or `vercel login`, then try again.",
        );
      return text(`Deploy failed: ${r.error}`);
    },
    { annotations: { title: "Deploy prototype", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-share",
    version: "0.0.0",
    tools: [commitTool, deployTool],
  });
}

/** Tool-availability wildcard for the share server. */
export const SHARE_TOOLS = "mcp__hemiunu-share__*";
