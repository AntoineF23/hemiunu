// HemiTool port of the hemiunu-prototype server (prototype.ts
// createPrototypeServer). Handler unchanged; only the wrapper changes.

import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { resolveGithubToken, resolveRepo } from "../github";
import { openExternal } from "../open";
import { savePrototype } from "../prototype";
import { ensureCloned } from "../workspace";
import { defineTool, ok } from "./helpers";

export function createPrototypeTools(): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-prototype__save_prototype",
      description:
        "Write a self-contained wireframe/prototype into the current prototype workspace (flat — index.html at the root, alongside PROTOTYPE.md) and show it to the user as a live, interactive preview. Pass one or more files by relative path including an index.html entry point. Use for low-fi HTML wireframes grounded in the brief — grayscale boxes, real labels/content, no brand styling.",
      inputSchema: z.object({
        files: z
          .array(
            z.object({
              path: z
                .string()
                .describe(
                  "Path relative to the prototype root, e.g. 'index.html' or 'assets/app.css'.",
                ),
              content: z.string().describe("Full file contents."),
            }),
          )
          .describe("Files to write. Include an index.html entry point."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ files }) {
        try {
          // With a team selected, make sure its workspace is a real git checkout
          // BEFORE writing — otherwise the files land in a bare dir that can't be
          // pushed ("fatal: not a git repository") and gets clobbered by a later
          // sync. No team → the local session folder needs no git.
          const repo = resolveRepo();
          if (repo) {
            const ready = await ensureCloned(repo, { token: resolveGithubToken() });
            if (ready.action === "failed") {
              return ok(
                `Couldn't prepare the ${repo} workspace to save into: ${ready.note ?? "clone failed"}. Check the GitHub connection (/github), then try again.`,
              );
            }
          }
          const saved = savePrototype({ files });
          if (saved.indexPath) openExternal(saved.indexPath); // no-op when HEMIUNU_NO_OPEN
          // In the web app (HEMIUNU_NO_OPEN) the preview is embedded inline as a
          // live artifact the user sees in the chat — so the agent must NOT claim
          // a browser tab opened, nor paste a text/ASCII mock as a substitute.
          const inline = !!process.env.HEMIUNU_NO_OPEN;
          const text = !saved.indexPath
            ? `Saved ${saved.files.length} file(s) to ${saved.dir}, but no index.html — add one so it can be previewed.`
            : inline
              ? `Saved ${saved.files.length} file(s) to ${saved.dir}. The live, interactive prototype is now shown to the user right here in the chat — refer to it as the preview above. Do NOT tell them to open a browser or a localhost link, and do NOT paste a text/ASCII version: the real thing is already on screen.`
              : `Saved ${saved.files.length} file(s) to ${saved.dir}; opened ${saved.indexPath} in the browser for the user.`;
          return ok(text);
        } catch (e) {
          return ok(`Failed to save prototype: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    }),
  ];
}
