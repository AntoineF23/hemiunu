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
 * The auto-compaction trigger fraction from the raw HEMIUNU_COMPACT_THRESHOLD
 * env value. Clamped to [0.1, 0.95]; a missing or non-numeric value falls back
 * to 0.5 — NaN must never escape, or `ctxTokens >= ctxWindow * COMPACT_AT`
 * would always be false and auto-compaction would silently never fire.
 */
export function compactAt(raw: string | undefined): number {
  const n = Number(raw ?? 0.5);
  return Math.min(0.95, Math.max(0.1, Number.isFinite(n) ? n : 0.5));
}
