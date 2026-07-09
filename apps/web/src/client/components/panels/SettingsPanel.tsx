import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sendJSON } from "@/lib/api";
import {
  ADD_KEYS_VALUE,
  API_KEYS_SECTION,
  KEY_MISSING_MARK,
  missingKeyFor,
  pickableModels,
} from "../../model-picker";
import {
  MODELS,
  type GatewayPreset,
  type KeyStatus,
  type ModelOption,
  type Settings,
} from "../../useSettings";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings | null;
  onChanged: () => void;
  onModelChange: (id: string) => void;
  onResearchModelChange: (id: string) => void;
  /** Scroll to + focus this key env's input (set by the needs-key error card
   *  and every picker's "＋ Add API keys…" item). API_KEYS_SECTION ("*") means
   *  the whole API-keys section rather than one env's input. */
  focusKeyEnv?: string | null;
}

/** Friendly display names for the key envs the shipped registry references. */
const KEY_NAMES: Record<string, string> = {
  ANTHROPIC_API_KEY: "Anthropic",
  OPENAI_API_KEY: "OpenAI",
  GEMINI_API_KEY: "Google Gemini",
  GROQ_API_KEY: "Groq",
  XAI_API_KEY: "xAI",
  DEEPSEEK_API_KEY: "DeepSeek",
  MISTRAL_API_KEY: "Mistral",
  LITELLM_API_KEY: "LiteLLM gateway",
  OPENROUTER_API_KEY: "OpenRouter gateway",
  TOGETHER_API_KEY: "Together AI gateway",
  VLLM_API_KEY: "vLLM gateway",
  GATEWAY_API_KEY: "OpenAI-compatible gateway",
};

/** Providers first (most users), gateways after, else registry order. */
const KEY_ORDER = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

export function keyName(env: string): string {
  return KEY_NAMES[env] ?? env.replace(/_API_KEY$/, "").replaceAll("_", " ");
}

/** Key rows in display order: the big providers first, then registry order.
 *  Shared with the first-run setup card so both surfaces read the same. */
export function sortedKeyStatuses(keys: KeyStatus[]): KeyStatus[] {
  return [...keys].sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a.env);
    const ib = KEY_ORDER.indexOf(b.env);
    return (ia === -1 ? KEY_ORDER.length : ia) - (ib === -1 ? KEY_ORDER.length : ib);
  });
}

function ctxLabel(tokens?: number): string | null {
  if (!tokens) return null;
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M ctx` : `${Math.round(tokens / 1000)}k ctx`;
}

/** One model picker over the engine registry. Only AVAILABLE models are
 *  listed (missing key = hidden); the list always ends with "＋ Add API keys…",
 *  which jumps to the API-keys section instead of changing the selection. The
 *  current selection stays visible in the closed trigger even when its key
 *  disappears — marked "(key missing)", never silently switched. */
function ModelSelect({
  value,
  models,
  onChange,
  onAddKeys,
}: {
  value: string | undefined;
  models: ModelOption[];
  onChange: (id: string) => void;
  /** Open the API-keys section (optionally on one env's input). */
  onAddKeys: (env: string) => void;
}) {
  const pickable = pickableModels(models);
  const missingEnv = missingKeyFor(value, models);
  return (
    <Select
      value={value}
      onValueChange={(id) => {
        // The settings-link item is an action, not a model: the controlled
        // `value` keeps the previous selection in place.
        if (id === ADD_KEYS_VALUE) onAddKeys(missingEnv ?? API_KEYS_SECTION);
        else onChange(id);
      }}
    >
      <SelectTrigger>
        <SelectValue
          placeholder={pickable.length ? "Select a model" : "No models yet — add an API key"}
        >
          {value ? (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate" title={models.find((m) => m.id === value)?.label ?? value}>
                {models.find((m) => m.id === value)?.label ?? value}
              </span>
              {missingEnv !== null && (
                <span className="shrink-0 text-xs text-sun">{KEY_MISSING_MARK}</span>
              )}
            </span>
          ) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {pickable.map((m) => {
          const ctx = ctxLabel(m.contextWindow);
          return (
            <SelectItem key={m.id} value={m.id}>
              {/* Long gateway ids: truncate instead of stretching the menu. */}
              <span className="flex min-w-0 max-w-72 items-baseline gap-2">
                <span className="truncate" title={m.label}>
                  {m.label}
                </span>
                <span className="shrink-0 text-xs text-ink-4">{m.provider}</span>
                {ctx && <span className="shrink-0 text-xs text-ink-4">{ctx}</span>}
              </span>
            </SelectItem>
          );
        })}
        {!pickable.length && (
          <p className="px-8 py-1.5 text-xs text-ink-4">
            No models available — add an API key to unlock them.
          </p>
        )}
        <div aria-hidden className="my-1 h-px bg-border" />
        <SelectItem value={ADD_KEYS_VALUE} className="text-sun">
          <span className="flex items-center gap-1.5">
            <Plus className="size-3.5" />
            Add API keys…
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/** One provider/gateway key row: status dot, masked tail, password input,
 *  Save / Remove. Values are write-only — the server never returns them.
 *  Shared with the first-run setup card (which needs no focus steering, so
 *  inputRef/highlighted are optional). */
export function KeyRow({
  status,
  inputRef,
  highlighted = false,
  onChanged,
}: {
  status: KeyStatus;
  inputRef?: (el: HTMLInputElement | null) => void;
  highlighted?: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const submit = async (v: string) => {
    setBusy(true);
    setFlash(null);
    try {
      await sendJSON("/api/settings/keys", { env: status.env, value: v });
      setValue("");
      setFlash(v ? "Saved." : "Removed.");
      onChanged();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Could not save the key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-1.5 rounded-md border px-3 py-2.5 transition-colors ${
        highlighted ? "border-sun/50 bg-sun-soft" : "border-border"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`size-2 shrink-0 rounded-full ${status.set ? "bg-oasis" : "bg-ink-4"}`}
          title={status.set ? "key configured" : "key missing"}
        />
        <span className="shrink-0 text-sm text-ink">{keyName(status.env)}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-4" title={status.env}>
          {status.env}
        </span>
        {status.set && status.maskedTail && (
          <span className="ml-auto shrink-0 font-mono text-xs text-ink-3">{status.maskedTail}</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          type="password"
          autoComplete="off"
          placeholder={status.set ? "•••• replace key" : "paste your key"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) void submit(value.trim());
          }}
        />
        <Button onClick={() => void submit(value.trim())} disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
        {status.set && (
          <Button variant="ghost" onClick={() => void submit("")} disabled={busy}>
            Remove
          </Button>
        )}
      </div>
      <p className="break-words text-xs text-ink-4">
        Unlocks: {status.models.slice(0, 4).join(", ")}
        {status.models.length > 4 ? ` +${status.models.length - 4} more` : ""}
        {flash ? ` — ${flash}` : ""}
      </p>
    </div>
  );
}

/** Gateway (LiteLLM, OpenRouter, vLLM…): base URL + key → Test & discover →
 *  pick from the discovered model list → Add selected registers them in
 *  ~/.hemiunu/models.json and saves the key under the chosen env. Shared with
 *  the first-run setup card. */
export function GatewaySection({
  settings,
  onChanged,
}: {
  settings: Settings;
  onChanged: () => void;
}) {
  const presets: GatewayPreset[] = settings.gatewayPresets ?? [];
  const [base, setBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  // Selected gateway provider. LiteLLM ships first, so it stays the default —
  // preserving the prior LITELLM_API_KEY default.
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "litellm");
  // Free-text env name for the "Custom / other OpenAI-compatible" escape hatch,
  // so ANY gateway with an arbitrary env name still works (the old behavior).
  const [customEnv, setCustomEnv] = useState(
    presets.find((p) => p.id === "custom")?.apiKeyEnv ?? "GATEWAY_API_KEY",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Discovery result: the normalized base the server probed + its model list.
  // contextWindow is what each model will REGISTER with (gateway metadata when
  // available, else a curated/conservative default) — editable per row.
  const [found, setFound] = useState<{
    base: string;
    models: { id: string; added: boolean; contextWindow: number }[];
  }>();
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  const isCustom = preset?.id === "custom";
  // The env the key persists under: a preset's fixed env, or the free-text
  // name the user typed for the custom escape hatch.
  const envName = isCustom ? customEnv : (preset?.apiKeyEnv ?? "GATEWAY_API_KEY");
  const envOk = /^[A-Z][A-Z0-9_]{2,63}$/.test(envName);

  // Picking a provider prefills its base URL where the host is fixed (still
  // editable); self-hosted presets leave whatever the user has typed.
  const choosePreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (p?.defaultBaseURL) setBase(p.defaultBaseURL);
  };

  const discover = async () => {
    setBusy(true);
    setError(null);
    setFlash(null);
    setFound(undefined);
    try {
      const res = await sendJSON<{
        baseURL: string;
        models: { id: string; added: boolean; contextWindow: number }[];
      }>("/api/settings/gateway/discover", {
        baseURL: base.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : { apiKeyEnv: envName }),
      });
      setFound({ base: res.baseURL, models: res.models });
      setChecked(new Set(res.models.filter((m) => !m.added).map((m) => m.id)));
      if (!res.models.length) setError("The gateway answered, but listed no models.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  };

  const addSelected = async () => {
    if (!found || checked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Register the models AND persist the key in one call: the server saves
      // the key under `apiKeyEnv` after writing models.json, so a brand-new
      // gateway env is configured end to end without a separate save.
      const res = await sendJSON<{ added: string[] }>("/api/settings/gateway/models", {
        baseURL: found.base,
        apiKeyEnv: envName,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        // Register each model with the (possibly user-edited) context window
        // shown in the list — the server treats a missing/invalid value as
        // "use the conservative default".
        models: found.models
          .filter((m) => checked.has(m.id))
          .map((m) => ({ id: m.id, contextWindow: m.contextWindow })),
      });
      if (apiKey.trim()) setApiKey("");
      setFound({
        base: found.base,
        models: found.models.map((m) => (checked.has(m.id) ? { ...m, added: true } : m)),
      });
      setChecked(new Set());
      setFlash(
        `Added ${res.added.length} model${res.added.length === 1 ? "" : "s"} — they're now in the pickers above.`,
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the models.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="gw-provider">Gateway</Label>
      <Select value={preset?.id ?? presetId} onValueChange={choosePreset}>
        <SelectTrigger id="gw-provider">
          <SelectValue placeholder="Choose a gateway" />
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <span className="flex min-w-0 max-w-72 items-baseline gap-2">
                <span className="truncate">{p.label}</span>
                <span className="shrink-0 font-mono text-xs text-ink-4">{p.apiKeyEnv}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        id="gw-base"
        placeholder={
          preset?.defaultBaseURL ?? "https://models.example.co  (base URL, /v1 optional)"
        }
        value={base}
        onChange={(e) => setBase(e.target.value)}
      />
      {preset?.docsHint && <p className="text-xs text-ink-4">Base URL: {preset.docsHint}.</p>}
      <Input
        type="password"
        autoComplete="off"
        placeholder={`${keyName(envName)} API key (optional if already saved)`}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      {isCustom && (
        <Input
          className="font-mono text-xs"
          placeholder="GATEWAY_API_KEY"
          value={customEnv}
          onChange={(e) => setCustomEnv(e.target.value.toUpperCase().replaceAll(" ", "_"))}
          title="The env var name the key is stored under in ~/.hemiunu/.env"
        />
      )}
      <div className="flex items-center gap-2">
        <Button onClick={() => void discover()} disabled={busy || !base.trim() || !envOk}>
          {busy && !found ? <Loader2 className="size-4 animate-spin" /> : "Test & discover"}
        </Button>
        {isCustom && !envOk && (
          <p className="text-xs text-ink-4">Key env must look like LITELLM_API_KEY.</p>
        )}
      </div>

      {found && found.models.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md border border-border p-2">
          <div className="max-h-56 overflow-y-auto">
            {found.models.map((m) => (
              <label
                key={m.id}
                className={`flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-raised ${
                  m.added ? "cursor-default opacity-60" : ""
                }`}
              >
                <input
                  type="checkbox"
                  className="shrink-0 accent-current"
                  disabled={m.added}
                  checked={!m.added && checked.has(m.id)}
                  onChange={(e) => {
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      return next;
                    });
                  }}
                />
                {/* Gateway ids can be very long (org/model@version) — truncate,
                    full id on hover. */}
                <span className="min-w-0 truncate font-mono text-[12.5px] text-ink-2" title={m.id}>
                  {m.id}
                </span>
                {m.added ? (
                  <span className="ml-auto shrink-0 text-xs text-ink-4">already added</span>
                ) : (
                  // The context window this model will register with —
                  // gateway metadata when the proxy exposes it, else a
                  // curated/conservative default. Editable: the user knows
                  // their deployment better than our fallback does.
                  <input
                    type="number"
                    min={1024}
                    step={1024}
                    className="ml-auto w-24 shrink-0 rounded border border-border bg-transparent px-1 py-0.5 text-right font-mono text-[11px] text-ink-3"
                    title="Context window (tokens) this model registers with"
                    value={m.contextWindow}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setFound((prev) =>
                        prev
                          ? {
                              ...prev,
                              models: prev.models.map((x) =>
                                x.id === m.id ? { ...x, contextWindow: v } : x,
                              ),
                            }
                          : prev,
                      );
                    }}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={() => void addSelected()} disabled={busy || !checked.size}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                `Add selected (${checked.size})`
              )}
            </Button>
            <span className="min-w-0 break-all text-xs text-ink-4">
              {found.base} · {found.models.length} models
            </span>
          </div>
        </div>
      )}

      {error && <p className="break-words text-xs text-destructive">{error}</p>}
      {flash && <p className="break-words text-xs text-ink-3">{flash}</p>}
      <p className="text-xs text-ink-3">
        One endpoint, many models: the {preset?.label ?? "gateway"}&rsquo;s models are registered in
        ~/.hemiunu/models.json and share the key saved under{" "}
        <span className="font-mono">{envName}</span>.
      </p>
    </div>
  );
}

export function SettingsPanel({
  settings,
  onChanged,
  onModelChange,
  onResearchModelChange,
  focusKeyEnv,
}: SettingsPanelProps) {
  const [cfToken, setCfToken] = useState("");
  const [cfAccount, setCfAccount] = useState("");
  const [cfBusy, setCfBusy] = useState(false);
  const [cfFlash, setCfFlash] = useState<string | null>(null);

  // API-key focus steering: a picker's "＋ Add API keys…" item (or the
  // needs-key error card in the thread) lands the user on the API-keys
  // section — on one env's input when we know which key is missing
  // (briefly highlighted), else on the section's first input.
  const keyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const keysSectionRef = useRef<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const focusKey = (env: string) => {
    const section = env === API_KEYS_SECTION;
    const el = section ? Object.values(keyRefs.current).find(Boolean) : keyRefs.current[env];
    (section ? (keysSectionRef.current ?? el) : el)?.scrollIntoView({
      block: section ? "start" : "center",
      behavior: "smooth",
    });
    el?.focus({ preventScroll: true });
    if (section) return;
    setHighlight(env);
    window.setTimeout(() => setHighlight((h) => (h === env ? null : h)), 2000);
  };
  useEffect(() => {
    if (focusKeyEnv && settings) focusKey(focusKeyEnv);
    // Re-run when the target env changes or once settings (the rows) exist.
  }, [focusKeyEnv, settings]);

  const saveCloudflare = async () => {
    if (!cfToken.trim()) return;
    setCfBusy(true);
    setCfFlash(null);
    try {
      await sendJSON("/api/settings/cloudflare", {
        token: cfToken.trim(),
        ...(cfAccount.trim() ? { accountId: cfAccount.trim() } : {}),
      });
      setCfToken("");
      setCfAccount("");
      setCfFlash("Cloudflare connected.");
      onChanged();
    } catch (e) {
      setCfFlash(e instanceof Error ? e.message : "Could not connect Cloudflare.");
    } finally {
      setCfBusy(false);
    }
  };

  const keys = sortedKeyStatuses(settings?.keys ?? []);

  return (
    <>
      <SheetHeader>
        <SheetTitle>Settings</SheetTitle>
        <SheetDescription>Models, API keys, gateways, and connection status.</SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-5 py-1">
        {/* Models — only available registry entries; "＋ Add API keys…" below */}
        <div className="flex flex-col gap-2">
          <Label>Brain model</Label>
          <ModelSelect
            value={settings?.model}
            models={settings?.models ?? MODELS}
            onChange={onModelChange}
            onAddKeys={focusKey}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Research model</Label>
          <ModelSelect
            value={settings?.researchModel}
            models={settings?.models ?? MODELS}
            onChange={onResearchModelChange}
            onAddKeys={focusKey}
          />
          <p className="text-xs text-ink-3">
            Used by the researcher subagent for retrieval-heavy work — a cheaper, faster tier than
            the brain model.
          </p>
        </div>

        {/* API keys — one row per provider/gateway key env */}
        <div ref={keysSectionRef} className="flex flex-col gap-2">
          <Label>API keys</Label>
          {keys.map((k) => (
            <KeyRow
              key={k.env}
              status={k}
              highlighted={highlight === k.env}
              inputRef={(el) => {
                keyRefs.current[k.env] = el;
              }}
              onChanged={onChanged}
            />
          ))}
          {!keys.length && (
            <p className="text-xs text-ink-4">Loading key status from the local worker…</p>
          )}
          <p className="text-xs text-ink-3">
            Keys are stored in ~/.hemiunu/.env on this computer only — they never leave the machine,
            and the app only ever shows the last four characters.
          </p>
        </div>

        {/* Gateway discovery */}
        {settings && <GatewaySection settings={settings} onChanged={onChanged} />}

        {/* Cloudflare (prototype sharing) */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="cf-token">
            Cloudflare token {settings?.cloudflare && <Badge>connected</Badge>}
          </Label>
          <div className="flex gap-2">
            <Input
              id="cf-token"
              type="password"
              placeholder={settings?.cloudflare ? "•••• replace token" : "Pages: Edit API token"}
              value={cfToken}
              onChange={(e) => setCfToken(e.target.value)}
            />
            <Button onClick={saveCloudflare} disabled={cfBusy || !cfToken.trim()}>
              {cfBusy ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
            </Button>
          </div>
          <Input
            id="cf-account"
            placeholder="Account ID (optional — only if the token lookup fails)"
            value={cfAccount}
            onChange={(e) => setCfAccount(e.target.value)}
          />
          <p className="text-xs text-ink-3">
            Lets the agent deploy prototypes to a shareable URL.{" "}
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Create a token
            </a>{" "}
            with “Cloudflare Pages: Edit” (or the “Edit Cloudflare Workers” template).
          </p>
          {cfFlash && <p className="text-xs text-ink-3">{cfFlash}</p>}
        </div>

        {/* Status */}
        <div className="flex flex-col gap-2">
          <Label>Connections</Label>
          <div className="flex flex-wrap gap-2">
            <StatusChip label="GitHub" on={!!settings?.github} />
            <StatusChip label="Cloudflare" on={!!settings?.cloudflare} />
          </div>
          {settings?.mcpServers?.length ? (
            <div className="mt-1">
              <p className="mb-1.5 text-xs text-ink-3">MCP servers</p>
              <div className="flex flex-wrap gap-1.5">
                {settings.mcpServers.map((s) => (
                  <Badge key={s} variant="secondary">
                    {s}
                  </Badge>
                ))}
                {settings.mcpSkipped?.map((s) => (
                  <Badge key={s.name} variant="outline" title={s.reason || "skipped"}>
                    {s.name} (off)
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function StatusChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-ink-2">
      {on ? <Check className="size-3.5 text-oasis" /> : <X className="size-3.5 text-ink-4" />}
      {label}
    </span>
  );
}
