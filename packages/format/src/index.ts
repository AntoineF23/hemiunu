// Pure presentation formatters shared by BOTH front-ends (the Ink CLI and the
// web worker). This lives in its own package — NOT in agent-core — so the engine
// stays UI-agnostic, while the two UIs render tool calls/results identically
// from a single source of truth (previously duplicated, kept in sync by hand).
// Node-only (reads process.env.HOME); both consumers run in Node.

export * from "./activity";

const HOME_DIR = process.env.HOME ?? "";

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const title = (p: string) => clip(p.replace(/\s+/g, " ").trim(), 60);

/** A long uuid → its first segment, so ids read as `38835e52…` not a wall. */
export const shortId = (id: string) => (id.length > 12 ? `${id.split("-")[0]}…` : id);
export const shortPath = (p: string) =>
  HOME_DIR && p.startsWith(HOME_DIR) ? `~${p.slice(HOME_DIR.length)}` : p;

/** True for an SDK tool-result overflow file (…/projects/<slug>/…/tool-results/…),
 *  the escape-hatch path read_workspace_file follows — NOT real prototype work. */
export const isSpilledResultPath = (p: string) =>
  /[\\/]projects[\\/].+[\\/]tool-results[\\/]/.test(p);

/** mcp__filesystem__read_file → filesystem·read_file */
export function prettyTool(name: string): string {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    if (i >= 0) return `${rest.slice(0, i)}·${rest.slice(i + 2)}`;
  }
  return name;
}

export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? (b as { text: string }).text
          : "",
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

/**
 * Like `resultText`, but preserves the original line breaks and spacing instead
 * of collapsing whitespace. Use this when the result is meant to be READ in full
 * (e.g. a subagent's final answer surfaced as an expandable block), where the
 * markdown structure — headings, lists, paragraphs — is the point.
 */
export function resultTextRaw(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? (b as { text: string }).text
          : "",
      )
      .join("\n")
      .trim();
  }
  return "";
}

/** Render a tool call's input as the one argument that matters, not raw JSON. */
export function toolPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (str(i.query)) return `“${clip(str(i.query), 60)}”`;
  if (str(i.pattern)) return clip(str(i.pattern), 60);
  if (str(i.path)) {
    const p = str(i.path);
    // A spilled tool-result overflow file is internal bookkeeping, not prototype
    // work — never leak its path into the activity feed / permission dialog.
    return isSpilledResultPath(p) ? "" : clip(shortPath(p), 60);
  }
  if (str(i.page_id)) return shortId(str(i.page_id));
  if (str(i.data_source_id)) return shortId(str(i.data_source_id));
  if (str(i.mcp)) return str(i.mcp);
  if (str(i.prompt)) return `“${clip(str(i.prompt), 60)}”`;
  const firstStr = Object.values(i).find((v) => typeof v === "string" && v.trim()) as
    string | undefined;
  return firstStr ? clip(firstStr.trim(), 60) : "";
}

/**
 * A clean, human preview of a tool result for an activity line — or "" when the
 * result is raw text, oversized, or an error, so that garbage (YAML/JSON dumps,
 * "exceeds maximum tokens" notices, stack traces) never leaks into the activity
 * stream. Only structured summaries pass: a result count, a page title, or file
 * tallies. Everything else is suppressed; the activity's own label + count
 * already convey what happened.
 */
export function cleanResultPreview(text: string): string {
  const t = text.trim();
  if (!t) return "";
  // Errors and the tool-cap's oversize notice are not user-facing detail.
  if (/^[⚠\s]*(Error|EPERM|ENOENT|EACCES|EISDIR)/i.test(t)) return "";
  if (/exceeds maximum allowed tokens|Output has been saved/i.test(t)) return "";
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return ""; // raw text (YAML, prose, a dump) — not a clean summary
  }
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    if (Array.isArray(o.results)) {
      const n = o.results.length;
      return n === 0 ? "no results" : `${n}${o.has_more ? "+" : ""} result${n === 1 ? "" : "s"}`;
    }
    if (typeof o.markdown === "string") {
      const first =
        o.markdown
          .replace(/^[>#\s]+/, "")
          .split("\n")
          .find((l: string) => l.trim()) ?? "";
      return first ? `“${clip(first.trim(), 90)}”` : "";
    }
    if (typeof o.content === "string") {
      const c = o.content;
      const files = (c.match(/\[FILE\]/g) ?? []).length;
      const dirs = (c.match(/\[DIR\]/g) ?? []).length;
      if (files || dirs)
        return `${dirs} dir${dirs === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`;
    }
  }
  return ""; // structured but nothing worth showing
}

/** Turn a tool result into a short human line instead of dumping its JSON. */
export function summarizeResult(text: string): string {
  const t = text.trim();
  if (!t) return "done";
  if (/^(Error|EPERM|ENOENT|EACCES|EISDIR)/i.test(t))
    return `⚠ ${clip(t.replace(/\s+/g, " "), 120)}`;
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return clip(t.replace(/\s+/g, " "), 140);
  }
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    if (Array.isArray(o.results)) {
      const n = o.results.length;
      return n === 0 ? "no results" : `${n}${o.has_more ? "+" : ""} result${n === 1 ? "" : "s"}`;
    }
    if (typeof o.markdown === "string") {
      const first =
        o.markdown
          .replace(/^[>#\s]+/, "")
          .split("\n")
          .find((l: string) => l.trim()) ?? "";
      return first ? `“${clip(first.trim(), 90)}”` : "empty page";
    }
    if (typeof o.content === "string") {
      const c = o.content;
      const files = (c.match(/\[FILE\]/g) ?? []).length;
      const dirs = (c.match(/\[DIR\]/g) ?? []).length;
      if (files || dirs)
        return `${dirs} dir${dirs === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`;
      return clip(c.replace(/\s+/g, " "), 120);
    }
    const keys = Object.keys(o);
    if (keys.length) return clip(keys.join(", "), 80);
  }
  return clip(t.replace(/\s+/g, " "), 140);
}
