import { configDir, upsertUserEnv } from "@hemiunu/agent-core";
import {
  addGatewayModels,
  anyModelAvailable,
  fetchModelInfoWindows,
  GATEWAY_PRESETS,
  keyEnvFor,
  keylessEndpointUp,
  loadModelRegistry,
  modelAvailable,
  normalizeGatewayBase,
  parseDiscoveredModels,
} from "@hemiunu/engine";
import { Box, render, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { join } from "node:path";
import { useState } from "react";
import { Banner } from "./Banner";
import { SAGE, SAND } from "./theme";

// --- first-run setup: provider-agnostic ---------------------------------
// Runs when NO registry model is usable (no provider/gateway key set, no
// local endpoint answering). The user picks WHICH provider they want — any
// key env the model registry references, a gateway (LiteLLM / OpenRouter /
// vLLM: base URL + key + discovery), or a keyless local Ollama — and only
// THAT credential is asked for. Keys land in ~/.hemiunu/.env via
// upsertUserEnv (line surgery, 0600); gateway models are registered in
// ~/.hemiunu/models.json, exactly like the web Settings flow.

/** Friendly names for the shipped registry's key envs (mirrors the web UI). */
const KEY_NAMES: Record<string, string> = {
  ANTHROPIC_API_KEY: "Anthropic",
  OPENAI_API_KEY: "OpenAI",
  GEMINI_API_KEY: "Google Gemini",
  GROQ_API_KEY: "Groq",
  XAI_API_KEY: "xAI",
  DEEPSEEK_API_KEY: "DeepSeek",
  MISTRAL_API_KEY: "Mistral",
  LITELLM_API_KEY: "LiteLLM gateway",
};

/** Providers first (most users), the rest in registry order. */
const KEY_ORDER = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

function keyName(env: string): string {
  return KEY_NAMES[env] ?? env.replace(/_API_KEY$/, "").replaceAll("_", " ");
}

interface ProviderOption {
  kind: "key" | "gateway" | "ollama";
  env?: string;
  label: string;
  hint: string;
}

/** One option per distinct key env the registry references + gateway + local. */
function providerOptions(): ProviderOption[] {
  const registry = loadModelRegistry();
  const envs: string[] = [];
  for (const entry of registry) {
    const env = keyEnvFor(entry);
    if (env && !envs.includes(env)) envs.push(env);
  }
  envs.sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a);
    const ib = KEY_ORDER.indexOf(b);
    return (ia === -1 ? KEY_ORDER.length : ia) - (ib === -1 ? KEY_ORDER.length : ib);
  });
  const keyless = [
    ...new Set(registry.filter((m) => !keyEnvFor(m) && m.baseURL).map((m) => m.baseURL as string)),
  ];
  return [
    ...envs.map<ProviderOption>((env) => {
      const models = registry.filter((m) => keyEnvFor(m) === env).map((m) => m.id);
      return {
        kind: "key",
        env,
        label: keyName(env),
        hint: `${env} — unlocks ${models.slice(0, 3).join(", ")}${models.length > 3 ? "…" : ""}`,
      };
    }),
    {
      kind: "gateway",
      label: "Other gateway (LiteLLM / OpenRouter / vLLM…)",
      hint: "base URL + key — its models are discovered and registered",
    },
    {
      kind: "ollama",
      label: "Local Ollama — no key needed",
      hint: keyless.length ? `checks ${keyless.join(", ")}` : "checks http://localhost:11434/v1",
    },
  ];
}

/** Registry baseURLs that need no key (local endpoints), for the Ollama probe. */
function keylessBases(): string[] {
  const bases = [
    ...new Set(
      loadModelRegistry()
        .filter((m) => !keyEnvFor(m) && m.baseURL)
        .map((m) => m.baseURL as string),
    ),
  ];
  return bases.length ? bases : ["http://localhost:11434/v1"];
}

type Step =
  | { id: "pick" }
  | { id: "key"; env: string; label: string }
  | { id: "gw-preset" }
  | { id: "gw-base"; presetId: string }
  | { id: "gw-key"; presetId: string; base: string }
  | { id: "gw-env"; base: string; apiKey: string }
  | { id: "busy"; text: string };

function Setup({ onDone }: { onDone: () => void }) {
  const options = useState(providerOptions)[0];
  const [step, setStep] = useState<Step>({ id: "pick" });
  const [sel, setSel] = useState(0);
  // Selection cursor for the gateway-preset list (its own step/list).
  const [presetSel, setPresetSel] = useState(0);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** A key env now holds a value → confirm which models that unlocked. */
  const finishWithKey = (env: string) => {
    const unlocked = loadModelRegistry()
      .filter((m) => keyEnvFor(m) === env && modelAvailable(m))
      .map((m) => m.id);
    setNotice(`✓ ${keyName(env)} connected — ${unlocked.length} model(s) ready.`);
    onDone();
  };

  const probeOllama = async () => {
    setStep({ id: "busy", text: "Checking the local endpoint…" });
    for (const base of keylessBases()) {
      if (await keylessEndpointUp(base)) {
        setNotice(`✓ Local endpoint answering at ${base} — no key needed.`);
        onDone();
        return;
      }
    }
    setError(
      `Nothing is answering at ${keylessBases().join(", ")} — start Ollama (\`ollama serve\`) and pick again, or choose a provider.`,
    );
    setStep({ id: "pick" });
  };

  const discoverGateway = async (
    base: string,
    apiKey: string,
    envName: string,
    presetId: string,
  ) => {
    setStep({ id: "busy", text: `Discovering models at ${base}…` });
    let ids: string[] | undefined;
    try {
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? " — check the API key" : "";
        setError(`Gateway answered ${res.status}${hint}.`);
        setStep({ id: "gw-base", presetId });
        return;
      }
      ids = parseDiscoveredModels((await res.json().catch(() => undefined)) as unknown);
    } catch {
      setError(`Could not reach ${base}/models.`);
      setStep({ id: "gw-base", presetId });
      return;
    }
    if (!ids?.length) {
      setError("The gateway answered, but listed no recognizable models.");
      setStep({ id: "gw-base", presetId });
      return;
    }
    // Context windows: the gateway's own metadata when it allows it (LiteLLM's
    // /model/info is often admin-only — best-effort), else addGatewayModels
    // falls back to the curated map / conservative default per id.
    const windows = await fetchModelInfoWindows(base, apiKey || undefined);
    const added = addGatewayModels(configDir(), {
      baseURL: base,
      apiKeyEnv: envName,
      models: ids.map((id) => ({ id, ...(windows[id] ? { contextWindow: windows[id] } : {}) })),
    });
    if ("error" in added) {
      setError(added.error);
      setStep({ id: "gw-base", presetId });
      return;
    }
    if (apiKey) upsertUserEnv(envName, apiKey);
    if (!anyModelAvailable(loadModelRegistry())) {
      // Only possible when no key was given AND the env is still unset.
      setError(`Models registered, but ${envName} is empty — enter the gateway key.`);
      setStep({ id: "gw-key", presetId, base });
      return;
    }
    setNotice(`✓ Registered ${added.added.length} model(s) from ${base}.`);
    onDone();
  };

  const submit = (raw: string) => {
    const v = raw.trim();
    setError(null);
    setValue("");
    switch (step.id) {
      case "key": {
        if (!v) return; // a key can't be skipped — Esc-like escape is ctrl-c
        upsertUserEnv(step.env, v);
        finishWithKey(step.env);
        return;
      }
      case "gw-base": {
        const norm = normalizeGatewayBase(v);
        if ("error" in norm) {
          setError(norm.error);
          return;
        }
        setStep({ id: "gw-key", presetId: step.presetId, base: norm.base });
        return;
      }
      case "gw-key": {
        // A concrete preset fixes the env name — skip the env prompt and
        // discover straight away. Only "custom" asks for a free-text env.
        const p = GATEWAY_PRESETS.find((x) => x.id === step.presetId);
        if (p && p.id !== "custom") {
          void discoverGateway(step.base, v, p.apiKeyEnv, p.id);
          return;
        }
        setStep({ id: "gw-env", base: step.base, apiKey: v });
        return;
      }
      case "gw-env": {
        const envName = (v || "GATEWAY_API_KEY").toUpperCase().replaceAll(" ", "_");
        if (!ENV_NAME_RE.test(envName)) {
          setError("Key env must look like LITELLM_API_KEY (A-Z, 0-9, _).");
          return;
        }
        void discoverGateway(step.base, step.apiKey, envName, "custom");
        return;
      }
    }
  };

  useInput(
    (_input, key) => {
      const n = options.length;
      if (key.upArrow) setSel((s) => (s - 1 + n) % n);
      else if (key.downArrow) setSel((s) => (s + 1) % n);
      else if (key.return) {
        const o = options[sel];
        setError(null);
        if (o.kind === "key" && o.env) setStep({ id: "key", env: o.env, label: o.label });
        else if (o.kind === "gateway") {
          setPresetSel(0);
          setStep({ id: "gw-preset" });
        } else void probeOllama();
      }
    },
    { isActive: step.id === "pick" },
  );

  // Gateway-preset picker: pick a provider (prefilling its base URL where the
  // host is fixed) or Custom to type an env name + URL. Same list as the web
  // Settings dropdown — GATEWAY_PRESETS from the engine.
  useInput(
    (_input, key) => {
      const n = GATEWAY_PRESETS.length;
      if (key.upArrow) setPresetSel((s) => (s - 1 + n) % n);
      else if (key.downArrow) setPresetSel((s) => (s + 1) % n);
      else if (key.return) {
        const p = GATEWAY_PRESETS[presetSel];
        setError(null);
        setValue(p.defaultBaseURL ?? ""); // prefill the base-URL prompt
        setStep({ id: "gw-base", presetId: p.id });
      }
    },
    { isActive: step.id === "gw-preset" },
  );

  const prompt = (label: string, hint: string, mask?: boolean) => (
    <>
      <Box marginTop={1} marginLeft={3}>
        <Text>
          <Text color={SAGE} bold>{`${label}: `}</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={submit}
            mask={mask ? "•" : undefined}
          />
        </Text>
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>{`${hint}  ·  saved to ${join(configDir(), ".env")}`}</Text>
      </Box>
    </>
  );

  return (
    <Box flexDirection="column">
      <Banner />
      <Box marginTop={1} marginLeft={3} flexDirection="column">
        <Text color={SAND} bold>
          Welcome to Hemiunu — connect a model provider to get started.
        </Text>
        <Text dimColor>Any provider works: bring one API key, a gateway, or a local Ollama.</Text>
      </Box>

      {step.id === "pick" && (
        <>
          <Box marginTop={1} marginLeft={3} flexDirection="column">
            {options.map((o, i) => (
              <Text key={o.label} color={i === sel ? SAGE : undefined} dimColor={i !== sel}>
                {i === sel ? "❯ " : "  "}
                {o.label}
                {i === sel ? `  —  ${o.hint}` : ""}
              </Text>
            ))}
          </Box>
          <Box marginLeft={3} marginTop={1}>
            <Text dimColor>{"↑/↓ select · Enter to choose"}</Text>
          </Box>
        </>
      )}

      {step.id === "key" &&
        prompt(`${step.label} API key`, "paste the key — stored only here", true)}
      {step.id === "gw-preset" && (
        <>
          <Box marginTop={1} marginLeft={3} flexDirection="column">
            {GATEWAY_PRESETS.map((p, i) => (
              <Text
                key={p.id}
                color={i === presetSel ? SAGE : undefined}
                dimColor={i !== presetSel}
              >
                {i === presetSel ? "❯ " : "  "}
                {p.label}
                {i === presetSel ? `  —  ${p.defaultBaseURL ?? p.docsHint ?? p.apiKeyEnv}` : ""}
              </Text>
            ))}
          </Box>
          <Box marginLeft={3} marginTop={1}>
            <Text dimColor>{"↑/↓ select gateway · Enter to choose"}</Text>
          </Box>
        </>
      )}
      {step.id === "gw-base" &&
        prompt(
          "Gateway base URL",
          GATEWAY_PRESETS.find((p) => p.id === step.presetId)?.docsHint ??
            "e.g. https://models.example.co (/v1 optional)",
        )}
      {step.id === "gw-key" &&
        prompt("Gateway API key", "Enter to skip if the endpoint needs none", true)}
      {step.id === "gw-env" &&
        prompt("Key env name", "Enter for GATEWAY_API_KEY — how the key is named in .env")}
      {step.id === "busy" && (
        <Box marginTop={1} marginLeft={3}>
          <Text color={SAGE}>{step.text}</Text>
        </Box>
      )}

      {error && (
        <Box marginLeft={3} marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
      {notice && (
        <Box marginLeft={3} marginTop={1}>
          <Text color={SAGE}>{notice}</Text>
        </Box>
      )}
    </Box>
  );
}

export function runSetup(): Promise<void> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <Setup
        onDone={() => {
          // Let the confirmation line paint before the app takes over.
          setTimeout(() => {
            unmount();
            resolve();
          }, 60);
        }}
      />,
    );
  });
}
