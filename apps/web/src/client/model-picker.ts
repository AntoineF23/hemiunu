// Model-picker availability rules, shared by every model dropdown (settings
// Brain/Research, the composer, the custom-agent pickers in the memory view).
//
// The product rule: a model whose API key is missing is HIDDEN — not greyed
// out — and every dropdown ends with one "＋ Add API keys…" item that opens
// Settings on the API-keys section. The single exception: the CURRENTLY
// SELECTED model stays visible when its key disappears, marked "(key missing)",
// so the closed select never lies about what the next turn would use.
import type { ModelOption } from "./useSettings";

/** Sentinel option value for the "＋ Add API keys…" item in every picker. */
export const ADD_KEYS_VALUE = "__add-api-keys__";

/** The label every picker uses for its settings-link item. */
export const ADD_KEYS_LABEL = "＋ Add API keys…";

/** Marker appended to a selected model whose key has gone missing. */
export const KEY_MISSING_MARK = "(key missing)";

/** `focusKeyEnv` sentinel: open Settings on the API-keys SECTION (no one env). */
export const API_KEYS_SECTION = "*";

/**
 * The models a picker offers: only available ones. Keyless entries (local
 * Ollama…) and entries whose key env is set report `available: true`; the
 * pre-fetch fallback list carries no availability yet and stays visible
 * (`available` undefined ≠ unavailable) until /api/settings answers.
 */
export function pickableModels(models: ModelOption[]): ModelOption[] {
  return models.filter((m) => m.available !== false);
}

/**
 * The key env the SELECTED model is missing, or null when it's usable (or not
 * in the list at all — an id the registry no longer knows can't name a key).
 * Non-null means: mark the closed select "(key missing)" and steer the user's
 * Add-API-keys click at this exact env.
 */
export function missingKeyFor(id: string | undefined, models: ModelOption[]): string | null {
  const m = models.find((x) => x.id === id);
  return m && m.available === false ? (m.keyEnv ?? null) : null;
}

/**
 * What the CLOSED picker shows for the current selection: the model's label
 * (falling back to the raw id), plus the key-missing marker when its key was
 * removed — the selection is never silently switched, only flagged.
 */
export function pickerLabel(id: string, models: ModelOption[]): string {
  const m = models.find((x) => x.id === id);
  return m?.available === false ? `${m.label} ${KEY_MISSING_MARK}` : (m?.label ?? id);
}
