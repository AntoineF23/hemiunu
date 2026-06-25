/**
 * Shared timeout for one-shot HTTP calls (LLM providers, GitHub). Without this a
 * hung or slow endpoint blocks a tool — and therefore the whole turn —
 * indefinitely. Every `fetch` that talks to a third party should pass
 * `signal: timeoutSignal()` so a stall surfaces as a clear error instead of a
 * hang the user can only escape by killing the process.
 */

/** Per-request network timeout in ms (override with HEMIUNU_FETCH_TIMEOUT_MS). */
export function fetchTimeoutMs(): number {
  const n = Number(process.env.HEMIUNU_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * An AbortSignal that fires after `ms`. Optionally combined with a caller's
 * signal (e.g. the turn's AbortController) so EITHER a timeout OR an
 * Esc-interrupt cancels the request.
 */
export function timeoutSignal(ms: number = fetchTimeoutMs(), linked?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return linked ? AbortSignal.any([linked, timeout]) : timeout;
}

/** True when an error is the abort thrown by `AbortSignal.timeout`. */
export function isTimeoutError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "TimeoutError";
}
