// Pure render formatters COPIED verbatim from apps/cli/src/index.tsx (lines
// ~198–279). Duplicated on purpose: the engine must stay untouched, and lifting
// these into agent-core would be an engine change. Keep in sync with the CLI.

const HOME_DIR = process.env.HOME ?? "";

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const title = (p: string) => clip(p.replace(/\s+/g, " ").trim(), 60);

/** A long uuid → its first segment, so ids read as `38835e52…` not a wall. */
const shortId = (id: string) => (id.length > 12 ? `${id.split("-")[0]}…` : id);
const shortPath = (p: string) =>
  HOME_DIR && p.startsWith(HOME_DIR) ? `~${p.slice(HOME_DIR.length)}` : p;

/** mcp__notion__notion-search → notion·notion-search */
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

/** Render a tool call's input as the one argument that matters, not raw JSON. */
export function toolPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (str(i.query)) return `“${clip(str(i.query), 60)}”`;
  if (str(i.pattern)) return clip(str(i.pattern), 60);
  if (str(i.path)) return clip(shortPath(str(i.path)), 60);
  if (str(i.page_id)) return shortId(str(i.page_id));
  if (str(i.data_source_id)) return shortId(str(i.data_source_id));
  if (str(i.mcp)) return str(i.mcp);
  if (str(i.prompt)) return `“${clip(str(i.prompt), 60)}”`;
  const firstStr = Object.values(i).find((v) => typeof v === "string" && v.trim()) as
    | string
    | undefined;
  return firstStr ? clip(firstStr.trim(), 60) : "";
}

/** Turn a tool result into a short human line instead of dumping its JSON. */
export function summarizeResult(text: string): string {
  const t = text.trim();
  if (!t) return "done";
  if (/^(Error|EPERM|ENOENT|EACCES|EISDIR)/i.test(t))
    return `⚠ ${clip(t.replace(/\s+/g, " "), 120)}`;
  let j: any;
  try {
    j = JSON.parse(t);
  } catch {
    return clip(t.replace(/\s+/g, " "), 140);
  }
  if (j && typeof j === "object") {
    if (Array.isArray(j.results)) {
      const n = j.results.length;
      return n === 0 ? "no results" : `${n}${j.has_more ? "+" : ""} result${n === 1 ? "" : "s"}`;
    }
    if (typeof j.markdown === "string") {
      const first =
        j.markdown.replace(/^[>#\s]+/, "").split("\n").find((l: string) => l.trim()) ?? "";
      return first ? `“${clip(first.trim(), 90)}”` : "empty page";
    }
    if (typeof j.content === "string") {
      const c = j.content;
      const files = (c.match(/\[FILE\]/g) ?? []).length;
      const dirs = (c.match(/\[DIR\]/g) ?? []).length;
      if (files || dirs)
        return `${dirs} dir${dirs === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`;
      return clip(c.replace(/\s+/g, " "), 120);
    }
    const keys = Object.keys(j);
    if (keys.length) return clip(keys.join(", "), 80);
  }
  return clip(t.replace(/\s+/g, " "), 140);
}
