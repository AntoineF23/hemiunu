import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface PrototypeFile {
  /** Path relative to the prototype folder, e.g. "index.html". */
  path: string;
  content: string;
}

export interface SavePrototypeOptions {
  slug: string;
  files: PrototypeFile[];
  /** Root the `prototypes/` dir lives under (defaults to the launch dir). */
  root?: string;
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
 * Write prototype files under `<root>/prototypes/<slug>/`. Every target path is
 * resolved and confined to that sandbox — a `path` that tries to escape (via
 * `..` or an absolute path) throws rather than writing outside it.
 */
export function savePrototype({
  slug,
  files,
  root = process.cwd(),
}: SavePrototypeOptions): SavedPrototype {
  const baseDir = join(root, "prototypes", slugify(slug));
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
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
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
    "Write a self-contained wireframe/prototype to prototypes/<slug>/ and open it in the browser. Pass one or more files by relative path and include an index.html entry point. Use for low-fi HTML wireframes grounded in the brief — grayscale boxes, real labels/content, no brand styling.",
    {
      slug: z
        .string()
        .describe("Short kebab-case name for this prototype, e.g. 'churn-dashboard'."),
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe("Path relative to the prototype folder, e.g. 'index.html'."),
            content: z.string().describe("Full file contents."),
          }),
        )
        .describe("Files to write. Include an index.html entry point."),
    },
    async ({ slug, files }) => {
      try {
        const saved = savePrototype({ slug, files });
        if (saved.indexPath) openInBrowser(saved.indexPath);
        return {
          content: [
            {
              type: "text",
              text: `Saved ${saved.files.length} file(s) to ${saved.dir}; opened ${saved.indexPath ?? "(no index.html)"} in the browser.`,
            },
          ],
        };
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
