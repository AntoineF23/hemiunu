#!/usr/bin/env node
// MCP server working-directory sandbox.
//
// The Claude Agent SDK spawns each stdio MCP server with no per-server `cwd`
// option, so they inherit Hemiunu's launch dir (the user's project). A server
// that writes relative paths then litters that project — e.g. Playwright drops
// a `.playwright-mcp/` snapshot folder. We don't want ANY user-added MCP server
// touching the launch folder; the agent only writes to ~/.hemiunu/tmp or the
// team's remote repo.
//
// So Hemiunu injects this shim as the spawn command for every external stdio
// server (the `filesystem` server is exempt — reading the project IS its job).
// The shim makes a throwaway working dir, chdir's into it, then execs the real
// server with stdio passed straight through, transparent to the MCP transport.
//
// Argv: <cwd> <command> [args...]
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const [cwd, command, ...args] = process.argv.slice(2);
if (!cwd || !command) {
  console.error("mcp-in-dir: usage: mcp-in-dir.mjs <cwd> <command> [args...]");
  process.exit(2);
}

mkdirSync(cwd, { recursive: true });

const child = spawn(command, args, {
  cwd,
  // Pass our stdio (which the SDK is talking to) straight through to the real
  // server, so the JSON-RPC stream flows untouched. The shim never reads/writes
  // the pipes itself.
  stdio: "inherit",
  env: process.env,
  // npx/.cmd launchers need a shell on Windows; spawn the binary directly elsewhere.
  shell: process.platform === "win32",
});

// Propagate termination both ways: the SDK killing the shim must kill the real
// server (no orphan), and the server's exit code/signal must surface as ours.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(`mcp-in-dir: failed to launch ${command}: ${err.message}`);
  process.exit(1);
});
