// Model-picker availability rules: unavailable models are HIDDEN (not greyed),
// keyless models always show, and a selected model whose key disappears stays
// visible in the closed picker marked "(key missing)". The last test drives the
// rules with the real server payload (modelOptions) to prove availability
// recomputes the moment a key is saved/removed — no reload.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultModels } from "@hemiunu/engine";
import { modelOptions } from "../server/keys";
import { KEY_MISSING_MARK, missingKeyFor, pickableModels, pickerLabel } from "./model-picker";
import type { ModelOption } from "./useSettings";

const MODELS: ModelOption[] = [
  {
    id: "opus",
    label: "Opus",
    provider: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    available: true,
  },
  { id: "gpt", label: "GPT", provider: "openai", keyEnv: "OPENAI_API_KEY", available: false },
  { id: "local", label: "Local", provider: "ollama", keyEnv: null, available: true },
];

test("pickableModels: unavailable models are hidden, not greyed", () => {
  assert.deepEqual(
    pickableModels(MODELS).map((m) => m.id),
    ["opus", "local"],
  );
});

test("pickableModels: keyless models are always available; the pre-fetch fallback (no availability yet) stays visible", () => {
  const keyless = MODELS.find((m) => m.id === "local");
  assert.ok(keyless && pickableModels([keyless]).length === 1);
  // The fallback list shown before /api/settings answers carries no
  // `available` field — undefined must NOT read as unavailable.
  const fallback: ModelOption[] = [{ id: "a", label: "A", provider: "anthropic" }];
  assert.deepEqual(pickableModels(fallback), fallback);
});

test("selected-but-unavailable: marked '(key missing)' with the env to fix, never silently switched", () => {
  assert.equal(missingKeyFor("gpt", MODELS), "OPENAI_API_KEY");
  assert.equal(pickerLabel("gpt", MODELS), `GPT ${KEY_MISSING_MARK}`);
  // Available and keyless selections carry no marker and no env.
  assert.equal(missingKeyFor("opus", MODELS), null);
  assert.equal(pickerLabel("opus", MODELS), "Opus");
  assert.equal(missingKeyFor("local", MODELS), null);
  // An id the registry no longer knows names no key env — raw id, no marker.
  assert.equal(missingKeyFor("gone", MODELS), null);
  assert.equal(pickerLabel("gone", MODELS), "gone");
});

test("empty state: with no keys and no keyless models, nothing is pickable (the dropdowns show only 'Add API keys…')", () => {
  const allKeyed = MODELS.filter((m) => m.keyEnv).map((m) => ({ ...m, available: false }));
  assert.deepEqual(pickableModels(allKeyed), []);
  assert.equal(missingKeyFor("gpt", allKeyed), "OPENAI_API_KEY");
});

test("availability recomputes from the server payload after a key save — no reload", () => {
  // Before: no keys at all — only the keyless local model is pickable.
  const before = pickableModels(modelOptions(defaultModels(), {}));
  assert.ok(before.length > 0, "keyless models keep the picker non-empty");
  assert.ok(before.every((m) => !m.keyEnv));

  // After "saving" an Anthropic key (what POST /api/settings/keys does), the
  // same registry yields the Claude models as pickable.
  const after = pickableModels(modelOptions(defaultModels(), { ANTHROPIC_API_KEY: "sk-ant-123" }));
  assert.ok(after.some((m) => m.id === "claude-opus-4.8"));
  assert.ok(!after.some((m) => m.id === "gpt-5.2")); // still no OpenAI key

  // And removing the key strands a selected Claude model: still shown, marked.
  const removed = modelOptions(defaultModels(), {});
  assert.equal(missingKeyFor("claude-opus-4.8", removed), "ANTHROPIC_API_KEY");
  assert.match(pickerLabel("claude-opus-4.8", removed), /\(key missing\)$/);
});
