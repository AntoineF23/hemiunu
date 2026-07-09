// Model registry: which models exist, who serves them, what they cost, and
// how to turn an entry into a live AI SDK LanguageModel. This is the ONLY
// place provider factories are called; the rest of the codebase deals in
// ModelEntry / ResolvedModel.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { TurnUsage } from "./events";

export type ModelTag = "synthesis" | "research" | "judge" | "title";

export interface ModelEntry {
  /** Registry id — what users select and configs reference. */
  id: string;
  /** Human-readable label for pickers. */
  label: string;
  provider: "anthropic" | "openai" | "google" | "openai-compatible";
  /** Provider-side model id (what goes on the wire). */
  model: string;
  /** Endpoint override; REQUIRED for openai-compatible entries. */
  baseURL?: string;
  /** Env var holding the API key (e.g. "OPENAI_API_KEY"). */
  apiKeyEnv?: string;
  contextWindow: number;
  maxOutput?: number;
  /** $ per Mtok. Unknown cost ⇒ undefined ⇒ costUsd() reports 0. */
  cost?: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  supports: {
    tools: boolean;
    parallelToolCalls?: boolean;
    reasoning?: boolean;
    caching?: boolean;
  };
  /** Provider-specific reasoning/thinking options, passed as providerOptions. */
  reasoning?: Record<string, unknown>;
  /** Roles this model is preferred for (see modelForTag). */
  tags?: ModelTag[];
  /**
   * Small, model-family-scoped system-prompt addenda. The engine loop appends
   * them (see promptHintsBlock) AFTER the caller's system prompt on every turn
   * — main and subagent alike — so quirks of a weaker family (persona drift,
   * post-delegation menus) are corrected WITHOUT forking the soul per model.
   */
  promptHints?: string[];
}

/**
 * Render an entry's promptHints as the system-prompt addendum the loop
 * appends. Undefined when the entry carries none (the common case).
 */
export function promptHintsBlock(entry: ModelEntry): string | undefined {
  if (!entry.promptHints?.length) return undefined;
  return `## Model-specific adjustments (follow strictly)\n${entry.promptHints
    .map((h) => `- ${h}`)
    .join("\n")}`;
}

export interface ResolvedModel {
  entry: ModelEntry;
  languageModel: LanguageModel;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Shipped defaults. Context windows for Claude follow agent-core's
 * contextWindowFor (Opus 4.6+ / Sonnet 4.6 serve the 1M window). Claude `cost`
 * is the published per-Mtok price (Opus 4.8: $5 in / $25 out; Sonnet 4.6:
 * $3 / $15; cache reads ~0.1×, cache writes 1.25× the input rate). Entries
 * without a price table leave `cost` undefined (costUsd reports 0).
 *
 * contextWindow is CONSERVATIVE-CORRECT and sourced per entry: never larger
 * than what the serving endpoint actually accepts, because the compactor
 * budgets against it — an overshoot ships requests the provider rejects with
 * ContextWindowExceeded. For entries routed through the LiteLLM proxy the
 * safe window is the UNDERLYING model's real one, never the proxy default.
 */
export function defaultModels(): ModelEntry[] {
  return [
    {
      id: "claude-opus-4.8",
      label: "Claude Opus 4.8",
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      // Anthropic direct: Opus 4.6+ serves the 1M window (Anthropic docs;
      // matches agent-core's contextWindowFor).
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      cost: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      supports: { tools: true, parallelToolCalls: true, reasoning: true, caching: true },
      tags: ["synthesis"],
    },
    {
      id: "claude-sonnet-4.6",
      label: "Claude Sonnet 4.6",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      // Anthropic direct: Sonnet 4.6 serves the 1M window (Anthropic docs).
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      cost: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      supports: { tools: true, parallelToolCalls: true, reasoning: true, caching: true },
      tags: ["research", "judge", "title"],
    },
    {
      // Verified against the installed @ai-sdk/openai model-id union.
      id: "gpt-5.2",
      label: "GPT-5.2",
      provider: "openai",
      model: "gpt-5.2",
      apiKeyEnv: "OPENAI_API_KEY",
      // OpenAI platform docs: GPT-5-family 400k context window.
      contextWindow: 400_000,
      supports: { tools: true, parallelToolCalls: true, reasoning: true },
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      // OpenAI platform docs: GPT-5-family 400k context window.
      contextWindow: 400_000,
      supports: { tools: true, parallelToolCalls: true, reasoning: true },
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      provider: "google",
      model: "gemini-2.5-pro",
      apiKeyEnv: "GEMINI_API_KEY",
      // Google AI docs: 1,048,576 input tokens — 1_000_000 is the safe floor.
      contextWindow: 1_000_000,
      supports: { tools: true, reasoning: true },
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      provider: "google",
      model: "gemini-2.5-flash",
      apiKeyEnv: "GEMINI_API_KEY",
      // Google AI docs: 1,048,576 input tokens — 1_000_000 is the safe floor.
      contextWindow: 1_000_000,
      supports: { tools: true, reasoning: true },
    },
    // OpenAI-compatible providers — baseURL + apiKeyEnv mirror
    // agent-core/src/providers.ts. Model ids are sensible defaults users can
    // override in ~/.hemiunu/models.json.
    {
      id: "groq-llama",
      label: "Llama 3.3 70B (Groq)",
      provider: "openai-compatible",
      model: "llama-3.3-70b-versatile",
      baseURL: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      // Groq docs: llama-3.3-70b-versatile serves 131,072 — 128_000 is the
      // safe floor.
      contextWindow: 128_000,
      supports: { tools: true },
    },
    {
      id: "grok-4",
      label: "Grok 4 (xAI)",
      provider: "openai-compatible",
      model: "grok-4",
      baseURL: "https://api.x.ai/v1",
      apiKeyEnv: "XAI_API_KEY",
      // xAI docs: grok-4 context window 256k.
      contextWindow: 256_000,
      supports: { tools: true, reasoning: true },
    },
    {
      id: "deepseek-chat",
      label: "DeepSeek Chat",
      provider: "openai-compatible",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      // DeepSeek API docs: deepseek-chat (V3.1+) serves 128K.
      contextWindow: 128_000,
      supports: { tools: true },
    },
    {
      id: "mistral-large",
      label: "Mistral Large",
      provider: "openai-compatible",
      model: "mistral-large-latest",
      baseURL: "https://api.mistral.ai/v1",
      apiKeyEnv: "MISTRAL_API_KEY",
      // Mistral docs: Mistral Large 128k context window.
      contextWindow: 128_000,
      supports: { tools: true },
    },
    // LiteLLM proxy entries. Prices are the providers' PUBLISHED per-Mtok list
    // rates — the proxy may bill differently, but a close estimate beats a $0
    // that reads like "free".
    {
      id: "gpt-4o",
      label: "GPT-4o (LiteLLM)",
      provider: "openai-compatible",
      model: "gpt-4o",
      baseURL: process.env.LITELLM_BASE_URL ?? "https://your-litellm-gateway.example.com/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      // OpenAI docs: gpt-4o serves 128k — the proxy can't stretch that.
      contextWindow: 128_000,
      cost: { in: 2.5, out: 10, cacheRead: 1.25 },
      supports: { tools: true },
    },
    {
      id: "deepseek-v3",
      label: "DeepSeek V3 (LiteLLM)",
      provider: "openai-compatible",
      model: "deepseek-v3",
      baseURL: process.env.LITELLM_BASE_URL ?? "https://your-litellm-gateway.example.com/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      // The proxy host serves deepseek-v3 with a 163,840 window — confirmed by
      // its own rejection (real limit 163,840). Was wrongly shipped as 128_000;
      // the compactor's estimate is conservative (counts schemas + system) and
      // compactAt leaves margin, so budgeting against the true window is safe.
      contextWindow: 163_840,
      cost: { in: 0.27, out: 1.1 },
      supports: { tools: true },
    },
    {
      id: "qwen3-235b-instruct",
      label: "Qwen3 235B Instruct (LiteLLM)",
      provider: "openai-compatible",
      model: "qwen3-235b-instruct",
      baseURL: process.env.LITELLM_BASE_URL ?? "https://your-litellm-gateway.example.com/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      // Vertex AI serves Qwen3-235B with a 262,144 window — confirmed by the
      // proxy's own rejection: "longer than the model's context length
      // (262144 tokens)". Was wrongly shipped as 128_000.
      contextWindow: 262_144,
      cost: { in: 0.2, out: 0.6 },
      supports: { tools: true },
    },
    {
      id: "mistral-medium",
      label: "Mistral Medium (LiteLLM)",
      provider: "openai-compatible",
      model: "mistral-medium",
      baseURL: process.env.LITELLM_BASE_URL ?? "https://your-litellm-gateway.example.com/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      // Mistral docs: Mistral Medium 3 serves 128k.
      contextWindow: 128_000,
      cost: { in: 0.4, out: 2 },
      supports: { tools: true },
    },
    {
      // NOTE: Ollama SERVES models with a 4096-token context by default and
      // silently truncates the prompt HEAD (the soul!) beyond it — raise
      // OLLAMA_CONTEXT_LENGTH (or bake `PARAMETER num_ctx` into a derived
      // model) or the persona/delegation behavior degrades. docs/providers.md.
      id: "ministral-3:14b",
      label: "Ministral 3 14B (Ollama)",
      provider: "openai-compatible",
      model: "ministral-3:14b",
      baseURL: "http://localhost:11434/v1",
      // Deliberately 32_768: Ollama's default serving config, NOT the model's
      // theoretical max — see the NOTE above and docs/providers.md.
      contextWindow: 32_768,
      supports: { tools: true },
      // Family quirks observed in the live gate (P6-2): it paraphrases its
      // persona instead of naming itself, and after a delegation it answers
      // with a menu of follow-ups instead of the grounded synthesis.
      promptHints: [
        'When asked who or what you are, state your name — say the word "Hemiunu" explicitly — then your role in one short sentence. Never paraphrase or describe your persona without naming it.',
        "After a delegated subagent (the delegate or parallel tool) returns its report, your next message MUST directly answer the user's original question in one or two sentences grounded in that report. Do not reply with a menu of options, a list of follow-up choices, or a question.",
      ],
    },
  ];
}

const modelEntrySchema: z.ZodType<ModelEntry> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "google", "openai-compatible"]),
  model: z.string().min(1),
  baseURL: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive().optional(),
  cost: z
    .object({
      in: z.number(),
      out: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  supports: z.object({
    tools: z.boolean(),
    parallelToolCalls: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    caching: z.boolean().optional(),
  }),
  reasoning: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.enum(["synthesis", "research", "judge", "title"])).optional(),
  promptHints: z.array(z.string()).optional(),
});

/** Hemiunu's per-user config dir — same resolution as agent-core's configDir. */
function resolveConfigDir(dir?: string): string {
  return dir ?? process.env.HEMIUNU_CONFIG_DIR ?? join(homedir(), ".hemiunu");
}

/**
 * Shipped defaults merged with user entries from `<configDir>/models.json`
 * (a JSON array of ModelEntry). A user entry with the same id overrides the
 * default; new ids are appended. A missing or unreadable file is fine; bad
 * entries are skipped with a warning rather than breaking startup.
 */
export function loadModelRegistry(dir?: string): ModelEntry[] {
  const registry = defaultModels();
  const path = join(resolveConfigDir(dir), "models.json");
  if (!existsSync(path)) return registry;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.warn(`hemiunu: ignoring invalid ${path}: ${e instanceof Error ? e.message : e}`);
    return registry;
  }
  if (!Array.isArray(raw)) {
    console.warn(`hemiunu: ignoring ${path}: expected a JSON array of model entries`);
    return registry;
  }
  for (const item of raw) {
    const parsed = modelEntrySchema.safeParse(item);
    if (!parsed.success) {
      const id =
        typeof item === "object" && item !== null && "id" in item
          ? String((item as { id: unknown }).id)
          : "<no id>";
      console.warn(`hemiunu: skipping invalid model entry ${id} in ${path}`);
      continue;
    }
    const idx = registry.findIndex((m) => m.id === parsed.data.id);
    if (idx >= 0) registry[idx] = parsed.data;
    else registry.push(parsed.data);
  }
  return registry;
}

/** Default key env per provider, when an entry doesn't set apiKeyEnv. */
const DEFAULT_KEY_ENV: Record<ModelEntry["provider"], string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "openai-compatible": undefined, // must come from the entry
};

/**
 * The env var an entry's API key comes from: its own apiKeyEnv, else the
 * provider's conventional default. Undefined = keyless (a local
 * openai-compatible endpoint like Ollama — nothing to configure).
 */
export function keyEnvFor(entry: ModelEntry): string | undefined {
  return entry.apiKeyEnv ?? DEFAULT_KEY_ENV[entry.provider];
}

/**
 * Whether resolveModel would succeed for this entry with the given env —
 * i.e. it's keyless, or its key env holds a non-blank value. The UI uses this
 * to grey out models whose key is missing instead of erroring at turn start.
 */
export function modelAvailable(
  entry: ModelEntry,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const keyEnv = keyEnvFor(entry);
  return !keyEnv || !!env[keyEnv]?.trim();
}

/**
 * Pure readiness over a registry: at least one entry is usable per
 * modelAvailable — its key env holds a value, or it's keyless (a local
 * endpoint like Ollama). No env var is special-cased: ANY provider's key (or
 * a keyless local entry) satisfies it. This is the first-run rule — the app
 * is usable exactly when this is true.
 */
export function anyModelAvailable(
  registry: ModelEntry[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  return registry.some((m) => modelAvailable(m, env));
}

/**
 * Probe a keyless endpoint (e.g. a local Ollama): true when `<baseURL>/models`
 * answers at all. Used by registryReady so a keyless registry entry only
 * counts as "usable" when something is actually listening.
 */
export async function keylessEndpointUp(baseURL: string, timeoutMs = 600): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The first-run gate's readiness check. A keyed entry whose key env is set
 * counts immediately (no network). Keyless entries (local endpoints) only
 * count when their endpoint answers — otherwise a fresh machine with no keys
 * AND no local server would look "ready" and the first turn would die on a
 * connection error instead of the setup card. `probe` is injectable so tests
 * stay offline.
 */
export async function registryReady(
  registry: ModelEntry[],
  env: Record<string, string | undefined> = process.env,
  probe: (baseURL: string) => Promise<boolean> = keylessEndpointUp,
): Promise<boolean> {
  const usable = registry.filter((m) => modelAvailable(m, env));
  if (usable.some((m) => keyEnvFor(m) !== undefined)) return true;
  const bases = [...new Set(usable.map((m) => m.baseURL).filter((b): b is string => !!b))];
  for (const base of bases) {
    if (await probe(base)) return true;
  }
  return false;
}

/**
 * The model id a fresh turn should use. Order: the preferred id (persisted
 * HEMIUNU_MODEL / the runtime's current pick) when it names an AVAILABLE
 * registry entry; else the first available entry carrying `tag`; else the
 * first available entry of any kind; else — nothing is usable, the first-run
 * gate is up anyway — the preferred id if the registry knows it, falling back
 * to the tag route. Never throws: it always names SOME registry entry.
 */
export function resolveDefaultModel(
  registry: ModelEntry[],
  env: Record<string, string | undefined> = process.env,
  preferred?: string,
  tag: ModelTag = "synthesis",
): string {
  const pref = preferred ? registry.find((m) => m.id === preferred) : undefined;
  if (pref && modelAvailable(pref, env)) return pref.id;
  const available = registry.filter((m) => modelAvailable(m, env));
  const tagged = available.find((m) => m.tags?.includes(tag));
  if (tagged) return tagged.id;
  if (available.length) return available[0].id;
  if (pref) return pref.id;
  return modelForTag(tag, registry, registry[0].id).id;
}

/**
 * Turn a registry id into a live AI SDK LanguageModel. Throws with an
 * actionable message when the entry, key, or (for openai-compatible) baseURL
 * is missing. `opts.fetch` is a test/DI seam threaded into every provider
 * factory — the wire-invariant harness injects a capturing fetch here to
 * observe the exact request body each adapter produces, with zero network.
 */
export function resolveModel(
  id: string,
  registry?: ModelEntry[],
  opts?: { fetch?: typeof globalThis.fetch },
): ResolvedModel {
  const entries = registry ?? loadModelRegistry();
  const entry = entries.find((m) => m.id === id);
  if (!entry) {
    const known = entries.map((m) => m.id).join(", ");
    throw new Error(`Unknown model '${id}'. Known models: ${known}.`);
  }

  const keyEnv = entry.apiKeyEnv ?? DEFAULT_KEY_ENV[entry.provider];
  // A keyless openai-compatible entry is a local endpoint (e.g. Ollama at
  // localhost:11434) — no credential to resolve; a placeholder key is sent.
  if (!keyEnv && entry.provider !== "openai-compatible") {
    throw new Error(`Model ${entry.id} has no apiKeyEnv — set one in ~/.hemiunu/models.json.`);
  }
  const apiKey = keyEnv ? process.env[keyEnv]?.trim() : undefined;
  if (keyEnv && !apiKey) {
    throw new Error(`Model ${entry.id} needs ${keyEnv} — add it to ~/.hemiunu/.env.`);
  }

  let languageModel: LanguageModel;
  switch (entry.provider) {
    case "anthropic": {
      // Honor the entry's baseURL, else ANTHROPIC_BASE_URL (gateway/proxy),
      // else Anthropic direct — same precedence as agent-core's loadConfig.
      // ANTHROPIC_BASE_URL is conventionally the HOST root (the Anthropic SDKs
      // append /v1/messages), but the AI SDK's baseURL must INCLUDE /v1 (its
      // default is https://api.anthropic.com/v1 and it appends only
      // /messages) — so normalize a root-style URL by appending /v1.
      const raw = (entry.baseURL ?? process.env.ANTHROPIC_BASE_URL?.trim() ?? "").replace(
        /\/+$/,
        "",
      );
      const baseURL = raw ? (raw.endsWith("/v1") ? raw : `${raw}/v1`) : undefined;
      // Through a gateway/proxy the wire model is the REGISTRY id (gateways
      // like LiteLLM register their own aliases — e.g. "claude-opus-4.8" —
      // which is exactly what users select and the SDK era sent). Anthropic
      // direct uses the provider-side id (entry.model, e.g. "claude-opus-4-8").
      languageModel = createAnthropic({ apiKey, baseURL, fetch: opts?.fetch })(
        baseURL ? entry.id : entry.model,
      );
      break;
    }
    case "openai":
      languageModel = createOpenAI({ apiKey, baseURL: entry.baseURL, fetch: opts?.fetch })(
        entry.model,
      );
      break;
    case "google":
      languageModel = createGoogleGenerativeAI({
        apiKey,
        baseURL: entry.baseURL,
        fetch: opts?.fetch,
      })(entry.model);
      break;
    case "openai-compatible": {
      if (!entry.baseURL) {
        throw new Error(`Model ${entry.id} needs a baseURL — set one in ~/.hemiunu/models.json.`);
      }
      languageModel = createOpenAICompatible({
        baseURL: entry.baseURL,
        name: entry.id,
        apiKey,
        fetch: opts?.fetch,
      })(entry.model);
      break;
    }
  }

  // Reasoning options ride along as providerOptions, keyed by the provider
  // name the AI SDK expects ("anthropic"/"openai"/"google", or the
  // openai-compatible provider's name — we pass entry.id as that name).
  const providerKey = entry.provider === "openai-compatible" ? entry.id : entry.provider;
  const providerOptions = entry.reasoning ? { [providerKey]: entry.reasoning } : undefined;

  return { entry, languageModel, providerOptions };
}

/** First registry entry carrying the tag, else the fallback id's entry. */
export function modelForTag(tag: ModelTag, registry: ModelEntry[], fallbackId: string): ModelEntry {
  const tagged = registry.find((m) => m.tags?.includes(tag));
  if (tagged) return tagged;
  const fallback = registry.find((m) => m.id === fallbackId);
  if (!fallback) {
    throw new Error(`No model tagged '${tag}' and fallback '${fallbackId}' is not in registry.`);
  }
  return fallback;
}

/**
 * Dollar cost of a turn on this model. Unknown pricing (entry.cost undefined)
 * reports 0 — better a visible zero than an invented number. Cache rates
 * default to the input rate when unspecified.
 */
export function costUsd(entry: ModelEntry, usage: TurnUsage): number {
  const c = entry.cost;
  if (!c) return 0;
  const perTok =
    usage.inputTokens * c.in +
    usage.outputTokens * c.out +
    usage.cacheReadTokens * (c.cacheRead ?? c.in) +
    usage.cacheWriteTokens * (c.cacheWrite ?? c.in);
  return perTok / 1_000_000;
}
