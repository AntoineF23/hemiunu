import { useCallback, useEffect, useState } from "react";

export interface Settings {
  model: string;
  user: string | null;
  hasApiKey: boolean;
  github: boolean;
  vercel: boolean;
  team: string | null;
  teams: string[];
  mcpServers: string[];
  mcpSkipped: string[];
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

/** The known brain models the model selector offers (label + id). */
export const MODELS: { id: string; label: string }[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4.8", label: "Opus 4.8 (proxy)" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-sonnet-4.6", label: "Sonnet 4.6 (proxy)" },
];

export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
