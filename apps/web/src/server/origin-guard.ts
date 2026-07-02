import type { Context, Next } from "hono";

/**
 * DNS-rebinding / cross-origin guard for the local worker's /api/* surface.
 * A malicious web page must not be able to POST to this local worker. We allow
 * only same-origin localhost callers; a same-origin request (or a top-level
 * navigation) omits the Origin header, so a missing Origin is allowed — the OS
 * user is the real auth boundary. A present Origin must resolve to a loopback
 * hostname, otherwise it's rejected with 403.
 */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true; // same-origin / non-CORS request
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false; // malformed Origin
  }
  return host === "127.0.0.1" || host === "localhost";
}

/** Hono middleware enforcing {@link isAllowedOrigin} on /api/* routes. */
export async function originGuard(c: Context, next: Next): Promise<Response | void> {
  const origin = c.req.header("origin");
  if (origin === undefined) return next();
  if (!isAllowedOrigin(origin)) {
    const bad = (() => {
      try {
        new URL(origin);
        return false;
      } catch {
        return true;
      }
    })();
    return c.json({ error: bad ? "bad origin" : "forbidden origin" }, 403);
  }
  return next();
}
