import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveGithubToken, resolveRepo } from "./github";
import { previewStatus, startPreview } from "./preview";
import { ensureWorkspace, workspacePath } from "./workspace";

/**
 * The fast local-iteration surface: sync the current team's repo into a local
 * workspace, serve it on localhost (HMR), and let the agent read/write the
 * prototype's files there. All file access is confined to that workspace — the
 * agent never touches the folder you launched in.
 */

const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel"]);

function activeWorkspace(): { repo: string; dir: string } | { error: string } {
  const repo = resolveRepo();
  if (!repo) {
    return { error: "No team selected — pick one (Shift+Tab or /team) to iterate on its prototype." };
  }
  return { repo, dir: workspacePath(repo) };
}

/** Resolve a path inside the workspace, or null if it escapes the sandbox. */
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
    "Start (or resume) a fast LOCAL iteration session on the current team's prototype: syncs the repo to the latest version into a local workspace and serves it on localhost with live reload (opens the browser). Use when the user wants to build/iterate and see changes fast. Afterwards, edit files with write_workspace_file and they hot-reload. To share the result, that's a separate commit/push step.",
    {},
    async () => {
      const ws = activeWorkspace();
      if ("error" in ws) return { content: [{ type: "text", text: ws.error }] };
      const synced = await ensureWorkspace(ws.repo, { token: resolveGithubToken() });
      if (synced.action === "failed") {
        return { content: [{ type: "text", text: `Couldn't sync ${ws.repo}: ${synced.note ?? "unknown error"}` }] };
      }
      const prev = await startPreview(ws.repo, ws.dir);
      if ("error" in prev) {
        return { content: [{ type: "text", text: `Synced ${ws.repo} (${synced.action}), but the preview failed: ${prev.error}` }] };
      }
      const binNote = synced.binned ? " Prior un-pushed edits were saved to the recycle bin (/restore)." : "";
      return {
        content: [
          {
            type: "text",
            text: `Iterating on ${ws.repo} — synced to latest (${synced.action}).${binNote} Live preview: ${prev.url}. Edit files with write_workspace_file; the preview hot-reloads.`,
          },
        ],
      };
    },
    { annotations: { title: "Iterate prototype", readOnlyHint: false } },
  );

  const listTool = tool(
    "list_workspace_files",
    "List files in the current prototype's local workspace (excludes node_modules, .git, build output). See what exists before editing.",
    {},
    async () => {
      const ws = activeWorkspace();
      if ("error" in ws) return { content: [{ type: "text", text: ws.error }] };
      if (!existsSync(ws.dir)) {
        return { content: [{ type: "text", text: "No local workspace yet — run iterate_prototype first." }] };
      }
      const files = listFiles(ws.dir);
      return { content: [{ type: "text", text: files.length ? files.join("\n") : "(empty)" }] };
    },
    { annotations: { title: "List workspace files", readOnlyHint: true } },
  );

  const readTool = tool(
    "read_workspace_file",
    "Read a file from the current prototype's local workspace, to build on top of the existing code.",
    { path: z.string().describe("Path relative to the workspace root, e.g. 'app/page.tsx'.") },
    async ({ path }) => {
      const ws = activeWorkspace();
      if ("error" in ws) return { content: [{ type: "text", text: ws.error }] };
      const file = confined(ws.dir, path);
      if (!file) return { content: [{ type: "text", text: `Refused: '${path}' is outside the workspace.` }] };
      if (!existsSync(file)) return { content: [{ type: "text", text: `No such file: ${path}` }] };
      return { content: [{ type: "text", text: readFileSync(file, "utf8") }] };
    },
    { annotations: { title: "Read workspace file", readOnlyHint: true } },
  );

  const writeTool = tool(
    "write_workspace_file",
    "Create or overwrite a file in the current prototype's local workspace. The running live preview hot-reloads. Use this to iterate on the prototype before committing/sharing.",
    {
      path: z.string().describe("Path relative to the workspace root."),
      content: z.string().describe("Full file contents."),
    },
    async ({ path, content }) => {
      const ws = activeWorkspace();
      if ("error" in ws) return { content: [{ type: "text", text: ws.error }] };
      if (!existsSync(ws.dir)) {
        return { content: [{ type: "text", text: "No local workspace yet — run iterate_prototype first." }] };
      }
      const file = confined(ws.dir, path);
      if (!file) return { content: [{ type: "text", text: `Refused: '${path}' is outside the workspace.` }] };
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      const live = previewStatus();
      return { content: [{ type: "text", text: `Wrote ${path}.${live ? ` Live at ${live.url}.` : ""}` }] };
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
