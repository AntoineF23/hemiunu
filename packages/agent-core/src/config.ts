import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";

// Load .env from the current working directory if present (Node 24 builtin).
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // ignore — env may already be populated by the shell
  }
}

export interface HemiunuConfig {
  /** Base URL of the Anthropic-compatible endpoint (here: the LiteLLM proxy). */
  baseUrl: string;
  /** API key / token sent to the proxy. */
  apiKey: string;
  /** Main model id, as exposed by the proxy (e.g. "claude-opus-4.8"). */
  model: string;
  /** Thinking config. Set explicitly: the engine's default sends effort 'xhigh',
   *  which non-Opus models (e.g. Sonnet 4.6) reject. Disabled = cheaper & works
   *  everywhere; set HEMIUNU_THINKING_BUDGET (tokens) to enable reasoning. */
  thinking: Options["thinking"];
}

export function loadConfig(): HemiunuConfig {
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://models.thiga.co";
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const model = process.env.HEMIUNU_MODEL ?? "claude-opus-4.8";

  const budget = Number.parseInt(process.env.HEMIUNU_THINKING_BUDGET ?? "0", 10);
  const thinking: Options["thinking"] =
    budget > 0 ? { type: "enabled", budgetTokens: budget } : { type: "disabled" };

  if (!apiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your LiteLLM key.",
    );
  }
  return { baseUrl, apiKey, model, thinking };
}
