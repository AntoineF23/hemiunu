// Builds the publishable `hemiunu` npm package into ./release.
//
// Dev runs buildless via tsx, but you can't `npm publish` raw .ts with
// `workspace:*` deps a consumer can't resolve. So we bundle: esbuild inlines
// the four @hemiunu/* workspace packages into one dist/cli.js and leaves the
// handful of real third-party deps external (declared in the generated
// package.json, installed normally — better-sqlite3 is native and *must* stay
// external). The result in ./release is a self-contained package: `npm pack`
// or `npm publish` from there, and `npx hemiunu` works on a clean machine.
import esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const VERSION = "0.1.0";

// Third-party deps left external: required from node_modules at runtime exactly
// as in dev. React's runtime entry points are subpaths, so list them too.
const externalDeps = {
  "@anthropic-ai/claude-agent-sdk": "^0.3.185",
  "better-sqlite3": "^11.8.0",
  ink: "^7.1.0",
  "ink-text-input": "^6.0.0",
  react: "^19.2.7",
  zod: "^4.4.3",
};
const external = [
  ...Object.keys(externalDeps),
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

console.log("• cleaning release/");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });
mkdirSync(join(out, "bin"), { recursive: true });

console.log("• bundling CLI → release/dist/cli.js");
await esbuild.build({
  entryPoints: [join(root, "apps/cli/src/index.tsx")],
  outfile: join(out, "dist/cli.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  jsx: "automatic",
  // Stamp the version into the bundle so `hemiunu --version` reports it.
  define: { "process.env.HEMIUNU_VERSION": JSON.stringify(VERSION) },
  // @hemiunu/* are inlined (not listed here); everything below is external.
  external,
  logLevel: "info",
});

console.log("• copying assets (context/, mcp.json, assets/, README, LICENSE)");
for (const rel of ["context", "mcp.json", "assets", "README.md", "LICENSE"]) {
  cpSync(join(root, rel), join(out, rel), { recursive: true });
}
cpSync(join(root, "bin/require-node.mjs"), join(out, "bin/require-node.mjs"));
// The MCP cwd sandbox shim — injected as the spawn command for stdio servers
// so their output stays out of the user's project (see bin/mcp-in-dir.mjs).
cpSync(join(root, "bin/mcp-in-dir.mjs"), join(out, "bin/mcp-in-dir.mjs"));

console.log("• writing release/bin/hemiunu.mjs launcher");
writeFileSync(
  join(out, "bin/hemiunu.mjs"),
  `#!/usr/bin/env node
// Production launcher for the published package. Spawns the bundled CLI as a
// child so we can pass NODE_OPTIONS (to silence Node's experimental-feature
// warnings from deps) — a flag a process can't set for itself. Sets HEMIUNU_HOME
// to the package root (where context/soul.md + mcp.json ship) and keeps the
// caller's cwd as the agent's file scope. stdio is inherited so the TUI keeps
// the TTY. Dev uses the repo-root bin/hemiunu.mjs (tsx); this is its built twin.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireNode } from "./require-node.mjs";

requireNode();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

// --disable-warning landed in Node 20.11; guard so we never pass an unknown
// flag to an older 20.x (which would refuse to start).
let nodeOptions = process.env.NODE_OPTIONS ?? "";
if (process.allowedNodeEnvironmentFlags.has("--disable-warning")) {
  nodeOptions = \`\${nodeOptions} --disable-warning=ExperimentalWarning\`.trim();
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(), // the folder the user launched from — the agent's file scope
  env: {
    ...process.env,
    HEMIUNU_HOME: process.env.HEMIUNU_HOME ?? root,
    NODE_OPTIONS: nodeOptions,
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to launch Hemiunu:", err.message);
  process.exit(1);
});
`,
);

console.log("• writing release/package.json");
const pkg = {
  name: "hemiunu",
  version: VERSION,
  description:
    "An open-source product agent for your terminal — turn a product idea into a working prototype PR. Bring your own model key.",
  license: "MIT",
  type: "module",
  bin: { hemiunu: "bin/hemiunu.mjs" },
  engines: { node: ">=20" },
  files: ["dist", "bin", "context", "mcp.json", "assets", "README.md", "LICENSE"],
  dependencies: externalDeps,
};
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log("\n✓ release/ built. Test:  cd release && npm pack");
