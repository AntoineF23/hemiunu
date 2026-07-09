// HemiTool port of the hemiunu-share server (share.ts createShareServer).
// Handlers (and the announcePublish helper) unchanged; only wrappers change.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { discoveryLine, recordDiscovery } from "../atlas";
import { hasControlHandler, requestControl } from "../control";
import { activeProvider } from "../deploy";
import { githubViewer, resolveGithubToken, resolveRepo } from "../github";
import { commitAndPush, workspacePath } from "../workspace";
import { defineTool, ok } from "./helpers";

/**
 * Record the Atlas discovery for a publish-to-main and surface it. We PUSH the
 * announcement to the front-end via the control bridge rather than return it as
 * tool text — prose tool results get filtered out of the chat. Fall back to the
 * tool text only when nobody's listening (headless).
 */
async function announcePublish(repo: string, published: string): Promise<string> {
  const result = recordDiscovery(repo);
  const line = discoveryLine(result);
  const m = result.monument;
  if (hasControlHandler()) {
    await requestControl({
      type: "discovery",
      line,
      monumentId: m.id,
      name: m.name,
      tier: result.tier,
    });
    // The discovery was already shown to the user — tell the model not to repeat it.
    return `${published}\n\n(The Atlas discovery has been shown to the user — don't restate it.)`;
  }
  return `${published}\n\n${line}`;
}

export function createShareTools(): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-share__commit_prototype",
      description:
        "Save the current prototype's changes to its repo: stage, commit, and push. to='checkpoint' pushes a branch you can review/preview; to='main' publishes to the default branch and clears the local workspace. Always confirm with the user before pushing to main.",
      inputSchema: z.object({
        message: z.string().describe("Commit message summarizing the changes."),
        to: z
          .enum(["checkpoint", "main"])
          .describe("Where to push: a checkpoint branch, or main (done)."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ message, to }) {
        const repo = resolveRepo();
        if (!repo) return ok("No team selected — pick one (/team) first.");
        const token = resolveGithubToken();
        if (!token) return ok("Not signed in to GitHub — run /github.");
        // Must be a real checkout, not just an existing dir — otherwise git can't
        // commit it. save_prototype/iterate_prototype both prepare one.
        if (!existsSync(join(workspacePath(repo), ".git")))
          return ok(
            `The workspace for ${repo} isn't set up yet — save the prototype again (it now prepares the repo) or run iterate_prototype, then commit.`,
          );
        const login = (await githubViewer(token)) ?? undefined;
        const r = await commitAndPush(repo, { message, token, login, toMain: to === "main" });
        if (!r.ok) return ok(r.note);
        if (to === "main") {
          // Keep the workspace and the live preview — publishing is a checkpoint,
          // not the end. The user can keep iterating right where they are.
          const published = `Published to ${r.branch}. Your workspace stays open — keep iterating and publish again whenever you're ready. To also put it online, use deploy_prototype.`;
          return ok(await announcePublish(repo, published));
        }
        return ok(`${r.note}. Share it online with deploy_prototype.`);
      },
    }),
    defineTool({
      name: "mcp__hemiunu-share__deploy_prototype",
      description:
        "Publish AND share the current prototype in one step: pushes the work to the repo's main branch, then deploys it to a stable, shareable URL (the same link updates in place on each deploy). Use ONLY once the user has validated their changes and wants a link to send around — ask first. If no deploy provider is connected, the result explains how — relay it to the user rather than retrying.",
      inputSchema: z.object({
        message: z.string().describe("Short commit message summarizing the changes being shipped."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ message }) {
        const repo = resolveRepo();
        if (!repo) return ok("No team selected — pick one (/team) first.");
        const token = resolveGithubToken();
        if (!token) return ok("Not signed in to GitHub — run /github.");
        const dir = workspacePath(repo);
        if (!existsSync(join(dir, ".git")))
          return ok(
            `The workspace for ${repo} isn't set up yet — save the prototype again or run iterate_prototype, then deploy.`,
          );
        // Check the share target BEFORE publishing, so "deploy" is atomic: it
        // either ships + shares, or tells the user to connect a provider first —
        // never a surprise publish they can't get a link for.
        const provider = activeProvider();
        if (!provider) return ok("No deploy provider configured (set HEMIUNU_DEPLOY_PROVIDER).");
        if (!provider.isConfigured()) return ok(provider.connectHint());

        // 1. Publish to main. (commitAndPush rebases onto latest main and keeps
        // the workspace, so we can build & deploy straight from it.)
        const login = (await githubViewer(token)) ?? undefined;
        const r = await commitAndPush(repo, { message, token, login, toMain: true });
        if (!r.ok) return ok(r.note);

        // 2. Deploy the workspace to the stable shareable URL.
        const d = await provider.deploy(dir, { repo });
        let outcome: string;
        if ("url" in d) {
          const note = d.pending
            ? ` (the link is still finishing setup — DNS + its SSL certificate; for the first minute or two it may show "can't provide a secure connection", so tell the user to wait ~1–2 min and reload)`
            : "";
          outcome = `Published to ${r.branch} and deployed online. Give the user this clickable shareable link: ${d.url}${note}`;
        } else if (d.needsLogin) {
          outcome = `Published to ${r.branch}, but the share link couldn't be created: ${provider.connectHint()}`;
        } else {
          outcome = `Published to ${r.branch}, but the deploy failed: ${d.error}`;
        }
        // The publish itself succeeded either way — award the Atlas discovery.
        return ok(await announcePublish(repo, outcome));
      },
    }),
  ];
}
