import { useState } from "react";
import { ChevronDown, KeyRound } from "lucide-react";
import type { Settings } from "../useSettings";
import { GatewaySection, KeyRow, keyName, sortedKeyStatuses } from "./panels/SettingsPanel";

/** The big-three provider rows shown before "More providers…" is expanded. */
const PRIMARY_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

/**
 * First-run setup, provider-agnostic: connect ANY model provider — a provider
 * API key (Anthropic, OpenAI, Gemini, …), a gateway (LiteLLM / OpenRouter /
 * vLLM: base URL + key + discover), or a keyless local Ollama. Reuses the
 * exact same building blocks as Settings (KeyRow, GatewaySection), saving
 * through the same /api/settings/keys + gateway endpoints. The card clears
 * live: every save triggers onChanged → settings refresh → `ready` flips as
 * soon as one registry model is usable, and the server heals the active model
 * to the first available one.
 */
export function FirstRunSetup({
  settings,
  onChanged,
}: {
  settings: Settings;
  onChanged: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const keys = sortedKeyStatuses(settings.keys);
  const shown = showAll ? keys : keys.filter((k) => PRIMARY_KEYS.includes(k.env));
  const hidden = keys.length - shown.length;

  return (
    <div className="perm mb-2.5">
      <div className="perm-head">
        <KeyRound size={16} className="perm-icon" />
        <span className="min-w-0 break-words">
          <strong>One-time setup:</strong> connect a model provider to start building — everything
          stays on this computer.
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {shown.map((k) => (
          <KeyRow key={k.env} status={k} onChanged={onChanged} />
        ))}
        {!keys.length && (
          <p className="text-xs text-ink-4">Loading provider list from the local worker…</p>
        )}
        {hidden > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 self-start text-xs text-ink-3 hover:text-ink"
            onClick={() => setShowAll(true)}
          >
            <ChevronDown size={12} />
            More providers (
            {keys
              .filter((k) => !PRIMARY_KEYS.includes(k.env))
              .slice(0, 3)
              .map((k) => keyName(k.env))
              .join(", ")}
            …)
          </button>
        )}

        <div className="mt-1 border-t border-border pt-3">
          <GatewaySection settings={settings} onChanged={onChanged} />
        </div>

        <p className="break-words text-xs text-ink-4">
          Running a local Ollama? No key needed — its models unlock automatically once the server
          answers at localhost:11434. Keys are stored in ~/.hemiunu/.env and never leave this
          machine.
        </p>
      </div>
    </div>
  );
}
