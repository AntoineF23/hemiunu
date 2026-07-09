#!/usr/bin/env node
// Launcher for the Hemiunu web app. Resolves the install dir from this script's
// location (like bin/hemiunu.mjs), sets HEMIUNU_HOME (where soul.md / mcp.json /
// repo .env live), and starts the worker (tsx) + client (vite) directly — no
// pnpm, no concurrently — so it works from any directory and never depends on
// pnpm being on PATH.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireNode } from "./require-node.mjs";

requireNode();

const home = join(dirname(fileURLToPath(import.meta.url)), ".."); // repo / install root
const webDir = join(home, "apps", "web");

// Prefer the web package's .bin (pnpm links deps there); fall back to the root.
const bin = (name) => {
  const local = join(webDir, "node_modules", ".bin", name);
  return existsSync(local) ? local : join(home, "node_modules", ".bin", name);
};

const env = {
  ...process.env,
  HEMIUNU_HOME: home,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim(),
};

const children = [
  spawn(bin("tsx"), ["watch", "src/server/index.ts"], { cwd: webDir, env, stdio: "inherit" }),
  spawn(bin("vite"), [], { cwd: webDir, env, stdio: "inherit" }),
];

let exiting = false;
const shutdown = (code = 0) => {
  if (exiting) return;
  exiting = true;
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const c of children) {
  c.on("exit", (code) => shutdown(code ?? 0));
  c.on("error", (err) => {
    console.error("Failed to launch Hemiunu web:", err.message);
    shutdown(1);
  });
}

console.log("Hemiunu web → http://127.0.0.1:5173  (worker on :4317)");
