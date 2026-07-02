import { useCallback, useEffect, useState } from "react";

export interface Settings {
  model: string;
  user: string | null;
  githubLogin: string | null;
  githubAccounts: string[];
  hasApiKey: boolean;
  github: boolean;
  cloudflare: boolean;
  team: string | null;
  teams: string[];
  mcpServers: string[];
  /** Servers that didn't load, with why (e.g. a missing env var). */
  mcpSkipped: { name: string; reason: string }[];
}

/** Fetch /api/settings once, with a refresh hook and an optimistic model setter. */
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

  return { settings, refresh, setModel };
}

/** Fallback brain model id shown before the server reports the active one.
 *  Must match the server default in apps/web/src/server/runtime.ts. */
export const DEFAULT_MODEL = "claude-opus-4.8";

/** The known brain models the model selector offers (label + id). The dashed ids
 *  are the direct-Anthropic names; the dotted "(proxy)" ids are what a gateway
 *  such as the LiteLLM proxy exposes — both are kept so the label resolves
 *  whichever endpoint the user configured. */
export const MODELS: { id: string; label: string }[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4.8", label: "Opus 4.8 (proxy)" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-sonnet-4.6", label: "Sonnet 4.6 (proxy)" },
];

export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
