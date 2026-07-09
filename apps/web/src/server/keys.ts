// API-key + gateway helpers behind the Settings routes. Pure/small-IO functions
// live here (unit-testable without a running worker); routes/keys.ts wires them
// to HTTP. The invariant that matters most: a FULL key value never appears in
// anything this module returns — only booleans and a 4-char masked tail.
import {
  GATEWAY_PRESETS,
  keyEnvFor,
  loadModelRegistry,
  modelAvailable,
  type ModelEntry,
} from "@hemiunu/engine";

// Gateway helpers (URL normalization, discovery parsing, models.json merge)
// live in the engine now — the CLI first-run setup shares them. Re-exported
// here so the routes and tests keep one import site.
export type { GatewayModelInput, GatewayPreset } from "@hemiunu/engine";
export {
  addGatewayModels,
  contextWindowForId,
  fetchModelInfoWindows,
  GATEWAY_PRESETS,
  normalizeGatewayBase,
  parseDiscoveredModels,
} from "@hemiunu/engine";

/** One provider/gateway key as the Settings UI sees it. Never the value. */
export interface KeyStatus {
  /** The env var name (e.g. "OPENAI_API_KEY"). */
  env: string;
  /** Whether a non-blank value is currently configured. */
  set: boolean;
  /** Last 4 chars for recognition (e.g. "…x4Qz") — only for values ≥ 8 chars. */
  maskedTail?: string;
  /** Registry model ids that depend on this key. */
  models: string[];
}

/**
 * "…x4Qz" — enough to recognise which key is stored, never enough to use it.
 * Short values (< 8 chars) return undefined: a 4-char tail of a 5-char secret
 * IS the secret.
 */
export function maskTail(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || v.length < 8) return undefined;
  return `…${v.slice(-4)}`;
}

/**
 * Every distinct key env the registry references (each provider's key + each
 * gateway's key), with set/masked status from `env` and the model ids that
 * depend on it. Keyless entries (local endpoints like Ollama) contribute
 * nothing — there is no key to manage.
 */
export function keyStatuses(
  registry: ModelEntry[] = loadModelRegistry(),
  env: Record<string, string | undefined> = process.env,
): KeyStatus[] {
  const byEnv = new Map<string, string[]>();
  for (const entry of registry) {
    const keyEnv = keyEnvFor(entry);
    if (!keyEnv) continue;
    const models = byEnv.get(keyEnv) ?? [];
    models.push(entry.id);
    byEnv.set(keyEnv, models);
  }
  return [...byEnv.entries()].map(([envName, models]) => ({
    env: envName,
    set: !!env[envName]?.trim(),
    ...(maskTail(env[envName]) ? { maskedTail: maskTail(env[envName]) } : {}),
    models,
  }));
}

/** The registry model list as the Settings UI needs it: availability included. */
export function modelOptions(
  registry: ModelEntry[] = loadModelRegistry(),
  env: Record<string, string | undefined> = process.env,
): {
  id: string;
  label: string;
  provider: string;
  contextWindow: number;
  keyEnv: string | null;
  available: boolean;
}[] {
  return registry.map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    contextWindow: m.contextWindow,
    keyEnv: keyEnvFor(m) ?? null,
    available: modelAvailable(m, env),
  }));
}

/**
 * Env names we accept for writes: the registry's known key envs PLUS every
 * gateway preset's apiKeyEnv. Including the presets lets a brand-new gateway
 * key (e.g. OPENROUTER_API_KEY) be saved BEFORE any model references it — so
 * "pick gateway → paste key → save" works on the first try, not only after
 * models are registered. Arbitrary custom env names are still out (they go
 * through the register flow once a model references them). */
export function allowedKeyEnvs(registry: ModelEntry[] = loadModelRegistry()): Set<string> {
  const envs = new Set(keyStatuses(registry, {}).map((k) => k.env));
  for (const p of GATEWAY_PRESETS) envs.add(p.apiKeyEnv);
  return envs;
}

/** Uppercase env-name shape (defense-in-depth under the allowlist). */
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * A key VALUE that is safe to write as one .env line: single-line, no control
 * characters (a value with "\n" would inject arbitrary env lines), sane length.
 */
export function validKeyValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
