import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { sdkConfigDir } from "./config";
import { resolveGithubToken, resolveRepo } from "./github";
import { previewStatus, startPreview } from "./preview";
import { verifyPrototype } from "./verify";
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

/**
 * Allow reading the SDK's persisted tool-result overflow files. When a tool
 * result is too large to inline, the SDK saves the full output under
 * `<sdkConfigDir>/…/tool-results/…` and tells the model to read it with
 * offset/limit. Those files live OUTSIDE the prototype workspace, so the read
 * sandbox would otherwise refuse them and the agent could never retrieve a big
 * result (e.g. a full DIVE template). Scoped to `tool-results` dirs only — NOT
 * the rest of ~/.hemiunu, which holds secrets (.env, the GitHub token, the DB).
 * Exported for tests.
 */
export function spilledResult(p: string): string | null {
  const abs = resolve(p);
  const root = sdkConfigDir();
  const inHome = abs === root || abs.startsWith(root + sep);
  return inHome && abs.includes(`${sep}tool-results${sep}`) ? abs : null;
}

/** List files under `dir`, capped at `max`. `total` is the true count so the
 *  caller can tell the agent when the listing was truncated. */
function listFiles(dir: string, max = 500): { files: string[]; total: number } {
  const files: string[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (IGNORE.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        total++;
        if (files.length < max) files.push(relative(dir, full));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files, total };
}

/** Build the case-insensitive search regex, falling back to a literal match when
 *  the query isn't valid regex (so a stray `(` never throws). Exported for tests. */
export function searchRegex(query: string): RegExp {
  try {
    return new RegExp(query, "i");
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

/** Render a numbered line window of `raw` (1-based `offset`, up to `limit` lines)
 *  with a footer that says how to page on — so a big file can be read in slices
 *  instead of swallowed whole. Exported for tests. */
export function readWindow(raw: string, offset?: number, limit?: number): string {
  const lines = raw.split("\n");
  const start = Math.max(1, offset ?? 1);
  const slice = lines.slice(start - 1, start - 1 + (limit ?? 2000));
  const end = start - 1 + slice.length;
  const numbered = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
  const more = end < lines.length ? `; read on with offset=${end + 1}` : "";
  return `${numbered}\n\n[lines ${start}–${end} of ${lines.length}${more}]`;
}

// How to describe the running preview to the agent. In the web app
// (HEMIUNU_NO_OPEN) it is embedded inline as a live artifact the user already
// sees, so the agent must not surface a browser tab or a localhost URL; on the
// CLI the localhost link is what the user opens.
function previewPhrase(url: string): string {
  return process.env.HEMIUNU_NO_OPEN
    ? "The live, interactive preview is shown to the user right here in the chat — refer to it as the preview above; do not surface a browser tab or a localhost link, and never paste a text/ASCII version as a substitute."
    : `Live preview: ${url}.`;
}

/**
 * Make sure the active prototype dir is populated before listing / reading /
 * editing it. With a team selected and no local checkout yet, clone the repo so
 * the existing prototype already on main is pulled in AUTOMATICALLY — otherwise
 * the read tools see an empty folder when starting a fresh session on a team
 * whose work is on GitHub. No-op once a checkout exists (skips the network), and
 * for local (no-team) work. Best-effort: returns the dir even if the sync fails.
 */
async function ensureProtoReady(): Promise<string> {
  const dir = activeProtoDir();
  if (existsSync(join(dir, ".git"))) return dir; // already a checkout — don't re-fetch per call
  const repo = resolveRepo();
  if (repo) {
    const synced = await ensureWorkspace(repo, { token: resolveGithubToken() });
    if (synced.action !== "failed") return synced.path;
  }
  return dir;
}

export function createWorkspaceServer() {
  const iterateTool = tool(
    "iterate_prototype",
    "Start (or resume) a fast LOCAL iteration session on the current prototype and show it to the user as a live, interactive preview with hot reload. With a team it first syncs the repo to the latest version into the local workspace; with no team it uses a temporary local session folder. Afterwards, edit files with write_workspace_file and they hot-reload.",
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
          `Iterating on ${repo} — synced to latest (${synced.action}).${binNote} ${previewPhrase(prev.url)} Edit files with write_workspace_file; the preview hot-reloads.`,
        );
      }
      const dir = localWorkspaceDir();
      mkdirSync(dir, { recursive: true });
      const prev = await startPreview(`local:${dir}`, dir);
      if ("error" in prev) return text(`Preview failed: ${prev.error}`);
      return text(
        `Iterating locally (no team) in a temporary workspace. ${previewPhrase(prev.url)} Edit files with write_workspace_file; the preview hot-reloads. Create a team later to push this work to a repo.`,
      );
    },
    { annotations: { title: "Iterate prototype", readOnlyHint: false } },
  );

  const listTool = tool(
    "list_workspace_files",
    "List files in the current prototype's workspace (excludes node_modules, .git, build output).",
    {},
    async () => {
      const dir = await ensureProtoReady();
      if (!existsSync(dir))
        return text("Nothing yet — run iterate_prototype or save a prototype first.");
      const { files, total } = listFiles(dir);
      if (!files.length) return text("(empty)");
      const more =
        total > files.length
          ? `\n\n(… and ${total - files.length} more — showing the first ${files.length})`
          : "";
      return text(files.join("\n") + more);
    },
    { annotations: { title: "List workspace files", readOnlyHint: true } },
  );

  const readTool = tool(
    "read_workspace_file",
    "Read a file from the current prototype's workspace, to build on top of the existing code. For a big file (a template bundle, a large tokens/CSS file), read it in windows with offset/limit instead of all at once — search_workspace first to find the line you want, then read around it. If another tool's result was too large and got saved to a file (a path under …/tool-results/…), pass that path here with offset/limit to read it in windows.",
    {
      path: z
        .string()
        .describe("Path relative to the workspace root, e.g. 'index.html' or 'app/page.tsx'."),
      offset: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based line number to start at. Omit to read from the top."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max lines to return from `offset`. Omit (with no offset) to read the whole file.",
        ),
    },
    async ({ path, offset, limit }) => {
      const dir = await ensureProtoReady();
      // A workspace file, or an SDK tool-result overflow file (read-only escape
      // hatch so the agent can follow "output saved to …/tool-results/…").
      const file = confined(dir, path) ?? spilledResult(path);
      if (!file) return text(`Refused: '${path}' is outside the workspace.`);
      if (!existsSync(file)) return text(`No such file: ${path}`);
      const raw = readFileSync(file, "utf8");
      // No window requested → whole file (back-compat); otherwise a numbered slice.
      if (offset == null && limit == null) return text(raw);
      return text(readWindow(raw, offset, limit));
    },
    { annotations: { title: "Read workspace file", readOnlyHint: true } },
  );

  const searchTool = tool(
    "search_workspace",
    "Search the current prototype's workspace for a pattern (like grep) and get back matching `path:line: text` hits — without reading whole files. Use this to locate a component, token, or @font-face in a large file, then read_workspace_file around that line.",
    {
      query: z
        .string()
        .describe(
          "A regular expression (case-insensitive). Falls back to a literal match if invalid.",
        ),
    },
    async ({ query }) => {
      const dir = await ensureProtoReady();
      if (!existsSync(dir))
        return text("Nothing yet — run iterate_prototype or save a prototype first.");
      const re = searchRegex(query);
      const MAX_HITS = 200;
      const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip anything bigger (likely binary/minified)
      const { files } = listFiles(dir, 5000);
      const hits: string[] = [];
      let truncated = false;
      for (const rel of files) {
        if (hits.length >= MAX_HITS) {
          truncated = true;
          break;
        }
        const full = join(dir, rel);
        let content: string;
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          content = readFileSync(full, "utf8");
        } catch {
          continue; // unreadable / binary
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= MAX_HITS) {
            truncated = true;
            break;
          }
        }
      }
      if (!hits.length) return text(`No matches for /${query}/.`);
      const note = truncated ? `\n\n(showing the first ${MAX_HITS} matches)` : "";
      return text(hits.join("\n") + note);
    },
    { annotations: { title: "Search workspace", readOnlyHint: true } },
  );

  const writeTool = tool(
    "write_workspace_file",
    "Create or overwrite a file in the current prototype's workspace (flat at the root). The running live preview hot-reloads. Use this to iterate before committing/sharing.",
    {
      path: z.string().describe("Path relative to the workspace root."),
      content: z.string().describe("Full file contents."),
    },
    async ({ path, content }) => {
      const dir = await ensureProtoReady();
      const file = confined(dir, path);
      if (!file) return text(`Refused: '${path}' is outside the workspace.`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      const live = previewStatus();
      const liveNote = live
        ? process.env.HEMIUNU_NO_OPEN
          ? " The preview updated for the user in the chat."
          : ` Live at ${live.url}.`
        : "";
      return text(`Wrote ${path}.${liveNote}`);
    },
    { annotations: { title: "Write workspace file", readOnlyHint: false } },
  );

  const checkTool = tool(
    "check_prototype",
    "Verify the current prototype actually compiles (TypeScript check, or a production build when there's no tsconfig). The live preview can look fine while a component fails to compile — run this ONCE when a hi-fi build is complete (the WIRE/validation pass), fix any errors it reports with write_workspace_file, then run it once more to confirm. Skips gracefully for static HTML wireframes.",
    {},
    async () => {
      const dir = await ensureProtoReady();
      const r = await verifyPrototype(dir);
      if (r.ok) return text(`✓ ${r.note}.`);
      return text(
        `✗ ${r.note} — the preview may look up but the build is broken. Fix these with write_workspace_file, then run check_prototype once more:\n\n${r.output}`,
      );
    },
    { annotations: { title: "Check prototype", readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "hemiunu-workspace",
    version: "0.0.0",
    tools: [iterateTool, listTool, readTool, searchTool, writeTool, checkTool],
  });
}

/** Tool-availability wildcard for the workspace/iteration server. */
export const WORKSPACE_TOOLS = "mcp__hemiunu-workspace__*";
