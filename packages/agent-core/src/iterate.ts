import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveGithubToken, resolveRepo } from "./github";
import { previewStatus, startPreview } from "./preview";
import { activeProtoDir, ensureWorkspace, localWorkspaceDir } from "./workspace";

/**
 * Fast local-iteration surface. Works whether or not a team is selected: with a
 * team it syncs the repo into the team workspace; with no team it uses a local
 * session folder. Either way it serves the active prototype dir on localhost
 * (HMR) and lets the agent read/write the prototype's files there — confined to
 * that dir, never the launch folder.
 */

const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel"]);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Resolve a path inside the active dir, or null if it escapes the sandbox. */
function confined(dir: string, rel: string): string | null {
  const target = resolve(dir, rel);
  return target === dir || target.startsWith(dir + sep) ? target : null;
}

function listFiles(dir: string, max = 500): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (out.length >= max) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (IGNORE.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        out.push(relative(dir, full));
        if (out.length >= max) return;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export function createWorkspaceServer() {
  const iterateTool = tool(
    "iterate_prototype",
    "Start (or resume) a fast LOCAL iteration session on the current prototype and serve it on localhost with live reload (opens the browser). With a team it first syncs the repo to the latest version into the local workspace; with no team it uses a temporary local session folder. Afterwards, edit files with write_workspace_file and they hot-reload.",
    {},
    async () => {
      const repo = resolveRepo();
      if (repo) {
        const synced = await ensureWorkspace(repo, { token: resolveGithubToken() });
        if (synced.action === "failed") {
          return text(`Couldn't sync ${repo}: ${synced.note ?? "unknown error"}`);
        }
        const prev = await startPreview(repo, synced.path);
        if ("error" in prev) {
          return text(`Synced ${repo} (${synced.action}), but the preview failed: ${prev.error}`);
        }
        const binNote = synced.binned
          ? " Prior un-pushed edits were saved to the recycle bin (/restore)."
          : "";
        return text(
          `Iterating on ${repo} — synced to latest (${synced.action}).${binNote} Live preview: ${prev.url}. Edit files with write_workspace_file; the preview hot-reloads.`,
        );
      }
      const dir = localWorkspaceDir();
      mkdirSync(dir, { recursive: true });
      const prev = await startPreview(`local:${dir}`, dir);
      if ("error" in prev) return text(`Preview failed: ${prev.error}`);
      return text(
        `Iterating locally (no team) in a temporary workspace. Live preview: ${prev.url}. Edit files with write_workspace_file; the preview hot-reloads. Create a team later to push this work to a repo.`,
      );
    },
    { annotations: { title: "Iterate prototype", readOnlyHint: false } },
  );

  const listTool = tool(
    "list_workspace_files",
    "List files in the current prototype's workspace (excludes node_modules, .git, build output).",
    {},
    async () => {
      const dir = activeProtoDir();
      if (!existsSync(dir))
        return text("Nothing yet — run iterate_prototype or save a prototype first.");
      const files = listFiles(dir);
      return text(files.length ? files.join("\n") : "(empty)");
    },
    { annotations: { title: "List workspace files", readOnlyHint: true } },
  );

  const readTool = tool(
    "read_workspace_file",
    "Read a file from the current prototype's workspace, to build on top of the existing code.",
    {
      path: z
        .string()
        .describe("Path relative to the workspace root, e.g. 'index.html' or 'app/page.tsx'."),
    },
    async ({ path }) => {
      const dir = activeProtoDir();
      const file = confined(dir, path);
      if (!file) return text(`Refused: '${path}' is outside the workspace.`);
      if (!existsSync(file)) return text(`No such file: ${path}`);
      return text(readFileSync(file, "utf8"));
    },
    { annotations: { title: "Read workspace file", readOnlyHint: true } },
  );

  const writeTool = tool(
    "write_workspace_file",
    "Create or overwrite a file in the current prototype's workspace (flat at the root). The running live preview hot-reloads. Use this to iterate before committing/sharing.",
    {
      path: z.string().describe("Path relative to the workspace root."),
      content: z.string().describe("Full file contents."),
    },
    async ({ path, content }) => {
      const dir = activeProtoDir();
      const file = confined(dir, path);
      if (!file) return text(`Refused: '${path}' is outside the workspace.`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      const live = previewStatus();
      return text(`Wrote ${path}.${live ? ` Live at ${live.url}.` : ""}`);
    },
    { annotations: { title: "Write workspace file", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-workspace",
    version: "0.0.0",
    tools: [iterateTool, listTool, readTool, writeTool],
  });
}

/** Tool-availability wildcard for the workspace/iteration server. */
export const WORKSPACE_TOOLS = "mcp__hemiunu-workspace__*";
