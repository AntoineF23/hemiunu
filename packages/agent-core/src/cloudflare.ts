import { execFile, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployProvider, DeployResult } from "./deploy";
import { detectPM, hasDevScript, waitForReady } from "./preview";

/**
 * Cloudflare Pages deploy provider (the default). Sharing runs `wrangler pages
 * deploy` as a direct upload — used only when the user wants to share. Each
 * company brings its own free Cloudflare account (no embedded Hemiunu token): a
 * "Cloudflare Pages: Edit" API token plus the account ID are read from the
 * environment (persisted to ~/.hemiunu/.env by the `/cloudflare` connect flow).
 * Wrangler itself is run via `npx`, so no global install is required.
 *
 * Because `wrangler pages deploy` is a direct upload of static assets (no
 * server-side build), hi-fi (Vite/React) prototypes are built locally first;
 * low-fi static HTML is uploaded as-is. This module is registered behind the
 * generic DeployProvider seam in ./deploy.
 */

const WRANGLER = ["--yes", "wrangler@4"];

export interface CloudflareCreds {
  apiToken: string;
  accountId: string;
}

/** The saved Cloudflare credentials, if both the token and account ID are set. */
export function resolveCloudflareCreds(): CloudflareCreds | undefined {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return apiToken && accountId ? { apiToken, accountId } : undefined;
}

/** Whether Cloudflare is connected (token + account ID both present). */
export function cloudflareConfigured(): boolean {
  return !!resolveCloudflareCreds();
}

/**
 * Look up the account ID for a Cloudflare API token, so the connect flow only
 * has to ask the user for the token. Returns the first account the token can
 * see, or an error string. (A Pages:Edit token is scoped to one account.)
 */
export async function fetchCloudflareAccountId(
  apiToken: string,
): Promise<{ accountId: string } | { error: string }> {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { Authorization: `Bearer ${apiToken.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: { id: string }[];
      errors?: { message: string }[];
    } | null;
    if (!res.ok || !body?.success) {
      const msg = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
      return { error: `couldn't verify the token (${msg})` };
    }
    const id = body.result?.[0]?.id;
    if (!id) return { error: "the token has no account access" };
    return { accountId: id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A stable, valid Cloudflare Pages project name derived from the repo slug, so a
 * given prototype always deploys to the same `<name>.pages.dev` URL (updates in
 * place). Names must be lowercase, alphanumeric + hyphens, and ≤58 chars.
 */
export function projectNameFor(repo: string): string {
  const slug = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/g, "");
  return slug || "hemiunu-prototype";
}

/** Run a command to completion, resolving its combined output (rejects on non-zero exit). */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}\n${stderr ?? ""}`;
        if (err) {
          (err as Error & { output?: string }).output = out;
          rej(err);
        } else res(out);
      },
    );
  });
}

/** Ensure deps are installed (first run only), mirroring the preview server. */
function ensureInstalled(dir: string, pm: "pnpm" | "yarn" | "npm"): Promise<void> {
  if (existsSync(join(dir, "node_modules"))) return Promise.resolve();
  return new Promise((res, rej) => {
    const inst = spawn(pm, ["install"], { cwd: dir, stdio: "ignore" });
    inst.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`${pm} install failed (${code})`)),
    );
    inst.on("error", rej);
  });
}

/**
 * Build `dir` if it's a framework project, returning the directory of static
 * assets to upload. Low-fi (no dev script) uploads the workspace as-is; hi-fi
 * (Vite/React) is installed + built, and we add a `_redirects` SPA fallback so
 * client-side deep links resolve.
 */
async function buildIfNeeded(dir: string): Promise<string> {
  if (!hasDevScript(dir)) return dir;
  const pm = detectPM(dir);
  await ensureInstalled(dir, pm);
  await run(pm, ["run", "build"], { cwd: dir });
  const out = existsSync(join(dir, "dist"))
    ? join(dir, "dist")
    : existsSync(join(dir, "build"))
      ? join(dir, "build")
      : dir;
  // SPA fallback — only into the build output, so we never touch the workspace
  // git tree. Harmless for a single-page prototype.
  if (existsSync(join(out, "index.html"))) {
    try {
      writeFileSync(join(out, "_redirects"), "/* /index.html 200\n", "utf8");
    } catch {
      // best effort — deep links may 404 but the root still serves
    }
  }
  return out;
}

/**
 * Deploy `dir` to Cloudflare Pages under a stable project name. Returns the
 * deployment URL, or a reason it couldn't: `needsLogin` (no token/account),
 * `notInstalled` (npx/wrangler unavailable), or a generic error with output.
 */
export async function cloudflareDeploy(
  dir: string,
  opts: { prod?: boolean; projectName: string },
): Promise<DeployResult> {
  const creds = resolveCloudflareCreds();
  if (!creds) return { error: "not connected to Cloudflare", needsLogin: true };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: creds.apiToken,
    CLOUDFLARE_ACCOUNT_ID: creds.accountId,
  };
  const name = opts.projectName;
  const branch = opts.prod ? "main" : "preview";

  let buildDir: string;
  try {
    buildDir = await buildIfNeeded(dir);
  } catch (e) {
    const out = (e as Error & { output?: string }).output ?? (e instanceof Error ? e.message : "");
    return { error: `build failed: ${out.trim().slice(0, 300) || "unknown error"}` };
  }

  try {
    // Create the project once; ignore "already exists" so re-deploys update it.
    try {
      await run(
        "npx",
        [...WRANGLER, "pages", "project", "create", name, "--production-branch", "main"],
        { env },
      );
    } catch (e) {
      const out = (e as Error & { output?: string }).output ?? "";
      if (!/already exists/i.test(out)) throw e;
    }

    const out = await run(
      "npx",
      [...WRANGLER, "pages", "deploy", buildDir, "--project-name", name, "--branch", branch],
      { env },
    );
    const m = /https:\/\/[^\s]+\.pages\.dev/.exec(out);
    if (!m) return { error: out.trim().slice(0, 300) || "deploy reported no URL" };
    // The upload succeeds before the URL is actually serving — a fresh
    // `<hash>.<project>.pages.dev` subdomain needs DNS + its TLS certificate to
    // provision, which is what causes the "can't provide a secure connection"
    // error if the link is shared too early. Poll over HTTPS until it responds
    // (a failed TLS handshake makes fetch throw, so this gates on the cert too).
    // If it's still not ready after a couple of minutes, hand back the URL with
    // a `pending` flag so the caller can explain the wait rather than stall.
    const ready = await waitForReady(m[0], 120_000);
    return { url: m[0], pending: !ready };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        error: "Couldn't run Wrangler via npx — ensure Node/npm is installed.",
        notInstalled: true,
      };
    }
    const out = (e as Error & { output?: string }).output ?? (e instanceof Error ? e.message : "");
    return { error: out.trim().slice(0, 300) || "deploy failed" };
  }
}

/** Cloudflare Pages as a generic DeployProvider (see ./deploy). */
export const cloudflareProvider: DeployProvider = {
  id: "cloudflare",
  label: "Cloudflare Pages",
  isConfigured: cloudflareConfigured,
  connectHint: () =>
    "Not connected to Cloudflare. Ask the user to run /cloudflare (or use the web Settings panel) and paste a Cloudflare API token (Pages: Edit). Then try again.",
  // The provider owns naming so each host can apply its own slug rules.
  deploy: (dir, opts) =>
    cloudflareDeploy(dir, { prod: opts.prod ?? true, projectName: projectNameFor(opts.repo) }),
};
