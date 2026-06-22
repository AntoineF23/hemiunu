import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Load .env from Hemiunu's home (the install dir, set by the `hemiunu` launcher)
// when present, else the current directory (running from the repo). Node 24 builtin.
const ENV_PATH = join(process.env.HEMIUNU_HOME ?? process.cwd(), ".env");
if (existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    // ignore — env may already be populated by the shell
  }
}

export interface HemiunuConfig {
  /** Base URL of the Anthropic-compatible endpoint (here: the LiteLLM proxy). */
  baseUrl: string;
  /** API key / token sent to the proxy. */
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
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://models.thiga.co";
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const model = process.env.HEMIUNU_MODEL ?? "claude-opus-4.8";
  const researchModel = process.env.HEMIUNU_MODEL_RESEARCH ?? "claude-sonnet-4.6";

  const budget = Number.parseInt(process.env.HEMIUNU_THINKING_BUDGET ?? "0", 10);
  const thinking: Options["thinking"] =
    budget > 0 ? { type: "enabled", budgetTokens: budget } : { type: "disabled" };

  if (!apiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your LiteLLM key.",
    );
  }
  return { baseUrl, apiKey, model, researchModel, thinking };
}
