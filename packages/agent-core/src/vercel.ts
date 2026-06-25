import { execFile, execFileSync, spawn } from "node:child_process";

/**
 * Deploy a prototype to a shareable Vercel URL via the Vercel CLI — used only
 * when the user wants to share. Auth bypasses interactive login when a
 * VERCEL_TOKEN is configured (recommended); otherwise it falls back to an
 * existing `vercel login` session, and if neither is present the caller guides
 * the user to connect.
 */

/** A saved Vercel token (bypasses interactive login), if configured. */
export function resolveVercelToken(): string | undefined {
  return process.env.VERCEL_TOKEN?.trim() || undefined;
}

/** Whether the Vercel CLI is already authenticated (a prior `vercel login`). */
export function vercelLoggedIn(): boolean {
  try {
    execFileSync("vercel", ["whoami"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the Vercel CLI's interactive, browser-based login (no token). It needs the
 * real terminal, so the caller must hand it the TTY (the CLI pauses its TUI).
 * The session is remembered machine-wide, so this is a once-ever step. Resolves
 * true if the user ends up logged in.
 */
export function vercelLogin(): Promise<boolean> {
  return new Promise((res) => {
    try {
      const proc = spawn("vercel", ["login"], { stdio: "inherit" });
      proc.on("exit", () => res(vercelLoggedIn()));
      proc.on("error", () => res(false));
    } catch {
      res(false);
    }
  });
}

export type DeployResult =
  | { url: string }
  | { error: string; needsLogin?: boolean; notInstalled?: boolean };

/**
 * Deploy `dir` to Vercel. Returns the deployment URL, or a reason it couldn't:
 * `notInstalled` (no Vercel CLI), `needsLogin` (no token and not logged in), or
 * a generic error with the CLI output.
 */
export function vercelDeploy(dir: string, opts: { prod?: boolean } = {}): Promise<DeployResult> {
  const token = resolveVercelToken();
  if (!token && !vercelLoggedIn()) {
    return Promise.resolve({ error: "not connected to Vercel", needsLogin: true });
  }
  const args = ["--yes", "--cwd", dir];
  if (opts.prod) args.push("--prod");
  if (token) args.push("--token", token);
  return new Promise((res) => {
    execFile("vercel", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        res({
          error: "Vercel CLI not found — install it (npm i -g vercel) or set VERCEL_TOKEN.",
          notInstalled: true,
        });
        return;
      }
      const out = `${stdout ?? ""}\n${stderr ?? ""}`;
      const m = /https:\/\/[^\s]+\.vercel\.app/.exec(out);
      if (m) res({ url: m[0] });
      else
        res({ error: (String(stderr) || String(stdout)).trim().slice(0, 300) || "deploy failed" });
    });
  });
}
