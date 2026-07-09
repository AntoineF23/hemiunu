// API-key management + gateway model discovery for the Settings panel.
//
// GET  /api/settings/keys            → key statuses + model availability (no values)
// POST /api/settings/keys            → { env, value } upsert / { env, value: "" } remove
// POST /api/settings/gateway/discover→ { baseURL, apiKey? | apiKeyEnv? } → model id list
// POST /api/settings/gateway/models  → register discovered models in models.json
//
// Writes are line-surgery on ~/.hemiunu/.env (agent-core's upsert/removeUserEnv:
// unrelated lines and comments survive, the file is 0600) and read-merge-write
// on ~/.hemiunu/models.json. upsertUserEnv also sets process.env, and the
// registry is re-read per turn/request — so a saved key or added gateway model
// is usable immediately, no worker restart.
import { Hono } from "hono";
import { configDir, removeUserEnv, upsertUserEnv } from "@hemiunu/agent-core";
import { loadModelRegistry } from "@hemiunu/engine";
import {
  addGatewayModels,
  allowedKeyEnvs,
  contextWindowForId,
  ENV_NAME_RE,
  fetchModelInfoWindows,
  keyStatuses,
  modelOptions,
  normalizeGatewayBase,
  parseDiscoveredModels,
  validKeyValue,
  type GatewayModelInput,
} from "../keys";
import { reloadRegistry } from "../runtime";

export const keysRoute = new Hono();

keysRoute.get("/api/settings/keys", (c) => {
  const registry = loadModelRegistry();
  return c.json({ keys: keyStatuses(registry), models: modelOptions(registry) });
});

keysRoute.post("/api/settings/keys", async (c) => {
  const { env, value } = (await c.req.json().catch(() => ({}))) as {
    env?: string;
    value?: string;
  };
  const name = env?.trim() ?? "";
  const registry = loadModelRegistry();
  // Allowlist: only env vars the model registry actually references. This
  // endpoint must never become an arbitrary-env write into the user's .env.
  if (!ENV_NAME_RE.test(name) || !allowedKeyEnvs(registry).has(name)) {
    return c.json({ error: `Unknown key env: ${name || "(missing)"}` }, 400);
  }
  const v = (value ?? "").trim();
  if (v && !validKeyValue(v)) {
    return c.json({ error: "Key value must be a single line under 4096 characters." }, 400);
  }
  if (v) upsertUserEnv(name, v);
  else removeUserEnv(name); // empty value = remove the line
  return c.json({ ok: true, keys: keyStatuses(registry), models: modelOptions(registry) });
});

keysRoute.post("/api/settings/gateway/discover", async (c) => {
  const { baseURL, apiKey, apiKeyEnv } = (await c.req.json().catch(() => ({}))) as {
    baseURL?: string;
    apiKey?: string;
    apiKeyEnv?: string;
  };
  const norm = normalizeGatewayBase(baseURL ?? "");
  if ("error" in norm) return c.json({ error: norm.error }, 400);
  // Credential precedence: an explicit key from the form, else an already-saved
  // key env (allowlisted names only — this must not read arbitrary env vars).
  const registry = loadModelRegistry();
  const envKey =
    apiKeyEnv && allowedKeyEnvs(registry).has(apiKeyEnv.trim())
      ? process.env[apiKeyEnv.trim()]?.trim()
      : undefined;
  const bearer = apiKey?.trim() || envKey;

  let res: Response;
  try {
    res = await fetch(`${norm.base}/models`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable";
    return c.json({ error: `Could not reach ${norm.base}/models (${why}).` }, 502);
  }
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " — check the API key" : "";
    return c.json({ error: `Gateway answered ${res.status}${hint}.` }, 502);
  }
  const payload = (await res.json().catch(() => undefined)) as unknown;
  const ids = parseDiscoveredModels(payload);
  if (!ids) {
    return c.json({ error: "Gateway response wasn't a recognizable model list." }, 502);
  }
  // Context windows: the gateway's own metadata when it allows it (LiteLLM's
  // /model/info — often admin-only, so this is best-effort), else a curated
  // per-family value, else a CONSERVATIVE fallback. The UI shows the value
  // (editable) so the user sees exactly what each model registers with.
  const windows = await fetchModelInfoWindows(norm.base, bearer);
  const known = new Set(registry.map((m) => m.id));
  return c.json({
    baseURL: norm.base,
    models: ids.map((id) => ({
      id,
      added: known.has(id),
      contextWindow: windows[id] ?? contextWindowForId(id),
    })),
  });
});

keysRoute.post("/api/settings/gateway/models", async (c) => {
  const { baseURL, apiKeyEnv, apiKey, models } = (await c.req.json().catch(() => ({}))) as {
    baseURL?: string;
    apiKeyEnv?: string;
    apiKey?: string;
    models?: GatewayModelInput[];
  };
  const norm = normalizeGatewayBase(baseURL ?? "");
  if ("error" in norm) return c.json({ error: norm.error }, 400);
  const envName = apiKeyEnv?.trim() ?? "";
  if (!ENV_NAME_RE.test(envName)) {
    return c.json({ error: "Key env name must look like LITELLM_API_KEY (A-Z, 0-9, _)." }, 400);
  }
  const list = Array.isArray(models)
    ? models.filter((m): m is GatewayModelInput => !!m && typeof m.id === "string")
    : [];
  if (!list.length) return c.json({ error: "No models selected." }, 400);

  const result = addGatewayModels(configDir(), {
    baseURL: norm.base,
    apiKeyEnv: envName,
    models: list,
  });
  if ("error" in result) return c.json({ error: result.error }, 400);
  // Persist the key alongside the models when the caller passed one, so the
  // flow "pick gateway → paste key → discover → add" leaves BOTH the models
  // and the key configured (no separate save). envName already passed
  // ENV_NAME_RE above; the value must be a safe single .env line. The value is
  // never logged nor echoed — the response below carries masked statuses only.
  const secret = apiKey?.trim();
  if (secret && validKeyValue(secret)) upsertUserEnv(envName, secret);
  // The engine runtime captures the registry at build time — rebuild it so the
  // new entries are usable on the very next turn, no worker restart.
  reloadRegistry();
  const registry = loadModelRegistry();
  return c.json({
    ok: true,
    added: result.added,
    keys: keyStatuses(registry),
    models: modelOptions(registry),
  });
});
