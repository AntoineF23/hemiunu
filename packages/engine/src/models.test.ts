import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anyModelAvailable,
  costUsd,
  defaultModels,
  keyEnvFor,
  modelAvailable,
  loadModelRegistry,
  modelForTag,
  promptHintsBlock,
  registryReady,
  resolveDefaultModel,
  resolveModel,
  type ModelEntry,
} from "./models";
import { emptyUsage } from "./events";

const tmp = () => mkdtempSync(join(tmpdir(), "hemiunu-engine-models-"));

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("loadModelRegistry: no user file returns the shipped defaults", () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadModelRegistry(dir), defaultModels());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadModelRegistry: user entries override same-id defaults and append new ids", () => {
  const dir = tmp();
  try {
    const override: ModelEntry = {
      id: "claude-sonnet-4.6",
      label: "My Sonnet",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextWindow: 200_000,
      supports: { tools: true },
    };
    const custom: ModelEntry = {
      id: "my-local",
      label: "Local model",
      provider: "openai-compatible",
      model: "llama-local",
      baseURL: "http://localhost:8080/v1",
      apiKeyEnv: "LOCAL_KEY",
      contextWindow: 32_000,
      supports: { tools: false },
    };
    writeFileSync(join(dir, "models.json"), JSON.stringify([override, custom]));

    const registry = loadModelRegistry(dir);
    assert.equal(registry.length, defaultModels().length + 1);
    const sonnet = registry.find((m) => m.id === "claude-sonnet-4.6");
    assert.equal(sonnet?.label, "My Sonnet");
    assert.equal(sonnet?.contextWindow, 200_000);
    assert.ok(registry.some((m) => m.id === "my-local"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadModelRegistry: invalid JSON and bad entries are tolerated", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "models.json"), "{ not json");
    assert.deepEqual(loadModelRegistry(dir), defaultModels());

    // A bad entry (missing fields) is skipped; a valid one still lands.
    const valid: ModelEntry = {
      id: "ok-model",
      label: "OK",
      provider: "openai",
      model: "gpt-5.2",
      contextWindow: 400_000,
      supports: { tools: true },
    };
    writeFileSync(join(dir, "models.json"), JSON.stringify([{ id: "broken" }, valid]));
    const registry = loadModelRegistry(dir);
    assert.equal(registry.length, defaultModels().length + 1);
    assert.ok(registry.some((m) => m.id === "ok-model"));
    assert.ok(!registry.some((m) => m.id === "broken"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModel: missing key throws an actionable message naming the env var", () => {
  withEnv({ OPENAI_API_KEY: undefined }, () => {
    assert.throws(
      () => resolveModel("gpt-5.2", defaultModels()),
      /Model gpt-5\.2 needs OPENAI_API_KEY — add it to ~\/\.hemiunu\/\.env\./,
    );
  });
});

test("resolveModel: unknown id lists the known models", () => {
  assert.throws(() => resolveModel("nope", defaultModels()), /Unknown model 'nope'/);
});

test("resolveModel: builds a language model per provider with fake keys", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "test-anthropic",
      ANTHROPIC_BASE_URL: undefined,
      OPENAI_API_KEY: "test-openai",
      GEMINI_API_KEY: "test-gemini",
      GROQ_API_KEY: "test-groq",
    },
    () => {
      for (const id of ["claude-opus-4.8", "gpt-5.2", "gemini-2.5-flash", "groq-llama"]) {
        const resolved = resolveModel(id, defaultModels());
        assert.equal(resolved.entry.id, id);
        assert.ok(resolved.languageModel, `${id} should resolve to a LanguageModel`);
      }
    },
  );
});

test("resolveModel: reasoning options surface as providerOptions", () => {
  withEnv({ ANTHROPIC_API_KEY: "test-anthropic" }, () => {
    const entry: ModelEntry = {
      ...defaultModels()[0],
      id: "opus-thinking",
      reasoning: { thinking: { type: "enabled", budgetTokens: 4096 } },
    };
    const resolved = resolveModel("opus-thinking", [entry]);
    assert.deepEqual(resolved.providerOptions, {
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
  });
});

test("modelForTag: first tagged entry wins, fallback covers untagged registries", () => {
  const registry = defaultModels();
  assert.equal(modelForTag("synthesis", registry, "gpt-5.2").id, "claude-opus-4.8");
  assert.equal(modelForTag("research", registry, "gpt-5.2").id, "claude-sonnet-4.6");

  const untagged = registry.map((m) => ({ ...m, tags: undefined }));
  assert.equal(modelForTag("judge", untagged, "gpt-5.2").id, "gpt-5.2");
  assert.throws(() => modelForTag("judge", untagged, "missing"), /fallback 'missing'/);
});

test("costUsd: per-Mtok math, cache rates defaulting to the input rate", () => {
  const entry: ModelEntry = {
    ...defaultModels()[0],
    cost: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    cacheReadTokens: 500_000,
    cacheWriteTokens: 100_000,
    steps: 2,
  };
  // 3 + 0.2*15 + 0.5*0.3 + 0.1*3.75 = 6.525
  assert.ok(Math.abs(costUsd(entry, usage) - 6.525) < 1e-9);

  // Unspecified cache rates fall back to the input rate.
  const noCacheRates: ModelEntry = { ...entry, cost: { in: 3, out: 15 } };
  // 3 + 3 + 1.5 + 0.3 = 7.8
  assert.ok(Math.abs(costUsd(noCacheRates, usage) - 7.8) < 1e-9);
});

test("costUsd: unknown pricing reports 0", () => {
  // An entry without a price table (e.g. the local Ollama default) reports 0.
  const entry = defaultModels().find((m) => m.cost === undefined);
  assert.ok(entry, "expected at least one default entry without a price table");
  assert.equal(costUsd(entry, { ...emptyUsage(), inputTokens: 123_456 }), 0);
});

test("costUsd: the shipped Claude defaults carry a nonzero price table", () => {
  const opus = defaultModels().find((m) => m.id === "claude-opus-4.8");
  const sonnet = defaultModels().find((m) => m.id === "claude-sonnet-4.6");
  assert.deepEqual(opus?.cost, { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  assert.deepEqual(sonnet?.cost, { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
});

test("promptHintsBlock: renders the entry's family addenda, undefined when absent", () => {
  const bare = defaultModels().find((m) => m.id === "claude-opus-4.8");
  assert.ok(bare);
  assert.equal(promptHintsBlock(bare), undefined);
  const hinted: ModelEntry = { ...bare, promptHints: ["Say Hemiunu.", "Answer directly."] };
  const block = promptHintsBlock(hinted);
  assert.ok(block);
  assert.match(block, /^## Model-specific adjustments/);
  assert.match(block, /- Say Hemiunu\.\n- Answer directly\.$/);
});

test("promptHints: shipped ministral entry carries the family hints; round-trips models.json", () => {
  // The ministral (Ollama) default ships the persona + post-delegation addenda.
  const ministral = defaultModels().find((m) => m.id === "ministral-3:14b");
  assert.ok(ministral?.promptHints && ministral.promptHints.length >= 2);
  assert.match(ministral.promptHints.join(" "), /Hemiunu/);

  // A user entry with promptHints parses through the models.json overlay.
  const dir = tmp();
  try {
    const custom: ModelEntry = {
      id: "hinted-local",
      label: "Hinted",
      provider: "openai-compatible",
      model: "x",
      baseURL: "http://localhost:9/v1",
      contextWindow: 8_000,
      supports: { tools: true },
      promptHints: ["Be terse."],
    };
    writeFileSync(join(dir, "models.json"), JSON.stringify([custom]));
    const loaded = loadModelRegistry(dir).find((m) => m.id === "hinted-local");
    assert.deepEqual(loaded?.promptHints, ["Be terse."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost: the LiteLLM proxy defaults carry price tables (gpt-4o no longer $0)", () => {
  const gpt4o = defaultModels().find((m) => m.id === "gpt-4o");
  assert.deepEqual(gpt4o?.cost, { in: 2.5, out: 10, cacheRead: 1.25 });
  for (const id of ["deepseek-v3", "qwen3-235b-instruct", "mistral-medium"]) {
    const entry = defaultModels().find((m) => m.id === id);
    assert.ok(entry?.cost && entry.cost.in > 0 && entry.cost.out > 0, `${id} should be priced`);
    assert.equal(entry.provider, "openai-compatible");
    assert.equal(entry.apiKeyEnv, "LITELLM_API_KEY");
  }
});

test("keyEnvFor: entry apiKeyEnv wins, provider default fills in, keyless local is undefined", () => {
  const openai = defaultModels().find((m) => m.id === "gpt-5.2");
  assert.equal(openai && keyEnvFor(openai), "OPENAI_API_KEY");
  // No apiKeyEnv on the entry → the provider's conventional default.
  const bare: ModelEntry = {
    id: "g",
    label: "G",
    provider: "google",
    model: "gemini-x",
    contextWindow: 1000,
    supports: { tools: true },
  };
  assert.equal(keyEnvFor(bare), "GEMINI_API_KEY");
  // Keyless openai-compatible (Ollama) → nothing to configure.
  const ollama = defaultModels().find((m) => m.id === "ministral-3:14b");
  assert.equal(ollama && keyEnvFor(ollama), undefined);
});

test("modelAvailable: true when keyless or the key env holds a non-blank value", () => {
  const gpt = defaultModels().find((m) => m.id === "gpt-5.2");
  assert.ok(gpt);
  assert.equal(modelAvailable(gpt, {}), false);
  assert.equal(modelAvailable(gpt, { OPENAI_API_KEY: "   " }), false);
  assert.equal(modelAvailable(gpt, { OPENAI_API_KEY: "sk-test" }), true);
  const ollama = defaultModels().find((m) => m.id === "ministral-3:14b");
  assert.ok(ollama);
  assert.equal(modelAvailable(ollama, {}), true);
});

// --- first-run readiness (the gate rule) + default-model resolution ----------

/** A keyed registry with NO keyless entries — readiness must hinge on env. */
function keyedOnly(): ModelEntry[] {
  return defaultModels().filter((m) => keyEnvFor(m) !== undefined);
}

const keylessEntry: ModelEntry = {
  id: "local-llm",
  label: "Local LLM",
  provider: "openai-compatible",
  model: "local-llm",
  baseURL: "http://localhost:11434/v1",
  contextWindow: 32_000,
  supports: { tools: true },
};

test("anyModelAvailable: ANY set key counts, keyless counts, none → not ready", () => {
  // No env var is special-cased: an Anthropic-less machine with only a
  // LiteLLM (or Gemini, or Groq…) key is ready.
  assert.equal(anyModelAvailable(keyedOnly(), {}), false);
  assert.equal(anyModelAvailable(keyedOnly(), { LITELLM_API_KEY: "sk-lite" }), true);
  assert.equal(anyModelAvailable(keyedOnly(), { GEMINI_API_KEY: "sk-gem" }), true);
  assert.equal(anyModelAvailable(keyedOnly(), { ANTHROPIC_API_KEY: "  " }), false);
  // A keyless local entry (Ollama) counts as usable in the pure rule.
  assert.equal(anyModelAvailable([keylessEntry], {}), true);
});

test("registryReady: set keys short-circuit; keyless entries count only when answering", async () => {
  const never = async () => {
    throw new Error("probe must not run when a key is set");
  };
  assert.equal(await registryReady(keyedOnly(), { OPENAI_API_KEY: "sk-x" }, never), true);
  // Keyless-only registries hinge on the endpoint actually being up —
  // otherwise a fresh machine with no keys AND no local server would skip
  // the first-run setup and die on a connection error instead.
  assert.equal(await registryReady([keylessEntry], {}, async () => true), true);
  assert.equal(await registryReady([keylessEntry], {}, async () => false), false);
  assert.equal(await registryReady(keyedOnly(), {}, async () => true), false);
  // Duplicate baseURLs are probed once.
  const seen: string[] = [];
  await registryReady([keylessEntry, { ...keylessEntry, id: "local-2" }], {}, async (base) => {
    seen.push(base);
    return false;
  });
  assert.deepEqual(seen, ["http://localhost:11434/v1"]);
});

test("resolveDefaultModel: preferred-if-usable, else first available (tag first), never throws", () => {
  const shipped = defaultModels();
  // The persisted HEMIUNU_MODEL wins when its key is set.
  assert.equal(
    resolveDefaultModel(shipped, { LITELLM_API_KEY: "sk" }, "deepseek-v3"),
    "deepseek-v3",
  );
  // The old hardcoded Claude default without an Anthropic key falls to the
  // FIRST AVAILABLE model instead of erroring at turn start.
  assert.equal(
    resolveDefaultModel(shipped, { LITELLM_API_KEY: "sk" }, "claude-opus-4.8"),
    "gpt-4o",
  );
  // With an Anthropic key and no preference, the synthesis tag routes to Opus;
  // the research tag to Sonnet.
  assert.equal(resolveDefaultModel(shipped, { ANTHROPIC_API_KEY: "sk" }), "claude-opus-4.8");
  assert.equal(
    resolveDefaultModel(shipped, { ANTHROPIC_API_KEY: "sk" }, undefined, "research"),
    "claude-sonnet-4.6",
  );
  // A tagged entry beats an untagged earlier one when both are available.
  assert.equal(
    resolveDefaultModel(shipped, { ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "sk" }),
    "claude-opus-4.8",
  );
  // Nothing available: keep the user's known preference (never silently
  // rewrite it), else fall to the tag route — but never throw.
  assert.equal(resolveDefaultModel(keyedOnly(), {}, "gpt-5.2"), "gpt-5.2");
  assert.equal(resolveDefaultModel(keyedOnly(), {}), "claude-opus-4.8");
  // An unknown preferred id falls through to the availability route.
  assert.equal(
    resolveDefaultModel(keyedOnly(), { OPENAI_API_KEY: "sk" }, "not-a-model"),
    "gpt-5.2",
  );
});

test("shipped defaults: qwen3-235b-instruct carries the real 262,144 window — the shipped 128k undersold it and masked the switch-model compaction bug", () => {
  const qwen = defaultModels().find((m) => m.id === "qwen3-235b-instruct");
  // Vertex AI's rejection message names the real serving window:
  // "longer than the model's context length (262144 tokens)".
  assert.equal(qwen?.contextWindow, 262_144);
});

test("shipped defaults: deepseek-v3 carries the proxy's real 163,840 window (the live overflow named it)", () => {
  const deepseek = defaultModels().find((m) => m.id === "deepseek-v3");
  // The proxy rejected a 172,721-token request naming the real limit 163,840;
  // budgeting against the true window is safe because the compactor's estimate
  // is conservative (counts tool schemas + system) and compactAt leaves margin.
  assert.equal(deepseek?.contextWindow, 163_840);
  // Every proxy-routed window must stay ≤ its underlying model's real limit.
  for (const id of ["gpt-4o", "mistral-medium"]) {
    const entry = defaultModels().find((m) => m.id === id);
    assert.equal(entry?.contextWindow, 128_000, `${id} window`);
  }
});
