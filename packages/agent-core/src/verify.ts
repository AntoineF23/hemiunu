import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Build verification for framework prototypes. The dev server serves modules
 * on demand, so it answers HTTP 200 (with an error overlay) even when a
 * component doesn't compile — the preview readiness gate alone can't tell a
 * working build from a broken one. This runs the project's own compiler and
 * hands the errors back to the agent so it can repair the build BEFORE the
 * prototype is presented to the user as done.
 */

export interface VerifyResult {
  ok: boolean;
  /** One line: what was checked, or why the check was skipped. */
  note: string;
  /** Compiler output when ok is false (capped — see capOutput). */
  output?: string;
}

/** Keep compiler output small enough to hand back to the model. Exported for tests. */
export function capOutput(s: string, max = 4000): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… (output truncated — fix these first, then check again)`;
}

/** Run a bounded local binary and collect its combined output. */
function runCheck(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const proc = spawn(bin, args, { cwd });
    let out = "";
    const onData = (b: Buffer) => {
      out += b.toString();
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code, out });
    };
    const timer = setTimeout(() => {
      proc.kill();
      out += `\n(check timed out after ${Math.round(timeoutMs / 1000)}s)`;
      settle(1);
    }, timeoutMs);
    proc.on("error", (e) => {
      out += `\n${e.message}`;
      settle(1);
    });
    proc.on("exit", (code) => settle(code));
  });
}

/**
 * Verify the prototype in `dir` actually compiles. Prefers a real type check
 * (`tsc --noEmit`, when the scaffold has a tsconfig.json) and falls back to a
 * production bundle (`vite build`, which catches syntax errors and broken
 * imports even without a tsconfig). Best-effort by design: a static HTML
 * wireframe, a project without TypeScript, or a workspace whose dependencies
 * aren't installed yet reports ok with a note — never a false failure.
 */
export async function verifyPrototype(dir: string): Promise<VerifyResult> {
  if (!existsSync(join(dir, "package.json"))) {
    return { ok: true, note: "static prototype (no package.json) — nothing to compile" };
  }
  const bins = join(dir, "node_modules", ".bin");
  const tsc = join(bins, "tsc");
  const vite = join(bins, "vite");
  if (!existsSync(tsc) && !existsSync(vite)) {
    return {
      ok: true,
      note: "dependencies not installed yet — run iterate_prototype first (it installs them), then check again",
    };
  }
  const useTsc = existsSync(tsc) && existsSync(join(dir, "tsconfig.json"));
  const { code, out } = useTsc
    ? await runCheck(tsc, ["--noEmit", "--pretty", "false"], dir, 120_000)
    : await runCheck(vite, ["build"], dir, 120_000);
  const what = useTsc ? "TypeScript check (tsc --noEmit)" : "production build (vite build)";
  if (code === 0) return { ok: true, note: `${what} passed` };
  return { ok: false, note: `${what} failed`, output: capOutput(out) };
}
