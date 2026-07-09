// Gateway (LiteLLM / OpenRouter / vLLM…) helpers shared by the web Settings
// routes and the CLI first-run setup: base-URL normalization, model discovery
// parsing, and the models.json merge that registers discovered models as
// openai-compatible registry entries.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry } from "./models";

/**
 * One OpenAI-compatible gateway the Settings UI and the CLI first-run offer as
 * a preset, so a user picks a provider instead of typing a raw env name. The
 * whole flow is generic (discovery hits `<base>/models`, registration writes
 * `openai-compatible` entries) — a preset just supplies the conventional env
 * name and, where the host is fixed, a default base URL.
 */
export interface GatewayPreset {
  /** Stable id (used as the dropdown value); "custom" is the escape hatch. */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** The env var the key is stored under. Always the uppercase _API_KEY shape. */
  apiKeyEnv: string;
  /** Hosted gateways prefill this (still editable); self-hosted ones omit it. */
  defaultBaseURL?: string;
  /** Short hint shown near the base-URL field (mostly for self-hosted URLs). */
  docsHint?: string;
}

/**
 * Preset gateways. LiteLLM is first so it stays the default selection (matching
 * the prior LITELLM_API_KEY default). "custom" is the escape hatch: choosing it
 * reveals a free-text env-name field so ANY OpenAI-compatible gateway with an
 * arbitrary env name still works. Every apiKeyEnv keeps the uppercase _API_KEY
 * shape (ENV_NAME_RE), asserted in the tests.
 */
export const GATEWAY_PRESETS: readonly GatewayPreset[] = [
  {
    id: "litellm",
    label: "LiteLLM",
    apiKeyEnv: "LITELLM_API_KEY",
    docsHint: "your LiteLLM proxy URL",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultBaseURL: "https://openrouter.ai/api/v1",
  },
  {
    id: "together",
    label: "Together AI",
    apiKeyEnv: "TOGETHER_API_KEY",
    defaultBaseURL: "https://api.together.xyz/v1",
  },
  {
    id: "vllm",
    label: "vLLM",
    apiKeyEnv: "VLLM_API_KEY",
    docsHint: "your vLLM server URL",
  },
  {
    id: "custom",
    label: "Custom / other OpenAI-compatible",
    apiKeyEnv: "GATEWAY_API_KEY",
    docsHint: "any OpenAI-compatible base URL",
  },
] as const;

/**
 * Normalize a user-entered gateway base URL for OpenAI-compatible use:
 * http(s) only, trailing slashes stripped, and "/v1" appended when absent —
 * so "https://gateway.example.com" and "https://gateway.example.com/v1/" both store
 * as "https://gateway.example.com/v1" and discovery hits "<base>/models".
 */
export function normalizeGatewayBase(raw: string): { base: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Missing base URL." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: `Not a valid URL: ${trimmed}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http(s) gateway URLs are supported." };
  }
  if (url.username || url.password) {
    return { error: "Credentials in the URL are not supported — use the API key field." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  const base = `${url.origin}${path.endsWith("/v1") ? path : `${path}/v1`}`;
  return { base };
}

/**
 * Model ids out of a gateway's models listing. Accepts the OpenAI shape
 * ({ data: [{ id }] }), a bare array, or { models: [...] } — LiteLLM,
 * OpenRouter and vLLM all land on one of these. Undefined = unrecognized.
 */
export function parseDiscoveredModels(payload: unknown): string[] | undefined {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : undefined;
  if (!list) return undefined;
  const ids = list
    .map((item) =>
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : undefined,
    )
    .filter((id): id is string => !!id?.trim());
  return [...new Set(ids)];
}

export interface GatewayModelInput {
  id: string;
  label?: string;
  contextWindow?: number;
}

/**
 * Context window a discovered gateway model registers with when the gateway
 * exposes no metadata and no curated pattern matches. DELIBERATELY small:
 * an overshoot makes the compactor budget against a window the model doesn't
 * have, so long conversations ship requests the provider rejects with
 * ContextWindowExceeded (undershooting merely compacts earlier). Users can
 * raise it per entry in ~/.hemiunu/models.json.
 */
export const FALLBACK_CONTEXT_WINDOW = 32_768;

/**
 * Curated context windows by model-id pattern, used when the gateway's
 * metadata endpoint (LiteLLM's /model/info) is unavailable — on many proxies
 * it is admin-only and answers 403 to virtual keys. Values are the UNDERLYING
 * model's real window per the vendor's public docs, conservative when hosts
 * differ — through a proxy the safe window is never larger than what the
 * backing deployment actually accepts. First match wins: keep more specific
 * patterns above the family catch-alls.
 */
export const KNOWN_CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  // Anthropic docs: Claude 4.x serves 200k baseline. The 1M window is a
  // direct-API tier a gateway route may not enable — 200k is the safe floor.
  [/^claude-/i, 200_000],
  // OpenAI docs: gpt-4o / gpt-4o-mini serve 128k.
  [/^gpt-4o/i, 128_000],
  // OpenAI docs: gpt-4.1 family serves ~1M (1,047,576).
  [/^gpt-4\.1/i, 1_000_000],
  // OpenAI docs: GPT-5 family (incl. codex variants) serves 400k.
  [/^gpt-5/i, 400_000],
  // OpenAI docs: o3 / o4 reasoning models serve 200k.
  [/^o[34]\b|^o[34]-/i, 200_000],
  // OpenAI docs: gpt-oss-20b/120b serve 131,072 — 128k safe floor.
  [/^gpt-oss/i, 128_000],
  // OpenAI docs: text-embedding-3 accepts 8,191 input tokens (not a chat model).
  [/^text-embedding/i, 8_192],
  // Google docs: Gemini 2.x/3.x Pro & Flash serve ≥1,048,576 — 1M safe floor.
  [/^gemini-/i, 1_000_000],
  // Google docs: Gemma 3+ 27B-class serves 131,072 — 128k safe floor.
  [/^gemma-/i, 128_000],
  // Alibaba docs / Vertex AI: Qwen3 (235B instruct & thinking, coder, next)
  // serve 262,144 — confirmed live by the proxy's own rejection message.
  [/^qwen3/i, 262_144],
  // Alibaba docs: Qwen2.5 serves 32k in most deployments.
  [/^qwen2/i, 32_768],
  // DeepSeek docs: V3.x and R1 serve 128K.
  [/^deepseek/i, 128_000],
  // Moonshot docs: Kimi K2 serves 256k (262,144).
  [/^kimi-k2/i, 262_144],
  // Meta docs claim more, but Llama 4 hosts commonly serve 128k-class
  // windows — 128k is the safe floor (Scout's 10M is aspirational, not served).
  [/^llama-4/i, 128_000],
  // Meta docs: Llama 3.1/3.3 serve 128k.
  [/^llama-3/i, 128_000],
  // Mistral docs: Codestral 25.01+ serves 256k.
  [/^codestral/i, 256_000],
  // Mistral docs: Large / Medium 3 / Small 3.1 serve 128k.
  [/^mistral-(large|medium|small)/i, 128_000],
  // Mistral docs: Ministral 3B/8B serve 128k — but local Ollama serving is
  // the 32k shipped default; this pattern is for gateway-hosted Ministral.
  [/^ministral/i, 128_000],
  // MiniMax docs: M2 serves 204,800 — 200k safe floor.
  [/^minimax-m2/i, 200_000],
  // Zhipu docs: GLM-4.5+ serves at least 128k.
  [/^glm-/i, 128_000],
  // xAI docs: Grok 4 family serves at least 256k (4.1-fast serves more —
  // 256k is the safe floor across variants).
  [/^grok-4/i, 256_000],
  // xAI docs: Grok 3 serves 131,072 — 128k safe floor.
  [/^grok-3/i, 128_000],
];

/** Curated window for a discovered id, else the conservative fallback. */
export function contextWindowForId(id: string): number {
  const bare = id.trim().replace(/^.*\//, ""); // strip an org/route prefix
  for (const [re, ctx] of KNOWN_CONTEXT_WINDOWS) {
    if (re.test(bare) || re.test(id.trim())) return ctx;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * Per-model context windows out of a LiteLLM `/model/info` payload:
 * `{ data: [{ model_name, model_info: { max_input_tokens?, max_tokens? } }] }`.
 * max_input_tokens IS the context window; max_tokens is the fallback some
 * configs use for it. Unrecognized payloads yield {} — callers fall back to
 * the curated map.
 */
export function parseModelInfoWindows(payload: unknown): Record<string, number> {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return {};
  const out: Record<string, number> = {};
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { model_name: name, model_info: info } = item as {
      model_name?: unknown;
      model_info?: { max_input_tokens?: unknown; max_tokens?: unknown };
    };
    if (typeof name !== "string" || !name.trim() || !info || typeof info !== "object") continue;
    const ctx = [info.max_input_tokens, info.max_tokens].find(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
    );
    if (ctx) out[name.trim()] = Math.floor(ctx);
  }
  return out;
}

/**
 * Best-effort fetch of a gateway's per-model context windows. LiteLLM serves
 * /model/info at the host root AND under /v1; both are tried because either
 * may be admin-only (403 for virtual keys — verified live on gateway.example.com)
 * or absent on non-LiteLLM gateways. ANY failure returns {} and discovery
 * falls back to KNOWN_CONTEXT_WINDOWS / FALLBACK_CONTEXT_WINDOW.
 */
export async function fetchModelInfoWindows(
  base: string,
  bearer?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const v1 = base.replace(/\/+$/, "");
  const root = v1.replace(/\/v1$/, "");
  for (const url of [`${root}/model/info`, `${v1}/model/info`]) {
    try {
      const res = await fetchImpl(url, {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const windows = parseModelInfoWindows((await res.json().catch(() => undefined)) as unknown);
      if (Object.keys(windows).length) return windows;
    } catch {
      // unreachable/timeout — try the next form, then fall back to curated
    }
  }
  return {};
}

/**
 * Append/merge gateway models into `<configDir>/models.json` as
 * openai-compatible entries. Overlay semantics: an id already in the file is
 * replaced (never duplicated); ids new to the file are appended; every other
 * entry in the file is preserved byte-for-byte (we re-serialize but never
 * validate/strip entries we didn't touch). Returns the ids written.
 */
export function addGatewayModels(
  configDirPath: string,
  opts: { baseURL: string; apiKeyEnv: string; models: GatewayModelInput[] },
): { added: string[] } | { error: string } {
  const path = join(configDirPath, "models.json");
  let existing: unknown[] = [];
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // NEVER clobber a file we can't parse — the user may have hand-edits.
      return { error: `~/.hemiunu/models.json is not valid JSON — fix or remove it first.` };
    }
    if (!Array.isArray(raw)) {
      return { error: `~/.hemiunu/models.json must be a JSON array of model entries.` };
    }
    existing = raw;
  }

  const added: string[] = [];
  for (const m of opts.models) {
    const id = m.id.trim();
    if (!id) continue;
    // Caller-provided window (gateway metadata or the user's edit in the
    // discover UI) must be a sane positive integer — anything else falls to
    // the curated pattern, else the CONSERVATIVE fallback. Never an
    // optimistic guess (see FALLBACK_CONTEXT_WINDOW).
    const requested =
      typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow) && m.contextWindow > 0
        ? Math.floor(m.contextWindow)
        : undefined;
    const entry: ModelEntry = {
      id,
      label: m.label?.trim() || `${id} (gateway)`,
      provider: "openai-compatible",
      model: id,
      baseURL: opts.baseURL,
      apiKeyEnv: opts.apiKeyEnv,
      contextWindow: requested ?? contextWindowForId(id),
      supports: { tools: true },
    };
    const idx = existing.findIndex(
      (e) => e && typeof e === "object" && (e as { id?: unknown }).id === id,
    );
    if (idx >= 0) existing[idx] = entry;
    else existing.push(entry);
    added.push(id);
  }
  if (!added.length) return { error: "No models to add." };
  mkdirSync(configDirPath, { recursive: true });
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return { added };
}
