// Pure text/number formatters for the CLI — extracted from index.tsx so they
// can be unit-tested offline (the TUI component itself only renders them).

/** 245_000 → "245k" (footer context counter). */
export const kfmt = (n: number): string => `${Math.round(n / 1000)}k`;

/** A displayable message for an unknown thrown value. */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 61_000ms → "1m 1s", 9_000ms → "9s" (turn elapsed time). */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** 1234 → "1.2k", 999 → "999" (token counter). */
export function tokfmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * One /models picker row: active marker, registry id, label, provider,
 * context window, and role tags. The registry id leads because it's what the
 * user selects (and what HEMIUNU_MODEL persists).
 */
export function modelRow(
  m: {
    id: string;
    label: string;
    provider: string;
    contextWindow: number;
    tags?: readonly string[];
  },
  activeId: string,
): string {
  const tags = m.tags?.length ? ` · ${m.tags.join(", ")}` : "";
  return `${m.id === activeId ? "●" : "○"} ${m.id} — ${m.label} · ${m.provider} · ${kfmt(m.contextWindow)} ctx${tags}`;
}
