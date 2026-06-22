// Bring-your-own model providers for the `ask_model` tool. Each is an
// OpenAI-compatible chat-completions endpoint; the user supplies the key for
// whichever providers they want (in ~/.hemiunu/.env). The Claude main loop is
// separate (it uses ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL).

export interface ProviderSpec {
  /** Default full chat-completions URL ("" = must come from urlEnv). */
  chatUrl: string;
  /** Env var holding the provider's API key. */
  keyEnv: string;
  /** Optional env var overriding the base URL (full chat URL is derived). */
  urlEnv?: string;
  label: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  // Your own gateway/proxy (LiteLLM, etc.), reusing the brain's endpoint+key if
  // it's OpenAI-compatible. Lets proxy users reach every model with one key.
  proxy: { chatUrl: "", keyEnv: "ANTHROPIC_API_KEY", urlEnv: "ANTHROPIC_BASE_URL", label: "your gateway/proxy" },
  openai: { chatUrl: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", urlEnv: "OPENAI_BASE_URL", label: "OpenAI" },
  google: { chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY", urlEnv: "GOOGLE_BASE_URL", label: "Google Gemini" },
  groq: { chatUrl: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", urlEnv: "GROQ_BASE_URL", label: "Groq" },
  xai: { chatUrl: "https://api.x.ai/v1/chat/completions", keyEnv: "XAI_API_KEY", urlEnv: "XAI_BASE_URL", label: "xAI Grok" },
  deepseek: { chatUrl: "https://api.deepseek.com/chat/completions", keyEnv: "DEEPSEEK_API_KEY", urlEnv: "DEEPSEEK_BASE_URL", label: "DeepSeek" },
  mistral: { chatUrl: "https://api.mistral.ai/v1/chat/completions", keyEnv: "MISTRAL_API_KEY", urlEnv: "MISTRAL_BASE_URL", label: "Mistral" },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

export interface ResolvedProvider {
  chatUrl: string;
  apiKey: string;
}

/** Resolve a provider's chat URL + key from env, or return why it can't be used. */
export function resolveProvider(name: string): ResolvedProvider | { error: string } {
  const spec = PROVIDERS[name];
  if (!spec) {
    return { error: `Unknown provider '${name}'. Known providers: ${PROVIDER_NAMES.join(", ")}.` };
  }
  const apiKey = process.env[spec.keyEnv];
  if (!apiKey || !apiKey.trim()) {
    return {
      error: `No API key for '${name}'. Add ${spec.keyEnv} to ~/.hemiunu/.env to use ${spec.label}.`,
    };
  }
  let chatUrl = spec.chatUrl;
  const override = spec.urlEnv ? process.env[spec.urlEnv] : undefined;
  if (override && override.trim()) {
    const base = override.replace(/\/$/, "");
    // The `proxy` base is a gateway root (…/v1 is appended); others are full bases.
    chatUrl = name === "proxy" ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  }
  if (!chatUrl) {
    return { error: `Provider '${name}' needs a base URL — set ${spec.urlEnv} in ~/.hemiunu/.env.` };
  }
  return { chatUrl, apiKey };
}
