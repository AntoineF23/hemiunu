import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const PLACEHOLDER_KEY = "sk-your-litellm-key-here";

/** Hemiunu's per-user config + data dir (keys, conversations, folder-trust). */
export function configDir(): string {
  return process.env.HEMIUNU_CONFIG_DIR ?? join(homedir(), ".hemiunu");
}

// Load .env from EVERY place it may live — the user's config dir (~/.hemiunu),
// Hemiunu's home (install/repo dir), and the cwd — in that precedence order.
// Earlier files (and the real shell environment) win: a var already set is never
// overwritten. This matters because per-user secrets (e.g. a GitHub token saved
// to ~/.hemiunu/.env) must coexist with a repo-local .env that holds other keys,
// rather than one file shadowing the other.
function loadEnvFiles(): void {
  const home = process.env.HEMIUNU_HOME ?? process.cwd();
  const files = [join(configDir(), ".env"), join(home, ".env"), join(process.cwd(), ".env")];
  const seen = new Set<string>();
  for (const path of files) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue; // blank line or comment
        const key = m[1];
        let val = m[2];
        if (/^"[\s\S]*"$/.test(val) || /^'[\s\S]*'$/.test(val)) val = val.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = val;
      }
    } catch {
      // ignore — env may already be populated by the shell
    }
  }
}
loadEnvFiles();

/**
 * Create or update a single var in the per-user `~/.hemiunu/.env`, preserving the
 * rest of the file, and apply it to this process immediately. Used to remember
 * credentials (e.g. a GitHub token) so the user is asked only once.
 */
export function upsertUserEnv(key: string, value: string): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".env");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  const next = lines.map((l) => (re.test(l) ? ((found = true), `${key}=${value}`) : l));
  if (!found) next.push(`${key}=${value}`);
  writeFileSync(path, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf8");
  process.env[key] = value;
  return path;
}

/** True once a real (non-placeholder) API key is configured. */
export function hasApiKey(): boolean {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim().length > 0 && k !== PLACEHOLDER_KEY;
}

export interface UserEnv {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  notionToken?: string;
  tavilyKey?: string;
}

/**
 * Write the user's keys to `~/.hemiunu/.env` and apply them to this process so
 * the current run picks them up immediately. Used by the first-run setup flow.
 */
export function writeUserEnv(env: UserEnv): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const baseUrl = env.baseUrl?.trim();
  // No base URL = talk to Anthropic directly; only write the line if the user
  // set a gateway/proxy.
  const lines = [`ANTHROPIC_API_KEY=${env.apiKey}`];
  if (baseUrl) lines.unshift(`ANTHROPIC_BASE_URL=${baseUrl}`);
  if (env.model) lines.push(`HEMIUNU_MODEL=${env.model}`);
  if (env.notionToken) lines.push(`NOTION_TOKEN=${env.notionToken}`);
  if (env.tavilyKey) lines.push(`TAVILY_API_KEY=${env.tavilyKey}`);
  const path = join(dir, ".env");
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

  process.env.ANTHROPIC_API_KEY = env.apiKey;
  if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl;
  if (env.model) process.env.HEMIUNU_MODEL = env.model;
  if (env.notionToken) process.env.NOTION_TOKEN = env.notionToken;
  if (env.tavilyKey) process.env.TAVILY_API_KEY = env.tavilyKey;
  return path;
}

export interface HemiunuConfig {
  /** Anthropic-compatible endpoint for the Claude brain. Undefined = Anthropic
   *  direct (api.anthropic.com); set it to a gateway/proxy (LiteLLM, etc.). */
  baseUrl: string | undefined;
  /** API key for the brain endpoint (your Anthropic key, or your gateway key). */
  apiKey: string;
  /** Main / synthesis model — the agent's brain (e.g. "claude-opus-4.8"). */
  model: string;
  /** Retrieval tier — the cheaper model the `researcher` subagent runs on.
   *  Defaults to Sonnet (~5× cheaper than Opus). NB: claude-haiku-4.5 is NOT
   *  usable here — the proxy/SDK always send an `effort` param it rejects. */
  researchModel: string;
  /** Thinking config. Set explicitly: the engine's default sends effort 'xhigh',
   *  which non-Opus models (e.g. Sonnet 4.6) reject. Disabled = cheaper & works
   *  everywhere; set HEMIUNU_THINKING_BUDGET (tokens) to enable reasoning. */
  thinking: Options["thinking"];
}

export function loadConfig(): HemiunuConfig {
  // Undefined base URL = talk to Anthropic directly; set ANTHROPIC_BASE_URL to
  // route the brain through a gateway/proxy instead.
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const model = process.env.HEMIUNU_MODEL ?? "claude-opus-4.8";
  const researchModel = process.env.HEMIUNU_MODEL_RESEARCH ?? "claude-sonnet-4.6";

  const budget = Number.parseInt(process.env.HEMIUNU_THINKING_BUDGET ?? "0", 10);
  const thinking: Options["thinking"] =
    budget > 0 ? { type: "enabled", budgetTokens: budget } : { type: "disabled" };

  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY. Run `hemiunu` and complete first-run setup.");
  }
  return { baseUrl, apiKey, model, researchModel, thinking };
}
