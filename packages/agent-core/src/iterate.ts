import { resolve, sep } from "node:path";
import { sdkConfigDir } from "./config";

/**
 * Fast local-iteration helpers shared by the hemiunu-workspace tools (see
 * hemitools/workspace.ts): the read-window renderer, the safe search-regex
 * builder, and the spilled-tool-result escape hatch. The tools themselves are
 * HemiTools on the engine loop.
 */

/**
 * Allow reading persisted tool-result overflow files. When a tool result is too
 * large to inline, the full output is saved under
 * `<sdkConfigDir()>/…/tool-results/…` and the model is told to read it with
 * offset/limit. Those files live OUTSIDE the prototype workspace, so the read
 * sandbox would otherwise refuse them and the agent could never retrieve a big
 * result (e.g. a full design-system template). Scoped to `tool-results` dirs only — NOT
 * the rest of ~/.hemiunu, which holds secrets (.env, the GitHub token, the DB).
 * Exported for tests.
 */
export function spilledResult(p: string): string | null {
  const abs = resolve(p);
  const root = sdkConfigDir();
  const inHome = abs === root || abs.startsWith(root + sep);
  return inHome && abs.includes(`${sep}tool-results${sep}`) ? abs : null;
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

/** Tool-availability wildcard for the workspace/iteration server. */
export const WORKSPACE_TOOLS = "mcp__hemiunu-workspace__*";
