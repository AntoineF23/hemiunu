import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anyModelAvailable, loadModelRegistry, resolveDefaultModel } from "@hemiunu/engine";

const PLACEHOLDER_KEY = "sk-your-litellm-key-here";

/** Thinking configuration (SDK-era shape, kept for config compatibility). */
export type ThinkingConfig = { type: "enabled"; budgetTokens: number } | { type: "disabled" };

/** Hemiunu's per-user config + data dir (keys, conversations, folder-trust). */
export function configDir(): string {
  return process.env.HEMIUNU_CONFIG_DIR ?? join(homedir(), ".hemiunu");
}

/**
 * Write a file that holds credentials (API keys, GitHub / OAuth tokens) with
 * owner-only permissions (0600), so they aren't world-readable on a shared
 * machine. The `mode` option only applies when the file is created, so we also
 * `chmod` an existing file to repair permissions written by older versions.
 * Best-effort: chmod is a no-op on platforms that don't support POSIX modes.
 */
export function writeSecretFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // e.g. Windows / filesystems without POSIX permissions — ignore.
  }
}

/**
 * Where agent session bookkeeping lives — historically the Claude Agent SDK's
 * config dir (transcripts, subagent logs, large tool-result overflow), pinned
 * under Hemiunu's own config dir so everything Hemiunu lives in one place and a
 * user's real Claude Code (`~/.claude`) is left untouched. Still consulted by
 * the read sandbox's spilled-result escape hatch (iterate.ts spilledResult),
 * which allows reading `…/tool-results/…` files saved under this root.
 */
export function sdkConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(configDir(), "agent");
}

// Load .env from EVERY place it may live — the user's config dir (~/.hemiunu),
// Hemiunu's home (install/repo dir), and the cwd — in that precedence order.
// Earlier files (and the real shell environment) win: a var already set is never
// overwritten. This matters because per-user secrets (e.g. a GitHub token saved
// to ~/.hemiunu/.env) must coexist with a repo-local .env that holds other keys,
// rather than one file shadowing the other.
function loadEnvFiles(): void {
  const home = process.env.HEMIUNU_HOME ?? process.cwd();
  const files = [join(configDir(), ".env"), join(home, ".env"), join(process.cwd(), ".env")];
  const seen = new Set<string>();
  for (const path of files) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue; // blank line or comment
        const key = m[1];
        let val = m[2];
        if (/^"[\s\S]*"$/.test(val) || /^'[\s\S]*'$/.test(val)) val = val.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = val;
      }
    } catch (e) {
      // A missing file is fine (env may come from the shell), but a real read
      // failure on a secrets file (e.g. permission denied) should be visible.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `hemiunu: couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}
loadEnvFiles();

/**
 * Create or update a single var in the per-user `~/.hemiunu/.env`, preserving the
 * rest of the file (unrelated vars, comments, ordering), and apply it to this
 * process immediately. Used to remember credentials (e.g. a GitHub token or a
 * provider API key) so the user is asked only once. The file is written with
 * owner-only permissions — it holds secrets.
 */
export function upsertUserEnv(key: string, value: string): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".env");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  const next = lines.map((l) => (re.test(l) ? ((found = true), `${key}=${value}`) : l));
  if (!found) {
    // Drop the trailing blank the final-newline split leaves, so appends don't
    // accumulate empty lines between entries.
    while (next.length && !next[next.length - 1].trim()) next.pop();
    next.push(`${key}=${value}`);
  }
  writeSecretFile(path, `${next.join("\n").replace(/\n+$/, "")}\n`);
  process.env[key] = value;
  return path;
}

/**
 * Delete a single var from the per-user `~/.hemiunu/.env` (line surgery — every
 * other line, comments included, is preserved) and from this process's env, so
 * the removal takes effect without a restart. A missing file or key is a no-op.
 */
export function removeUserEnv(key: string): void {
  delete process.env[key];
  const path = join(configDir(), ".env");
  if (!existsSync(path)) return;
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const kept = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => !re.test(l));
  writeSecretFile(path, `${kept.join("\n").replace(/\n+$/, "")}\n`);
}

/** True once a real (non-placeholder) ANTHROPIC key is configured. NOT a
 *  readiness gate — first-run readiness is "any registry model usable"
 *  (engine's anyModelAvailable / registryReady); this only reports whether
 *  the Anthropic-specific env var is set. */
export function hasApiKey(): boolean {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim().length > 0 && k !== PLACEHOLDER_KEY;
}

export interface UserEnv {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Write the user's keys to `~/.hemiunu/.env` and apply them to this process so
 * the current run picks them up immediately. Used by the first-run setup flow.
 */
export function writeUserEnv(env: UserEnv): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const baseUrl = env.baseUrl?.trim();
  // No base URL = talk to Anthropic directly; only write the line if the user
  // set a gateway/proxy.
  const lines = [`ANTHROPIC_API_KEY=${env.apiKey}`];
  if (baseUrl) lines.unshift(`ANTHROPIC_BASE_URL=${baseUrl}`);
  if (env.model) lines.push(`HEMIUNU_MODEL=${env.model}`);
  const path = join(dir, ".env");
  writeSecretFile(path, `${lines.join("\n")}\n`);

  process.env.ANTHROPIC_API_KEY = env.apiKey;
  if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl;
  if (env.model) process.env.HEMIUNU_MODEL = env.model;
  return path;
}

export interface HemiunuConfig {
  /** Anthropic-compatible endpoint for the Claude brain. Undefined = Anthropic
   *  direct (api.anthropic.com); set it to a gateway/proxy (LiteLLM, etc.). */
  baseUrl: string | undefined;
  /** API key for the brain endpoint (your Anthropic key, or your gateway key). */
  apiKey: string;
  /** Main / synthesis model — the agent's brain (e.g. "claude-opus-4.8"). */
  model: string;
  /** Retrieval tier — the cheaper model the `researcher` subagent runs on.
   *  Defaults to Sonnet (~5× cheaper than Opus). NB: claude-haiku-4.5 is NOT
   *  usable here — the proxy/SDK always send an `effort` param it rejects. */
  researchModel: string;
  /** Thinking config. Set explicitly: the engine's default sends effort 'xhigh',
   *  which non-Opus models (e.g. Sonnet 4.6) reject. Disabled = cheaper & works
   *  everywhere; set HEMIUNU_THINKING_BUDGET (tokens) to enable reasoning. */
  thinking: ThinkingConfig;
}

export function loadConfig(): HemiunuConfig {
  // Undefined base URL = talk to Anthropic directly; set ANTHROPIC_BASE_URL to
  // route the brain through a gateway/proxy instead.
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

  // Models resolve through the registry: honor the persisted HEMIUNU_MODEL /
  // HEMIUNU_MODEL_RESEARCH when they name a USABLE entry, else fall to the
  // first available model — no provider's id is hardcoded as "the" default,
  // so running with only a LiteLLM / OpenAI / Gemini key (or a local Ollama)
  // works out of the box.
  const registry = loadModelRegistry();
  if (!anyModelAvailable(registry)) {
    // Readiness = at least one registry model is usable (any provider's key,
    // a gateway key, or a keyless local entry) — no env var is special-cased.
    throw new Error(
      "No usable model configured. Add any provider's API key in Settings (web app) or run `hemiunu` and complete first-run setup (terminal).",
    );
  }
  const model = resolveDefaultModel(registry, process.env, process.env.HEMIUNU_MODEL);
  const researchModel = resolveDefaultModel(
    registry,
    process.env,
    process.env.HEMIUNU_MODEL_RESEARCH,
    "research",
  );

  const budget = Number.parseInt(process.env.HEMIUNU_THINKING_BUDGET ?? "0", 10);
  const thinking: ThinkingConfig =
    budget > 0 ? { type: "enabled", budgetTokens: budget } : { type: "disabled" };

  return { baseUrl, apiKey, model, researchModel, thinking };
}

/**
 * Context window (tokens) for a model id. Claude Opus 4.6+, Sonnet 4.6+/5, and
 * Fable/Mythos serve a 1M-token window; Haiku and older Claude models 200k. A
 * `[1m]` suffix (how gateways/proxies name the long-context variant) always
 * selects 1M. Getting this wrong is expensive: the CLI auto-compacts at a
 * fraction of this value, and compacting a 1M model at 200k throws away 80% of
 * the usable window and drops the session's prompt cache with it.
 */
export function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("[1m]")) return 1_000_000;
  if (m.includes("claude") || m.includes("opus") || m.includes("sonnet") || m.includes("haiku")) {
    if (m.includes("haiku")) return 200_000;
    if (/opus-4[.-][678]/.test(m) || /sonnet-4[.-]6/.test(m)) return 1_000_000;
    if (/(sonnet|fable|mythos|opus)-5/.test(m)) return 1_000_000;
    return 200_000;
  }
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("grok") || m.includes("qwen")) return 256_000;
  return 128_000;
}
