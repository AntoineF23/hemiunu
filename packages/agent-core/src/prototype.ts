import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveGithubToken, resolveRepo } from "./github";
import { activeProtoDir, ensureCloned } from "./workspace";

export interface PrototypeFile {
  /** Path relative to the prototype dir, e.g. "index.html". */
  path: string;
  content: string;
}

export interface SavePrototypeOptions {
  files: PrototypeFile[];
  /** Dir to write into (flat). Defaults to the active prototype dir. */
  dir?: string;
}

export interface SavedPrototype {
  dir: string;
  files: string[];
  /** The entry point to open (index.html if present, else the first file). */
  indexPath?: string;
  url?: string;
}

/** Filesystem-safe, bounded kebab-case slug for a prototype folder name. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "prototype"
  );
}

/**
 * Write prototype files FLAT into the active prototype dir (the team workspace
 * or the local session folder) — so the prototype and PROTOTYPE.md sit at the
 * same level. Every target path is confined to that dir; a `path` that tries to
 * escape (via `..` or an absolute path) throws.
 */
export function savePrototype({
  files,
  dir = activeProtoDir(),
}: SavePrototypeOptions): SavedPrototype {
  const baseDir = dir;
  mkdirSync(baseDir, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    const target = resolve(baseDir, f.path);
    if (target !== baseDir && !target.startsWith(baseDir + sep)) {
      throw new Error(`refused to write outside the prototype sandbox: ${f.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, "utf8");
    written.push(target);
  }
  const indexPath = written.find((p) => p.endsWith("index.html")) ?? written[0];
  return {
    dir: baseDir,
    files: written,
    indexPath,
    url: indexPath ? `file://${indexPath}` : undefined,
  };
}

/** Open a file in the OS default app (best-effort; ignores failures). */
function openInBrowser(target: string): void {
  if (process.env.HEMIUNU_NO_OPEN) return; // headless / test runs
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [target], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort — the tool result still reports the path
  }
}

/**
 * In-process MCP server exposing `save_prototype` — writes a self-contained
 * wireframe/prototype into the `prototypes/` sandbox and opens it in the
 * browser. The agent (or the `prototyper` subagent) generates the files; this
 * is the only way it touches the filesystem for output, and it's scoped.
 */
export function createPrototypeServer() {
  const saveTool = tool(
    "save_prototype",
    "Write a self-contained wireframe/prototype into the current prototype workspace (flat — index.html at the root, alongside PROTOTYPE.md) and show it to the user as a live, interactive preview. Pass one or more files by relative path including an index.html entry point. Use for low-fi HTML wireframes grounded in the brief — grayscale boxes, real labels/content, no brand styling.",
    {
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
    },
    async ({ files }) => {
      try {
        // With a team selected, make sure its workspace is a real git checkout
        // BEFORE writing — otherwise the files land in a bare dir that can't be
        // pushed ("fatal: not a git repository") and gets clobbered by a later
        // sync. No team → the local session folder needs no git.
        const repo = resolveRepo();
        if (repo) {
          const ready = await ensureCloned(repo, { token: resolveGithubToken() });
          if (ready.action === "failed") {
            return {
              content: [
                {
                  type: "text",
                  text: `Couldn't prepare the ${repo} workspace to save into: ${ready.note ?? "clone failed"}. Check the GitHub connection (/github), then try again.`,
                },
              ],
            };
          }
        }
        const saved = savePrototype({ files });
        if (saved.indexPath) openInBrowser(saved.indexPath); // no-op when HEMIUNU_NO_OPEN
        // In the web app (HEMIUNU_NO_OPEN) the preview is embedded inline as a
        // live artifact the user sees in the chat — so the agent must NOT claim
        // a browser tab opened, nor paste a text/ASCII mock as a substitute.
        const inline = !!process.env.HEMIUNU_NO_OPEN;
        const text = !saved.indexPath
          ? `Saved ${saved.files.length} file(s) to ${saved.dir}, but no index.html — add one so it can be previewed.`
          : inline
            ? `Saved ${saved.files.length} file(s) to ${saved.dir}. The live, interactive prototype is now shown to the user right here in the chat — refer to it as the preview above. Do NOT tell them to open a browser or a localhost link, and do NOT paste a text/ASCII version: the real thing is already on screen.`
            : `Saved ${saved.files.length} file(s) to ${saved.dir}; opened ${saved.indexPath} in the browser for the user.`;
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to save prototype: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
        };
      }
    },
    { annotations: { title: "Save prototype", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-prototype",
    version: "0.0.0",
    tools: [saveTool],
  });
}

/** Tool id the SDK exposes for the save_prototype tool. */
export const SAVE_PROTOTYPE_TOOL_ID = "mcp__hemiunu-prototype__save_prototype";
