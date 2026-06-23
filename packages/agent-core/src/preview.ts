import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

/**
 * Localhost preview for fast iteration. One preview runs at a time (per process).
 * Framework projects (a package.json with a `dev` script) run their own dev
 * server with HMR; anything else is served by a tiny built-in static server.
 * Either way the agent edits files in the workspace and the browser reflects it.
 */

interface Running {
  repo: string;
  url: string;
  stop: () => void;
}

let current: Running | null = null;

export function previewStatus(): { repo: string; url: string } | null {
  return current ? { repo: current.repo, url: current.url } : null;
}

export function stopPreview(): void {
  if (!current) return;
  try {
    current.stop();
  } catch {
    // best effort
  }
  current = null;
}

function openUrl(url: string): void {
  if (process.env.HEMIUNU_NO_OPEN) return; // headless / tests
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort — the URL is reported regardless
  }
}

function detectPM(dir: string): "pnpm" | "yarn" | "npm" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function hasDevScript(dir: string): boolean {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return false;
  try {
    return !!(JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: { dev?: string } }).scripts?.dev;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Minimal sandboxed static file server (self-contained HTML prototypes). */
function startStatic(dir: string): Promise<Running> {
  return new Promise((res) => {
    const server = createServer((req, reply) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        let file = resolve(dir, rel);
        if (file !== dir && !file.startsWith(dir + sep)) {
          reply.writeHead(403);
          reply.end();
          return;
        }
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
        if (!existsSync(file)) {
          reply.writeHead(404);
          reply.end("Not found");
          return;
        }
        reply.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
        createReadStream(file).pipe(reply);
      } catch {
        reply.writeHead(500);
        reply.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ repo: "", url: `http://localhost:${port}`, stop: () => server.close() });
    });
  });
}

/** Run the project's own dev server (npm install on first run), resolve its URL. */
async function startDevServer(dir: string): Promise<Running> {
  const pm = detectPM(dir);
  if (!existsSync(join(dir, "node_modules"))) {
    await new Promise<void>((res, rej) => {
      const inst = spawn(pm, ["install"], { cwd: dir, stdio: "ignore" });
      inst.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${pm} install failed (${code})`))));
      inst.on("error", rej);
    });
  }
  return new Promise((res, rej) => {
    const proc = spawn(pm, ["run", "dev"], { cwd: dir });
    let settled = false;
    const onData = (b: Buffer) => {
      const m = /http:\/\/localhost:\d+/.exec(b.toString());
      if (m && !settled) {
        settled = true;
        res({ repo: "", url: m[0], stop: () => proc.kill() });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        rej(new Error(`dev server exited before reporting a URL (${code})`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        rej(new Error("dev server didn't report a localhost URL within 90s"));
      }
    }, 90_000);
  });
}

/**
 * Start (or reuse) the localhost preview for `repo` served from `dir`, and open
 * the browser. Reuses the running preview if it's already for this repo.
 */
export async function startPreview(repo: string, dir: string): Promise<{ url: string } | { error: string }> {
  if (current?.repo === repo) return { url: current.url };
  stopPreview();
  try {
    const running = hasDevScript(dir) ? await startDevServer(dir) : await startStatic(dir);
    running.repo = repo;
    current = running;
    openUrl(running.url);
    return { url: running.url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
