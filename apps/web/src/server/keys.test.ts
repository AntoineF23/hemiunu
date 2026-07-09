// API-key management + gateway discovery: the helpers (masking, availability,
// URL normalization, models.json merge) and the routes end-to-end through Hono.
// Everything runs against a sandbox HEMIUNU_CONFIG_DIR — the real ~/.hemiunu is
// never read for assertions and never written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { defaultModels, type ModelEntry } from "@hemiunu/engine";
import {
  addGatewayModels,
  allowedKeyEnvs,
  GATEWAY_PRESETS,
  keyStatuses,
  maskTail,
  modelOptions,
  normalizeGatewayBase,
  parseDiscoveredModels,
} from "./keys";
import { keysRoute } from "./routes/keys";

// --- helpers -----------------------------------------------------------------

test("maskTail: 4-char tail for real keys, nothing for short ones", () => {
  assert.equal(maskTail("sk-ant-abc123x4Qz"), "…x4Qz");
  assert.equal(maskTail("  sk-padded-x4Qz  "), "…x4Qz");
  assert.equal(maskTail("short"), undefined); // a tail of a 5-char secret IS the secret
  assert.equal(maskTail(""), undefined);
  assert.equal(maskTail(undefined), undefined);
});

test("keyStatuses: one row per distinct key env, with dependent models; keyless entries skipped", () => {
  const statuses = keyStatuses(defaultModels(), {
    OPENAI_API_KEY: "sk-openai-123456",
    LITELLM_API_KEY: "   ", // blank = not set
  });
  const byEnv = new Map(statuses.map((s) => [s.env, s]));

  const openai = byEnv.get("OPENAI_API_KEY");
  assert.ok(openai?.set);
  assert.equal(openai.maskedTail, "…3456");
  assert.deepEqual(openai.models, ["gpt-5.2", "gpt-5.4-mini"]);

  const anthropic = byEnv.get("ANTHROPIC_API_KEY");
  assert.equal(anthropic?.set, false);
  assert.equal(anthropic?.maskedTail, undefined);
  assert.deepEqual(anthropic?.models, ["claude-opus-4.8", "claude-sonnet-4.6"]);

  const litellm = byEnv.get("LITELLM_API_KEY");
  assert.equal(litellm?.set, false);
  assert.ok((litellm?.models.length ?? 0) >= 4); // the LiteLLM proxy group

  // The keyless Ollama entry contributes no key row at all.
  for (const s of statuses) assert.ok(!s.models.includes("ministral-3:14b"));
});

test("keyStatuses: NEVER contains a key value, only booleans and the masked tail", () => {
  const secret = "sk-super-secret-value-123456";
  const json = JSON.stringify(keyStatuses(defaultModels(), { OPENAI_API_KEY: secret }));
  assert.ok(!json.includes(secret));
  assert.ok(!json.includes(secret.slice(0, 10)));
  assert.ok(json.includes("…3456")); // recognition tail only
});

test("modelOptions: availability follows the key env; keyless local models are always available", () => {
  const opts = modelOptions(defaultModels(), { ANTHROPIC_API_KEY: "sk-ant-12345678" });
  const by = new Map(opts.map((o) => [o.id, o]));
  assert.deepEqual(by.get("claude-opus-4.8"), {
    id: "claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    keyEnv: "ANTHROPIC_API_KEY",
    available: true,
  });
  assert.equal(by.get("gpt-5.2")?.available, false);
  assert.equal(by.get("gpt-5.2")?.keyEnv, "OPENAI_API_KEY");
  assert.equal(by.get("ministral-3:14b")?.available, true); // keyless Ollama
  assert.equal(by.get("ministral-3:14b")?.keyEnv, null);
});

test("normalizeGatewayBase: with/without /v1 and trailing slashes converge", () => {
  for (const raw of [
    "https://gateway.example.com",
    "https://gateway.example.com/",
    "https://gateway.example.com/v1",
    "https://gateway.example.com/v1/",
  ]) {
    assert.deepEqual(normalizeGatewayBase(raw), { base: "https://gateway.example.com/v1" });
  }
  assert.deepEqual(normalizeGatewayBase("http://localhost:4000/openai"), {
    base: "http://localhost:4000/openai/v1",
  });
});

test("normalizeGatewayBase: http(s) only, no embedded credentials, no garbage", () => {
  assert.ok("error" in normalizeGatewayBase("ftp://gateway.example.com"));
  assert.ok("error" in normalizeGatewayBase("file:///etc/passwd"));
  assert.ok("error" in normalizeGatewayBase("https://user:pass@gateway.example.com"));
  assert.ok("error" in normalizeGatewayBase("not a url"));
  assert.ok("error" in normalizeGatewayBase(""));
});

test("parseDiscoveredModels: OpenAI shape, bare arrays, {models}, dedup; junk → undefined", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] }), [
    "a",
    "b",
  ]);
  assert.deepEqual(parseDiscoveredModels(["x", { id: "y" }, 42]), ["x", "y"]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ id: "m" }] }), ["m"]);
  assert.equal(parseDiscoveredModels({ error: "nope" }), undefined);
  assert.equal(parseDiscoveredModels("gibberish"), undefined);
});

test("addGatewayModels: creates models.json with gateway defaults, merges without duplicating", () => {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-keys-"));
  try {
    // Pre-existing user entry must survive untouched.
    const userEntry = { id: "my-custom", label: "Mine", note: "hand-written" };
    writeFileSync(join(dir, "models.json"), JSON.stringify([userEntry]));

    const first = addGatewayModels(dir, {
      baseURL: "https://gateway.example.com/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      models: [{ id: "sonar-pro" }, { id: "big-model", label: "Big", contextWindow: 200_000 }],
    });
    assert.deepEqual(first, { added: ["sonar-pro", "big-model"] });

    const entries = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as ModelEntry[];
    assert.deepEqual(entries[0], userEntry); // preserved verbatim
    const sonar = entries.find((e) => e.id === "sonar-pro");
    assert.deepEqual(sonar, {
      id: "sonar-pro",
      label: "sonar-pro (gateway)",
      provider: "openai-compatible",
      model: "sonar-pro",
      baseURL: "https://gateway.example.com/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      // Unknown id, no metadata ⇒ the CONSERVATIVE fallback (32k), never an
      // optimistic 128k — overshooting the real window ships requests the
      // provider rejects with ContextWindowExceeded.
      contextWindow: 32_768,
      supports: { tools: true },
    });
    assert.equal(entries.find((e) => e.id === "big-model")?.contextWindow, 200_000);

    // Re-adding the same id replaces, never duplicates.
    addGatewayModels(dir, {
      baseURL: "https://gateway.example.com/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      models: [{ id: "sonar-pro", contextWindow: 32_000 }],
    });
    const again = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as ModelEntry[];
    assert.equal(again.filter((e) => e.id === "sonar-pro").length, 1);
    assert.equal(again.find((e) => e.id === "sonar-pro")?.contextWindow, 32_000);
    assert.equal(again.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addGatewayModels: refuses to clobber an unparsable models.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-keys-"));
  try {
    writeFileSync(join(dir, "models.json"), "{ hand-edited garbage");
    const res = addGatewayModels(dir, {
      baseURL: "https://x.example/v1",
      apiKeyEnv: "X_API_KEY",
      models: [{ id: "m" }],
    });
    assert.ok("error" in res);
    assert.equal(readFileSync(join(dir, "models.json"), "utf8"), "{ hand-edited garbage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowedKeyEnvs: the registry's key envs PLUS every gateway preset env — arbitrary names still out", () => {
  const allowed = allowedKeyEnvs(defaultModels());
  assert.ok(allowed.has("ANTHROPIC_API_KEY"));
  assert.ok(allowed.has("LITELLM_API_KEY"));
  // Preset envs are allowlisted even before any model references them, so a
  // brand-new gateway key can be saved on the first try.
  for (const p of GATEWAY_PRESETS) assert.ok(allowed.has(p.apiKeyEnv), `${p.apiKeyEnv} allowed`);
  assert.ok(allowed.has("OPENROUTER_API_KEY"));
  assert.ok(allowed.has("TOGETHER_API_KEY"));
  assert.ok(allowed.has("VLLM_API_KEY"));
  assert.ok(!allowed.has("PATH"));
  assert.ok(!allowed.has("GITHUB_TOKEN"));
});

// --- routes (end-to-end through Hono, sandbox config dir) ---------------------

/** Run fn with HEMIUNU_CONFIG_DIR pointed at a fresh temp dir, then restore. */
async function withSandbox(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-keys-routes-"));
  const prev = process.env.HEMIUNU_CONFIG_DIR;
  process.env.HEMIUNU_CONFIG_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
    else process.env.HEMIUNU_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/settings/keys: rejects env names outside the registry allowlist", async () => {
  await withSandbox(async () => {
    for (const env of ["GITHUB_TOKEN", "PATH", "openai_api_key", "EVIL; rm -rf", ""]) {
      const res = await keysRoute.request(post("/api/settings/keys", { env, value: "x" }));
      assert.equal(res.status, 400, `env ${JSON.stringify(env)} must be rejected`);
    }
  });
});

test("POST /api/settings/keys: rejects multi-line values (no .env line injection)", async () => {
  await withSandbox(async () => {
    const res = await keysRoute.request(
      post("/api/settings/keys", { env: "OPENAI_API_KEY", value: "sk-x\nGITHUB_TOKEN=evil" }),
    );
    assert.equal(res.status, 400);
  });
});

test("POST /api/settings/keys: accepts a preset gateway env (OPENROUTER_API_KEY) before any model references it", async () => {
  await withSandbox(async (dir) => {
    const prev = process.env.OPENROUTER_API_KEY;
    try {
      const secret = "sk-or-v1-abcdef1234";
      const res = await keysRoute.request(
        post("/api/settings/keys", { env: "OPENROUTER_API_KEY", value: secret }),
      );
      assert.equal(res.status, 200, "a preset env is allowlisted even with no models yet");
      const body = await res.text();
      assert.ok(!body.includes(secret), "the response must never echo the key");
      assert.match(
        readFileSync(join(dir, ".env"), "utf8"),
        /^OPENROUTER_API_KEY=sk-or-v1-abcdef1234$/m,
      );
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });
});

test("POST /api/settings/keys: saves with line surgery + 0600, responds masked, and removes on empty", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, ".env"), "# unrelated\nGITHUB_TOKEN=gh-keep\n");
    const prev = process.env.OPENAI_API_KEY;
    try {
      const secret = "sk-live-abcdef-x4Qz";
      const res = await keysRoute.request(
        post("/api/settings/keys", { env: "OPENAI_API_KEY", value: secret }),
      );
      assert.equal(res.status, 200);
      const bodyText = await res.text();
      assert.ok(!bodyText.includes(secret), "the response must never echo the key");
      const body = JSON.parse(bodyText) as {
        keys: { env: string; set: boolean; maskedTail?: string }[];
        models: { id: string; available: boolean }[];
      };
      const openai = body.keys.find((k) => k.env === "OPENAI_API_KEY");
      assert.deepEqual(
        { set: openai?.set, maskedTail: openai?.maskedTail },
        { set: true, maskedTail: "…x4Qz" },
      );
      // Availability flips immediately — no worker restart.
      assert.equal(body.models.find((m) => m.id === "gpt-5.2")?.available, true);

      const text = readFileSync(join(dir, ".env"), "utf8");
      assert.match(text, /^# unrelated$/m);
      assert.match(text, /^GITHUB_TOKEN=gh-keep$/m);
      assert.match(text, /^OPENAI_API_KEY=sk-live-abcdef-x4Qz$/m);
      assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);

      // Empty value = remove the line (and only that line).
      const rm = await keysRoute.request(
        post("/api/settings/keys", { env: "OPENAI_API_KEY", value: "" }),
      );
      assert.equal(rm.status, 200);
      const after = readFileSync(join(dir, ".env"), "utf8");
      assert.doesNotMatch(after, /OPENAI_API_KEY/);
      assert.match(after, /^GITHUB_TOKEN=gh-keep$/m);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

test("GET /api/settings/keys: statuses + availability, no secrets", async () => {
  await withSandbox(async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-testing-4Qz9";
    try {
      const res = await keysRoute.request("/api/settings/keys");
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes("sk-ant-testing-4Qz9"));
      const body = JSON.parse(text) as {
        keys: { env: string; set: boolean }[];
        models: { id: string }[];
      };
      assert.ok(body.keys.find((k) => k.env === "ANTHROPIC_API_KEY")?.set);
      assert.ok(body.models.some((m) => m.id === "claude-opus-4.8"));
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

test("POST /api/settings/gateway/discover: rejects non-http(s) URLs outright", async () => {
  await withSandbox(async () => {
    const res = await keysRoute.request(
      post("/api/settings/gateway/discover", { baseURL: "file:///etc/passwd" }),
    );
    assert.equal(res.status, 400);
  });
});

/** A tiny local OpenAI-compatible /v1/models endpoint for offline discovery
 *  tests. The metadata probes (/model/info, /v1/model/info) answer 403 like an
 *  admin-only LiteLLM unless an `info` handler is provided. */
function fakeGateway(
  handler: (auth: string | undefined) => { status: number; body: unknown },
  info?: () => { status: number; body: unknown },
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/model/info" || req.url === "/v1/model/info") {
        const r = info?.() ?? { status: 403, body: { detail: "admin only" } };
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
        return;
      }
      assert.equal(req.url, "/v1/models");
      const { status, body } = handler(req.headers.authorization);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("POST /api/settings/gateway/discover: normalizes the base, lists models, flags already-added ids", async () => {
  await withSandbox(async () => {
    const { server, url } = await fakeGateway((auth) => {
      assert.equal(auth, "Bearer sk-gw-test"); // the key travels as a Bearer header
      return { status: 200, body: { data: [{ id: "sonar-pro" }, { id: "gpt-4o" }] } };
    });
    try {
      // No /v1 on the input URL — the server normalizes and still finds /v1/models.
      const res = await keysRoute.request(
        post("/api/settings/gateway/discover", { baseURL: url, apiKey: "sk-gw-test" }),
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        baseURL: string;
        models: { id: string; added: boolean; contextWindow: number }[];
      };
      assert.equal(body.baseURL, `${url}/v1`);
      // /model/info is admin-only here (the common LiteLLM posture), so each
      // id carries the ctx it would REGISTER with: curated for known families,
      // the conservative 32k fallback for unknowns — never an optimistic 128k.
      assert.deepEqual(body.models, [
        { id: "sonar-pro", added: false, contextWindow: 32_768 },
        { id: "gpt-4o", added: true, contextWindow: 128_000 }, // shipped LiteLLM default — already in the registry
      ]);
    } finally {
      server.close();
    }
  });
});

test("POST /api/settings/gateway/discover: gateway metadata (when allowed) beats the curated map", async () => {
  await withSandbox(async () => {
    const { server, url } = await fakeGateway(
      () => ({ status: 200, body: { data: [{ id: "sonar-pro" }] } }),
      () => ({
        status: 200,
        body: { data: [{ model_name: "sonar-pro", model_info: { max_input_tokens: 100_000 } }] },
      }),
    );
    try {
      const res = await keysRoute.request(
        post("/api/settings/gateway/discover", { baseURL: url, apiKey: "sk-gw-test" }),
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { models: { id: string; contextWindow: number }[] };
      assert.deepEqual(body.models, [{ id: "sonar-pro", added: false, contextWindow: 100_000 }]);
    } finally {
      server.close();
    }
  });
});

test("POST /api/settings/gateway/discover: a 401 comes back as a clean key hint, not a raw dump", async () => {
  await withSandbox(async () => {
    const { server, url } = await fakeGateway(() => ({
      status: 401,
      body: { error: "unauthorized" },
    }));
    try {
      const res = await keysRoute.request(
        post("/api/settings/gateway/discover", { baseURL: url, apiKey: "sk-wrong" }),
      );
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /401.*check the API key/);
    } finally {
      server.close();
    }
  });
});

test("POST /api/settings/gateway/discover: an unrecognizable payload is a clean error", async () => {
  await withSandbox(async () => {
    const { server, url } = await fakeGateway(() => ({ status: 200, body: { error: "weird" } }));
    try {
      const res = await keysRoute.request(post("/api/settings/gateway/discover", { baseURL: url }));
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /recognizable model list/);
    } finally {
      server.close();
    }
  });
});

test("POST /api/settings/gateway/models: registers entries, then the key env is allowlisted for saves", async () => {
  await withSandbox(async (dir) => {
    const prev = process.env.SONAR_GATEWAY_API_KEY;
    try {
      // The brand-new env isn't allowlisted yet — a key save must be refused…
      const early = await keysRoute.request(
        post("/api/settings/keys", { env: "SONAR_GATEWAY_API_KEY", value: "sk-abcdef123" }),
      );
      assert.equal(early.status, 400);

      const res = await keysRoute.request(
        post("/api/settings/gateway/models", {
          baseURL: "https://gateway.example.com", // normalized to …/v1 on write
          apiKeyEnv: "SONAR_GATEWAY_API_KEY",
          models: [{ id: "sonar-pro" }],
        }),
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        added: string[];
        models: { id: string; available: boolean; keyEnv: string | null }[];
      };
      assert.deepEqual(body.added, ["sonar-pro"]);
      const entry = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))[0] as ModelEntry;
      assert.equal(entry.baseURL, "https://gateway.example.com/v1");

      // …and now that the registry references it, the same save is accepted.
      const late = await keysRoute.request(
        post("/api/settings/keys", { env: "SONAR_GATEWAY_API_KEY", value: "sk-abcdef123" }),
      );
      assert.equal(late.status, 200);
      const keys = ((await late.json()) as { keys: { env: string; set: boolean }[] }).keys;
      assert.ok(keys.find((k) => k.env === "SONAR_GATEWAY_API_KEY")?.set);
    } finally {
      if (prev === undefined) delete process.env.SONAR_GATEWAY_API_KEY;
      else process.env.SONAR_GATEWAY_API_KEY = prev;
    }
  });
});

test("POST /api/settings/gateway/discover: a non-LiteLLM gateway (OpenAI-compatible /models) parses, reading a saved PRESET env", async () => {
  await withSandbox(async () => {
    // OPENROUTER_API_KEY is a preset env — the discover route must accept it as
    // a credential source even though no registry model references it yet.
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-live-999";
    const { server, url } = await fakeGateway((auth) => {
      assert.equal(auth, "Bearer sk-or-live-999", "the saved preset env travels as the Bearer");
      // A generic OpenAI-compatible listing from a non-LiteLLM host.
      return {
        status: 200,
        body: { data: [{ id: "meta-llama/llama-3.1-70b" }, { id: "qwen/qwen3-235b" }] },
      };
    });
    try {
      const res = await keysRoute.request(
        post("/api/settings/gateway/discover", { baseURL: url, apiKeyEnv: "OPENROUTER_API_KEY" }),
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        baseURL: string;
        models: { id: string; added: boolean; contextWindow: number }[];
      };
      assert.equal(body.baseURL, `${url}/v1`);
      assert.deepEqual(
        body.models.map((m) => m.id),
        ["meta-llama/llama-3.1-70b", "qwen/qwen3-235b"],
      );
      // Curated windows resolve through an org/route prefix (strip before match).
      const byId = new Map(body.models.map((m) => [m.id, m.contextWindow]));
      assert.equal(byId.get("meta-llama/llama-3.1-70b"), 128_000);
      assert.equal(byId.get("qwen/qwen3-235b"), 262_144);
    } finally {
      server.close();
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });
});

test("POST /api/settings/gateway/models: an apiKey is persisted alongside the models, never echoed", async () => {
  await withSandbox(async (dir) => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const secret = "sk-or-persist-4Qz9";
      const res = await keysRoute.request(
        post("/api/settings/gateway/models", {
          baseURL: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
          apiKey: secret,
          models: [{ id: "meta-llama/llama-3.1-70b", contextWindow: 128_000 }],
        }),
      );
      assert.equal(res.status, 200);
      const bodyText = await res.text();
      assert.ok(!bodyText.includes(secret), "the register response must never echo the key");
      const body = JSON.parse(bodyText) as { added: string[] };
      assert.deepEqual(body.added, ["meta-llama/llama-3.1-70b"]);

      // models.json got the right provider entry (apiKeyEnv + normalized base).
      const entries = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as ModelEntry[];
      const entry = entries.find((e) => e.id === "meta-llama/llama-3.1-70b");
      assert.equal(entry?.provider, "openai-compatible");
      assert.equal(entry?.apiKeyEnv, "OPENROUTER_API_KEY");
      assert.equal(entry?.baseURL, "https://openrouter.ai/api/v1");

      // …and the key was written to .env, so the gateway is ready in one pass.
      assert.match(
        readFileSync(join(dir, ".env"), "utf8"),
        /^OPENROUTER_API_KEY=sk-or-persist-4Qz9$/m,
      );
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });
});

test("POST /api/settings/gateway/models: bad env name or empty selection is a 400", async () => {
  await withSandbox(async () => {
    const bad = await keysRoute.request(
      post("/api/settings/gateway/models", {
        baseURL: "https://x.example",
        apiKeyEnv: "lower case",
        models: [{ id: "m" }],
      }),
    );
    assert.equal(bad.status, 400);
    const empty = await keysRoute.request(
      post("/api/settings/gateway/models", {
        baseURL: "https://x.example",
        apiKeyEnv: "X_API_KEY",
        models: [],
      }),
    );
    assert.equal(empty.status, 400);
  });
});
