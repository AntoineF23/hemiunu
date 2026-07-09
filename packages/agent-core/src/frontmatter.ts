/**
 * Minimal YAML-frontmatter handling shared by anything that stores Markdown
 * with a `--- key: value ---` header (skills, prototype knowledge). Deliberately
 * tiny — only flat string key/values, no nested YAML — so there's no dependency.
 */

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

/** Parse `--- key: value ---` frontmatter + body. No fence = everything is body. */
export function parseFrontmatter(raw: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

/** Values that would break the trivial `key: value` parse get JSON-quoted. */
function needsQuote(v: string): boolean {
  return v === "" || /^\s|\s$|[:#"'[\]{}>|]/.test(v);
}

/**
 * Render frontmatter + body back to canonical text. Key order follows the
 * object's insertion order; undefined values are skipped.
 */
export function renderFrontmatter(meta: Record<string, string | undefined>, body: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${needsQuote(v) ? JSON.stringify(v) : v}`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}
