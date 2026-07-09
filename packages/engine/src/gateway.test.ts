// Discovery-default safety: context windows for gateway models must come from
// real metadata when the proxy allows it, a curated per-family value when it
// doesn't (LiteLLM's /model/info is often admin-only), and a CONSERVATIVE
// fallback otherwise — an optimistic default ships requests the provider
// rejects with ContextWindowExceeded. (addGatewayModels itself is covered by
// apps/web's keys.test.ts.)

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextWindowForId,
  FALLBACK_CONTEXT_WINDOW,
  fetchModelInfoWindows,
  GATEWAY_PRESETS,
  parseModelInfoWindows,
} from "./gateway";

// The uppercase _API_KEY env-name shape the write endpoints enforce (mirrors
// apps/web's ENV_NAME_RE — kept in sync by this assertion, not an import,
// because the engine must not depend on the web app).
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

test("GATEWAY_PRESETS: unique ids, valid apiKeyEnv shapes, includes the shipped set", () => {
  const ids = GATEWAY_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "preset ids must be unique");

  // The escape hatch must exist so an arbitrary gateway still works.
  assert.ok(ids.includes("custom"), "a 'custom' preset (escape hatch) must exist");
  for (const id of ["litellm", "openrouter", "together", "vllm"]) {
    assert.ok(ids.includes(id), `preset '${id}' must ship`);
  }

  for (const p of GATEWAY_PRESETS) {
    assert.match(p.apiKeyEnv, ENV_NAME_RE, `${p.id}: apiKeyEnv must look like LITELLM_API_KEY`);
    assert.ok(p.label.trim().length > 0, `${p.id}: label must be non-empty`);
    // A default base URL, when present, is an absolute http(s) URL.
    if (p.defaultBaseURL) {
      const u = new URL(p.defaultBaseURL);
      assert.ok(u.protocol === "http:" || u.protocol === "https:");
    }
  }

  // LiteLLM stays first so it remains the default selection.
  assert.equal(GATEWAY_PRESETS[0]?.id, "litellm");
  // Self-hosted presets ship no default base URL; hosted ones do.
  assert.equal(GATEWAY_PRESETS.find((p) => p.id === "litellm")?.defaultBaseURL, undefined);
  assert.equal(GATEWAY_PRESETS.find((p) => p.id === "vllm")?.defaultBaseURL, undefined);
  assert.equal(
    GATEWAY_PRESETS.find((p) => p.id === "openrouter")?.defaultBaseURL,
    "https://openrouter.ai/api/v1",
  );
});

test("contextWindowForId: curated families resolve to their documented windows", () => {
  // The live proxy's own catalog shapes (gateway.example.com, 2026-07).
  assert.equal(contextWindowForId("qwen3-235b-instruct"), 262_144); // confirmed by the proxy's rejection
  assert.equal(contextWindowForId("qwen3-coder"), 262_144);
  assert.equal(contextWindowForId("claude-haiku-4.5"), 200_000);
  assert.equal(contextWindowForId("claude-opus-4.6"), 200_000); // gateway floor, not the 1M direct tier
  assert.equal(contextWindowForId("gpt-4o"), 128_000);
  assert.equal(contextWindowForId("gpt-5.3-codex"), 400_000);
  assert.equal(contextWindowForId("gemini-2.5-pro"), 1_000_000);
  assert.equal(contextWindowForId("gemma-4-26b"), 128_000);
  assert.equal(contextWindowForId("deepseek-r1"), 128_000);
  assert.equal(contextWindowForId("kimi-k2-thinking"), 262_144);
  assert.equal(contextWindowForId("llama-4-scout"), 128_000);
  assert.equal(contextWindowForId("codestral-2"), 256_000);
  assert.equal(contextWindowForId("mistral-small"), 128_000);
  assert.equal(contextWindowForId("minimax-m2"), 200_000);
  assert.equal(contextWindowForId("glm-5"), 128_000);
  assert.equal(contextWindowForId("grok-4.20-reasoning"), 256_000);
  assert.equal(contextWindowForId("text-embedding-3-large"), 8_192);
});

test("contextWindowForId: an org/route prefix is stripped before matching", () => {
  assert.equal(contextWindowForId("vertex_ai/qwen3-235b-instruct"), 262_144);
  assert.equal(contextWindowForId("openai/gpt-4o-mini"), 128_000);
});

test("contextWindowForId: unknown ids get the conservative fallback, never 128k", () => {
  assert.equal(contextWindowForId("sonar-pro"), FALLBACK_CONTEXT_WINDOW);
  assert.equal(contextWindowForId("totally-new-model"), 32_768);
});

test("parseModelInfoWindows: LiteLLM /model/info shape, max_input_tokens preferred", () => {
  const payload = {
    data: [
      {
        model_name: "qwen3-235b-instruct",
        model_info: { max_input_tokens: 262_144, max_tokens: 32_768 },
      },
      { model_name: "gpt-4o", model_info: { max_tokens: 128_000 } }, // fallback field
      { model_name: "broken", model_info: { max_input_tokens: "big" } }, // non-numeric → skipped
      { model_name: "", model_info: { max_input_tokens: 1 } }, // blank name → skipped
      { nonsense: true },
    ],
  };
  assert.deepEqual(parseModelInfoWindows(payload), {
    "qwen3-235b-instruct": 262_144,
    "gpt-4o": 128_000,
  });
  assert.deepEqual(parseModelInfoWindows({ error: "nope" }), {});
  assert.deepEqual(parseModelInfoWindows(undefined), {});
});

test("fetchModelInfoWindows: tries the root and /v1 forms, and a 403 (admin-only) yields {}", async () => {
  const seen: string[] = [];
  // Admin-only proxy (the live gateway.example.com behavior): both forms 403.
  const forbidden = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ detail: "Virtual key is not allowed" }), { status: 403 });
  }) as typeof fetch;
  assert.deepEqual(await fetchModelInfoWindows("https://gw.example/v1", "sk-x", forbidden), {});
  assert.deepEqual(seen, ["https://gw.example/model/info", "https://gw.example/v1/model/info"]);

  // A proxy that allows it: first working form wins.
  const open = (async (url: string | URL | Request) => {
    if (String(url) === "https://gw.example/model/info") {
      return Response.json({
        data: [{ model_name: "m1", model_info: { max_input_tokens: 42_000 } }],
      });
    }
    throw new Error("should not fall through");
  }) as typeof fetch;
  assert.deepEqual(await fetchModelInfoWindows("https://gw.example/v1", "sk-x", open), {
    m1: 42_000,
  });

  // Network failure on both forms is swallowed — callers fall back to curated.
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  assert.deepEqual(await fetchModelInfoWindows("https://gw.example/v1", undefined, down), {});
});
