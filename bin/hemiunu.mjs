#!/usr/bin/env node
// Launcher for the `hemiunu` command. Resolves Hemiunu's install dir from this
// script's own location and runs the CLI there via tsx, while keeping the
// caller's working directory (so the agent reads files from where you ran it).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireNode } from "./require-node.mjs";

requireNode();

const home = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(home, "node_modules", ".bin", "tsx");
const entry = join(home, "apps", "cli", "src", "index.tsx");

const child = spawn(tsx, [entry], {
  stdio: "inherit",
  cwd: process.cwd(), // the folder the user launched from — what the agent can read
  env: {
    ...process.env,
    HEMIUNU_HOME: home, // where soul.md / mcp.json / .env live
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim(),
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to launch Hemiunu:", err.message);
  process.exit(1);
});
