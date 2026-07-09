import { spawn } from "node:child_process";

/**
 * Open a URL or file path in the OS default app (best-effort; never throws).
 * No-op when HEMIUNU_NO_OPEN is set (headless / test runs).
 *
 * On Windows `start` is a cmd.exe builtin, not an executable, so spawning it
 * directly ENOENTs — it must be run via `cmd /c start "" <target>` (the empty
 * "" is start's title argument, so a quoted target isn't mistaken for one).
 */
export function openExternal(target: string): void {
  if (process.env.HEMIUNU_NO_OPEN) return;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target]]
        : ["xdg-open", [target]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort — the caller still reports the URL/path to the user
  }
}
