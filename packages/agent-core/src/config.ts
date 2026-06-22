import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLACEHOLDER_KEY = "sk-your-litellm-key-here";

/** Hemiunu's per-user config + data dir (keys, conversations, folder-trust). */
export function configDir(): string {
  return process.env.HEMIUNU_CONFIG_DIR ?? join(homedir(), ".hemiunu");
}

// Load .env from the first place it exists: the user's config dir (installed
// users), then Hemiunu's home (the install/repo dir), then the cwd. Node 24 builtin.
function pickEnvFile(): string | undefined {
  const home = process.env.HEMIUNU_HOME ?? process.cwd();
  for (const p of [join(configDir(), ".env"), join(home, ".env"), join(process.cwd(), ".env")]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}
const ENV_FILE = pickEnvFile();
if (ENV_FILE) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // ignore — env may already be populated by the shell
  }
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
