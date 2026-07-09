import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { activeProtoDir } from "./workspace";

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

/** Resolved id of the save_prototype tool. */
export const SAVE_PROTOTYPE_TOOL_ID = "mcp__hemiunu-prototype__save_prototype";
