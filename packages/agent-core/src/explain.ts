import { isTimeoutError } from "./net";

/**
 * Turn a raw error / HTTP failure into ONE plain-language line a non-coder can
 * act on. The audience is a product team, not engineers, so "socket hang up" or
 * "403" becomes "couldn't reach the network" / "reconnect with /github". Falls
 * back to the raw message when we don't recognise it (better than hiding it).
 */
export function explainError(e: unknown): string {
  if (isTimeoutError(e)) return "the request timed out — check your connection and try again";
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code;
  const status = (e as { status?: number } | null)?.status ?? statusFromMessage(msg);

  if (status === 401) return "GitHub didn't accept the credentials — reconnect with /github";
  if (status === 403)
    return "access was refused or you've hit GitHub's rate limit — wait a minute, then retry (reconnect with /github if it persists)";
  if (status === 404) return "GitHub couldn't find that repo or file — check the team is correct";
  if (status === 409 || status === 422)
    return "the file changed at the same time — please try again";
  if (status && status >= 500) return "GitHub had a server error — try again in a moment";
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    /fetch failed|network|getaddrinfo|socket hang up/i.test(msg)
  )
    return "couldn't reach the network — check your internet connection";
  return msg;
}

/** Pull a 3-digit HTTP status out of an error message like "GitHub PUT x: 403 …". */
function statusFromMessage(msg: string): number | undefined {
  const m = /\b([45]\d{2})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
}
