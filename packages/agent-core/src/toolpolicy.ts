import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { configDir, writeSecretFile } from "./config";

/**
 * Persistent per-tool / per-server permission policy for MCP tools, so a user
 * can decide once whether a tool is auto-allowed, always asked, or blocked —
 * and have it stick across turns and restarts (unlike the session-only
 * "always allow" set). Stored in ~/.hemiunu/tool-policy.json.
 *
 * Resolution order for a tool id: a per-tool override wins, else the per-server
 * default, else "ask" (the safe default — prompt the user).
 */

export type ToolPolicy = "allow" | "ask" | "block";

export interface ToolPolicyFile {
  /** Per-server default, keyed by server name (e.g. "filesystem"). */
  servers: Record<string, ToolPolicy>;
  /** Per-tool override, keyed by full tool id (e.g. "mcp__filesystem__read_file"). */
  tools: Record<string, ToolPolicy>;
  /** Tool ids observed in use, per server — so the UI can list real tools. */
  seen: Record<string, string[]>;
}

function policyPath(root: string): string {
  return join(root, "tool-policy.json");
}

export function loadToolPolicy(root: string = configDir()): ToolPolicyFile {
  const p = policyPath(root);
  if (!existsSync(p)) return { servers: {}, tools: {}, seen: {} };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<ToolPolicyFile>;
    return { servers: j.servers ?? {}, tools: j.tools ?? {}, seen: j.seen ?? {} };
  } catch {
    return { servers: {}, tools: {}, seen: {} };
  }
}

function save(cfg: ToolPolicyFile, root: string): void {
  mkdirSync(root, { recursive: true });
  writeSecretFile(policyPath(root), `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Server name from a tool id: `mcp__filesystem__read_file` → `filesystem` (else ""). */
export function serverOf(toolId: string): string {
  if (!toolId.startsWith("mcp__")) return "";
  const rest = toolId.slice(5);
  const i = rest.indexOf("__");
  return i >= 0 ? rest.slice(0, i) : rest;
}

/** Set (or clear, when "ask") a server's default policy. */
export function setServerPolicy(
  server: string,
  policy: ToolPolicy,
  root: string = configDir(),
): void {
  const cfg = loadToolPolicy(root);
  if (policy === "ask") delete cfg.servers[server];
  else cfg.servers[server] = policy;
  save(cfg, root);
}

/** Set (or clear, when "ask") a single tool's override. */
export function setToolPolicy(tool: string, policy: ToolPolicy, root: string = configDir()): void {
  const cfg = loadToolPolicy(root);
  if (policy === "ask") delete cfg.tools[tool];
  else cfg.tools[tool] = policy;
  save(cfg, root);
}

/** Effective policy for a tool id: per-tool override > per-server default > "ask". */
export function resolveToolPolicy(
  toolId: string,
  cfg: ToolPolicyFile = loadToolPolicy(),
): ToolPolicy {
  if (cfg.tools[toolId]) return cfg.tools[toolId];
  const s = serverOf(toolId);
  if (s && cfg.servers[s]) return cfg.servers[s];
  return "ask";
}

/** Remember a tool id as "seen in use" so the UI can list real tools per server.
 *  Skips Hemiunu's own internal servers (memory, sources, …) — only user MCPs. */
export function recordSeenTool(toolId: string, root: string = configDir()): void {
  const s = serverOf(toolId);
  if (!s || s.startsWith("hemiunu")) return;
  const cfg = loadToolPolicy(root);
  const arr = cfg.seen[s] ?? [];
  if (arr.includes(toolId)) return;
  arr.push(toolId);
  arr.sort();
  cfg.seen[s] = arr;
  save(cfg, root);
}

/**
 * Replace a server's full "seen" tool list authoritatively — used when we
 * enumerate every tool a server exposes (via `enumerateServerTools`) at add /
 * refresh time, so the panel shows the COMPLETE inventory up front rather than
 * the lazily-discovered subset `recordSeenTool` accretes. Bare tool names are
 * normalised to full ids (`mcp__<server>__<name>`); existing per-tool policies
 * are untouched (they're keyed separately). No-op for Hemiunu's own servers.
 */
export function setSeenTools(server: string, toolIds: string[], root: string = configDir()): void {
  if (!server || server.startsWith("hemiunu")) return;
  const prefix = `mcp__${server}__`;
  const ids = [
    ...new Set(toolIds.map((t) => (t.startsWith("mcp__") ? t : `${prefix}${t}`))),
  ].sort();
  const cfg = loadToolPolicy(root);
  cfg.seen[server] = ids;
  save(cfg, root);
}

/**
 * A PreToolUse hook that refuses any tool the USER has explicitly set to
 * "block" in the MCP panel — and ONLY those (never anything automatic, so a
 * genuinely useful tool is never caught). Unlike the web `canUseTool` gate, a
 * PreToolUse hook also fires inside auto-approving subagent / scanner sub-runs
 * (SDK PreToolUse denies bypass canUseTool), so a block finally means block
 * everywhere — main agent and any delegated work alike.
 */
export function createPolicyBlockHook(): NonNullable<Options["hooks"]> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const name = (input as { tool_name?: string }).tool_name ?? "";
            if (resolveToolPolicy(name) !== "block") return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason:
                  "Blocked in your MCP settings. Change it to Allow or Ask in the MCP panel to use this tool.",
              },
            };
          },
        ],
      },
    ],
  };
}
