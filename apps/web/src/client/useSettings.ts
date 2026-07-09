import { useCallback, useEffect, useState } from "react";

/** One selectable model from the engine's registry (id / label / provider),
 *  with the availability the server computed: which key env it needs and
 *  whether that key is currently set. Optional fields stay optional so the
 *  pre-fetch fallback list (MODELS) needs no fake data. */
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  contextWindow?: number;
  /** The env var holding this model's API key; null = keyless (local). */
  keyEnv?: string | null;
  /** False = its key env is missing — the pickers hide it (see model-picker.ts). */
  available?: boolean;
}

/** One provider/gateway API key as the server reports it — never the value. */
export interface KeyStatus {
  env: string;
  set: boolean;
  maskedTail?: string;
  /** Registry model ids that depend on this key. */
  models: string[];
}

/** A gateway preset the Settings dropdown offers (mirrors the engine's
 *  GatewayPreset — sent by the server so the SPA needn't import the engine). */
export interface GatewayPreset {
  id: string;
  label: string;
  apiKeyEnv: string;
  defaultBaseURL?: string;
  docsHint?: string;
}

export interface Settings {
  model: string;
  /** Retrieval-tier model (the researcher subagent) — a registry id. */
  researchModel: string;
  /** The engine's model registry — everything the pickers can offer. */
  models: ModelOption[];
  /** Key status per provider/gateway env (set / masked tail / dependent models). */
  keys: KeyStatus[];
  /** Gateway presets the Settings gateway dropdown offers. */
  gatewayPresets: GatewayPreset[];
  user: string | null;
  githubLogin: string | null;
  githubAccounts: string[];
  /** At least one registry model is usable (any provider/gateway key set, or a
   *  keyless local endpoint answering). False = show the first-run setup. */
  ready: boolean;
  github: boolean;
  cloudflare: boolean;
  team: string | null;
  teams: string[];
  mcpServers: string[];
  /** Servers that didn't load, with why (e.g. a missing env var). */
  mcpSkipped: { name: string; reason: string }[];
}

/** Fetch /api/settings once, with a refresh hook and optimistic model setters. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) setSettings((await res.json()) as Settings);
    } catch {
      /* worker not up yet — leave null, the UI shows neutral defaults */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setModel = useCallback(async (model: string) => {
    setSettings((s) => (s ? { ...s, model } : s)); // optimistic
    await fetch("/api/settings/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }).catch(() => {});
  }, []);

  const setResearchModel = useCallback(async (model: string) => {
    setSettings((s) => (s ? { ...s, researchModel: model } : s)); // optimistic
    await fetch("/api/settings/research-model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }).catch(() => {});
  }, []);

  return { settings, refresh, setModel, setResearchModel };
}

/** Fallback brain model id shown before the server reports the active one.
 *  Purely cosmetic pre-fetch state: the server resolves the REAL default from
 *  the registry (first available model, preferring the persisted
 *  HEMIUNU_MODEL) and replaces this as soon as /api/settings answers. */
export const DEFAULT_MODEL = "claude-opus-4.8";

/** Fallback model list shown before /api/settings answers (the server's list —
 *  the engine registry, incl. any ~/.hemiunu/models.json entries — replaces it
 *  as soon as settings load). Mirrors the registry's shipped Claude defaults. */
export const MODELS: ModelOption[] = [
  { id: "claude-opus-4.8", label: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", provider: "anthropic" },
];
