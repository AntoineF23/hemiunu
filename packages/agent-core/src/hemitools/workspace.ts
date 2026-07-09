// HemiTool port of the hemiunu-workspace server (iterate.ts
// createWorkspaceServer). Handlers unchanged; the module-private helpers
// (confined, listFiles, ensureProtoReady, previewPhrase) are carried over,
// while the exported ones (searchRegex, readWindow, spilledResult) are shared
// with the SDK-era module so both runtimes stay in lock-step.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { HemiTool } from "@hemiunu/engine";
import { z } from "zod";
import { resolveGithubToken, resolveRepo } from "../github";
import { readWindow, searchRegex, spilledResult } from "../iterate";
import { previewStatus, startPreview } from "../preview";
import { verifyPrototype } from "../verify";
import { activeProtoDir, ensureWorkspace, localWorkspaceDir } from "../workspace";
import { defineTool, ok } from "./helpers";

const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel"]);

/** Resolve a path inside the active dir, or null if it escapes the sandbox. */
function confined(dir: string, rel: string): string | null {
  const target = resolve(dir, rel);
  return target === dir || target.startsWith(dir + sep) ? target : null;
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

// How to describe the running preview to the agent. In the web app
// (HEMIUNU_NO_OPEN) it is embedded inline as a live artifact the user already
// sees; on the CLI the localhost link is what the user opens.
function previewPhrase(url: string): string {
  return process.env.HEMIUNU_NO_OPEN
    ? "The live, interactive preview is shown to the user right here in the chat — refer to it as the preview above; do not surface a browser tab or a localhost link, and never paste a text/ASCII version as a substitute."
    : `Live preview: ${url}.`;
}

/**
 * Make sure the active prototype dir is populated before listing / reading /
 * editing it. With a team selected and no local checkout yet, clone the repo so
 * the existing prototype already on main is pulled in AUTOMATICALLY. No-op once
 * a checkout exists, and for local (no-team) work. Best-effort.
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

export function createWorkspaceTools(): HemiTool[] {
  return [
    defineTool({
      name: "mcp__hemiunu-workspace__iterate_prototype",
      description:
        "Start (or resume) a fast LOCAL iteration session on the current prototype and show it to the user as a live, interactive preview with hot reload. With a team it first syncs the repo to the latest version into the local workspace; with no team it uses a temporary local session folder. Afterwards, edit files with write_workspace_file and they hot-reload.",
      inputSchema: z.object({}),
      permission: "ask",
      readOnly: false,
      async execute() {
        const repo = resolveRepo();
        if (repo) {
          const synced = await ensureWorkspace(repo, { token: resolveGithubToken() });
          if (synced.action === "failed") {
            return ok(`Couldn't sync ${repo}: ${synced.note ?? "unknown error"}`);
          }
          const prev = await startPreview(repo, synced.path);
          if ("error" in prev) {
            return ok(`Synced ${repo} (${synced.action}), but the preview failed: ${prev.error}`);
          }
          const binNote = synced.binned
            ? " Prior un-pushed edits were saved to the recycle bin (/restore)."
            : "";
          return ok(
            `Iterating on ${repo} — synced to latest (${synced.action}).${binNote} ${previewPhrase(prev.url)} Edit files with write_workspace_file; the preview hot-reloads.`,
          );
        }
        const dir = localWorkspaceDir();
        mkdirSync(dir, { recursive: true });
        const prev = await startPreview(`local:${dir}`, dir);
        if ("error" in prev) return ok(`Preview failed: ${prev.error}`);
        return ok(
          `Iterating locally (no team) in a temporary workspace. ${previewPhrase(prev.url)} Edit files with write_workspace_file; the preview hot-reloads. Create a team later to push this work to a repo.`,
        );
      },
    }),
    defineTool({
      name: "mcp__hemiunu-workspace__list_workspace_files",
      description:
        "List files in the current prototype's workspace (excludes node_modules, .git, build output).",
      inputSchema: z.object({}),
      permission: "ask",
      readOnly: true,
      async execute() {
        const dir = await ensureProtoReady();
        if (!existsSync(dir))
          return ok("Nothing yet — run iterate_prototype or save a prototype first.");
        const { files, total } = listFiles(dir);
        if (!files.length) return ok("(empty)");
        const more =
          total > files.length
            ? `\n\n(… and ${total - files.length} more — showing the first ${files.length})`
            : "";
        return ok(files.join("\n") + more);
      },
    }),
    defineTool({
      name: "mcp__hemiunu-workspace__read_workspace_file",
      description:
        "Read a file from the current prototype's workspace, to build on top of the existing code. For a big file (a template bundle, a large tokens/CSS file), read it in windows with offset/limit instead of all at once — search_workspace first to find the line you want, then read around it. If another tool's result was too large and got saved to a file (a path under …/tool-results/…), pass that path here with offset/limit to read it in windows.",
      inputSchema: z.object({
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
      }),
      permission: "ask",
      readOnly: true,
      async execute({ path, offset, limit }) {
        const dir = await ensureProtoReady();
        // A workspace file, or a tool-result overflow file (read-only escape
        // hatch so the agent can follow "output saved to …/tool-results/…").
        const file = confined(dir, path) ?? spilledResult(path);
        if (!file) return ok(`Refused: '${path}' is outside the workspace.`);
        if (!existsSync(file)) return ok(`No such file: ${path}`);
        const raw = readFileSync(file, "utf8");
        // No window requested → whole file (back-compat); otherwise a numbered slice.
        if (offset == null && limit == null) return ok(raw);
        return ok(readWindow(raw, offset, limit));
      },
    }),
    defineTool({
      name: "mcp__hemiunu-workspace__search_workspace",
      description:
        "Search the current prototype's workspace for a pattern (like grep) and get back matching `path:line: text` hits — without reading whole files. Use this to locate a component, token, or @font-face in a large file, then read_workspace_file around that line.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "A regular expression (case-insensitive). Falls back to a literal match if invalid.",
          ),
      }),
      permission: "ask",
      readOnly: true,
      async execute({ query }) {
        const dir = await ensureProtoReady();
        if (!existsSync(dir))
          return ok("Nothing yet — run iterate_prototype or save a prototype first.");
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
        if (!hits.length) return ok(`No matches for /${query}/.`);
        const note = truncated ? `\n\n(showing the first ${MAX_HITS} matches)` : "";
        return ok(hits.join("\n") + note);
      },
    }),
    defineTool({
      name: "mcp__hemiunu-workspace__write_workspace_file",
      description:
        "Create or overwrite a file in the current prototype's workspace (flat at the root). The running live preview hot-reloads. Use this to iterate before committing/sharing.",
      inputSchema: z.object({
        path: z.string().describe("Path relative to the workspace root."),
        content: z.string().describe("Full file contents."),
      }),
      permission: "ask",
      readOnly: false,
      async execute({ path, content }) {
        const dir = await ensureProtoReady();
        const file = confined(dir, path);
        if (!file) return ok(`Refused: '${path}' is outside the workspace.`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, "utf8");
        const live = previewStatus();
        const liveNote = live
          ? process.env.HEMIUNU_NO_OPEN
            ? " The preview updated for the user in the chat."
            : ` Live at ${live.url}.`
          : "";
        return ok(`Wrote ${path}.${liveNote}`);
      },
    }),
    defineTool({
      name: "mcp__hemiunu-workspace__check_prototype",
      description:
        "Verify the current prototype actually compiles (TypeScript check, or a production build when there's no tsconfig). The live preview can look fine while a component fails to compile — run this ONCE when a hi-fi build is complete (the WIRE/validation pass), fix any errors it reports with write_workspace_file, then run it once more to confirm. Skips gracefully for static HTML wireframes.",
      inputSchema: z.object({}),
      permission: "ask",
      readOnly: true,
      async execute() {
        const dir = await ensureProtoReady();
        const r = await verifyPrototype(dir);
        if (r.ok) return ok(`✓ ${r.note}.`);
        return ok(
          `✗ ${r.note} — the preview may look up but the build is broken. Fix these with write_workspace_file, then run check_prototype once more:\n\n${r.output}`,
        );
      },
    }),
  ];
}
