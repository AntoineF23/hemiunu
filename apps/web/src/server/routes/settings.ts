// Settings for the web UI. GET mirrors the CLI's /settings readout (booleans
// only — secrets never leave the worker). POST endpoints let the UI change the
// brain model and connections, persisting them to ~/.hemiunu/.env. API keys
// are managed by routes/keys.ts (provider-agnostic — any registry key env).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  configDir,
  currentGithubLogin,
  currentTeam,
  discardWorkspace,
  githubStatus,
  listTeams,
  removeTeam,
  repoExists,
  resolveGithubToken,
  upsertUserEnv,
  cloudflareConfigured,
  fetchCloudflareAccountId,
} from "@hemiunu/agent-core";
import {
  keyEnvFor,
  keylessEndpointUp,
  loadModelRegistry,
  modelAvailable,
  registryReady,
  resolveDefaultModel,
  type ModelEntry,
  type ModelTag,
} from "@hemiunu/engine";
import { GATEWAY_PRESETS, keyStatuses, modelOptions } from "../keys";
import { bootRuntime, setRuntimeModel, setRuntimeResearchModel } from "../runtime";

export const settingsRoute = new Hono();

/** A friendly name for the greeting: git user.name, else the first line of user.md.
 *  Cached after the first call — it shells out to git, and the name doesn't
 *  change within a worker's lifetime, so recomputing per GET blocked the
 *  single-threaded worker on a subprocess for no benefit. */
let cachedUserName: string | null | undefined;
function userName(): string | null {
  if (cachedUserName !== undefined) return cachedUserName;
  cachedUserName = computeUserName();
  return cachedUserName;
}
function computeUserName(): string | null {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (name) return name.split(/\s+/)[0];
  } catch {
    /* no git / not set */
  }
  try {
    const userMd = join(configDir(), "user.md");
    if (existsSync(userMd)) {
      const first = readFileSync(userMd, "utf8")
        .split(/\r?\n/)
        .find((l) => l.trim());
      const m = first?.match(/(?:name is|i am|i'm|called)\s+([A-Z][a-zA-Z'-]+)/i);
      if (m) return m[1];
    }
  } catch {
    /* unreadable */
  }
  return null;
}

const TEAM_RECHECK_MS = 60_000;
const teamLastChecked = new Map<string, number>();
function shouldRecheckTeam(team: string): boolean {
  const last = teamLastChecked.get(team) ?? 0;
  const now = Date.now();
  if (now - last < TEAM_RECHECK_MS) return false;
  teamLastChecked.set(team, now);
  return true;
}

/**
 * Probe keyless endpoints at most once per PROBE_TTL_MS per base URL — the
 * settings GET runs often (panel opens, turn ends) and shouldn't hammer a
 * local endpoint, nor block repeatedly on a dead one.
 */
const PROBE_TTL_MS = 10_000;
const probeCache = new Map<string, { at: number; up: boolean }>();
async function cachedProbe(base: string): Promise<boolean> {
  const hit = probeCache.get(base);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.up;
  const up = await keylessEndpointUp(base);
  probeCache.set(base, { at: Date.now(), up });
  return up;
}

/**
 * The model id the runtime should be on: the current pick when it's still
 * usable — a keyed entry whose key is set, or a keyless entry whose endpoint
 * ANSWERS (a keyless id is otherwise "available" by the pure rule even when
 * nothing is listening) — else the resolved default (persisted env preference
 * first, then the first available registry entry). This is how the first-run
 * gate clears INTO a working model: the moment a key lands, the next settings
 * read heals an unusable selection (e.g. the shipped Claude default with no
 * Anthropic key, or a dead local Ollama) to something that can actually answer.
 */
async function healedModel(
  current: string,
  registry: ModelEntry[],
  preferred: string | undefined,
  tag: ModelTag,
): Promise<string> {
  const entry = registry.find((m) => m.id === current);
  if (entry && modelAvailable(entry)) {
    if (keyEnvFor(entry)) return current;
    if (entry.baseURL && (await cachedProbe(entry.baseURL))) return current;
  }
  return resolveDefaultModel(registry, process.env, preferred, tag);
}

settingsRoute.get("/api/settings", async (c) => {
  const rt = bootRuntime();
  const status = githubStatus();
  // The active GitHub login powers the avatar (github.com/<login>.png) and the
  // profile switcher; currentGithubLogin() also covers an env/`gh` token.
  const githubLogin = (await currentGithubLogin()) ?? null;
  const token = resolveGithubToken();
  // Self-heal: if the active team's repo was deleted on GitHub, drop it so the
  // footer doesn't keep showing a team that no longer exists. repoExists only
  // reports false on a confirmed 404/403/401 (never on a network error/5xx), so
  // we won't drop a live team just because GitHub is briefly unreachable.
  // Rate-limited to once per minute per team: the UI refetches settings often
  // (panel opens, team switches), and each uncached check is a live GitHub
  // round-trip on the worker's request path.
  let team = currentTeam();
  if (team && token && shouldRecheckTeam(team) && !(await repoExists(token, team))) {
    removeTeam(team);
    discardWorkspace(team, "team repo no longer on GitHub"); // clean its tmp workspace (binned)
    team = currentTeam();
  }
  // The model registry (shipped defaults merged with ~/.hemiunu/models.json),
  // reloaded per GET so a models.json edit shows up on the next panel open.
  const registry = loadModelRegistry();
  // Self-heal the active models: if the current selection became unusable but
  // another model is available, switch the runtime to the resolved default so
  // the composer never points at a model that would fail at turn start.
  const model = await healedModel(rt.model, registry, process.env.HEMIUNU_MODEL, "synthesis");
  if (model !== rt.model) setRuntimeModel(model);
  const researchModel = await healedModel(
    rt.researchModel,
    registry,
    process.env.HEMIUNU_MODEL_RESEARCH,
    "research",
  );
  if (researchModel !== rt.researchModel) setRuntimeResearchModel(researchModel);
  return c.json({
    model,
    researchModel,
    // Each option carries availability (is its key env set?) so the pickers can
    // hide models that would fail at turn start, plus context window + the
    // key env to point at. keys = one status per provider/gateway key env —
    // set/masked-tail only, never a value.
    models: modelOptions(registry),
    keys: keyStatuses(registry),
    // The gateway presets the Settings dropdown offers. Sent from the server
    // because the client is a plain SPA that must never import the Node-only
    // engine — this keeps GATEWAY_PRESETS the single source of truth.
    gatewayPresets: GATEWAY_PRESETS,
    user: userName(),
    githubLogin,
    githubAccounts: status.accounts,
    // Readiness = at least one registry model is usable: any provider/gateway
    // key set, or a keyless local endpoint (Ollama) that actually answers.
    // The first-run setup card shows until this is true.
    ready: await registryReady(registry, process.env, cachedProbe),
    github: !!token,
    cloudflare: cloudflareConfigured(),
    team: team ?? null,
    teams: listTeams(),
    mcpServers: Object.keys(rt.registry.mcpServers),
    mcpSkipped: rt.registry.skipped,
  });
});

/** Guard: only ids the model registry knows can become the active model. */
function knownModel(id: string): boolean {
  return loadModelRegistry().some((m) => m.id === id);
}

settingsRoute.post("/api/settings/model", async (c) => {
  const { model } = (await c.req.json().catch(() => ({}))) as { model?: string };
  const id = model?.trim();
  if (!id) return c.json({ error: "Missing model." }, 400);
  if (!knownModel(id)) return c.json({ error: `Unknown model id: ${id}` }, 400);
  upsertUserEnv("HEMIUNU_MODEL", id);
  setRuntimeModel(id);
  return c.json({ model: id });
});

settingsRoute.post("/api/settings/research-model", async (c) => {
  const { model } = (await c.req.json().catch(() => ({}))) as { model?: string };
  const id = model?.trim();
  if (!id) return c.json({ error: "Missing model." }, 400);
  if (!knownModel(id)) return c.json({ error: `Unknown model id: ${id}` }, 400);
  upsertUserEnv("HEMIUNU_MODEL_RESEARCH", id);
  setRuntimeResearchModel(id);
  return c.json({ researchModel: id });
});

// (The old POST /api/settings/anthropic-key is gone: first-run setup and the
// Settings panel both save through the provider-agnostic /api/settings/keys.)

// Connect Cloudflare (BYO account) for sharing prototypes. Takes a "Pages: Edit"
// API token; resolves the account ID from it (or accepts an explicit one if the
// token is too narrowly scoped to list accounts), then persists both.
settingsRoute.post("/api/settings/cloudflare", async (c) => {
  const { token, accountId } = (await c.req.json().catch(() => ({}))) as {
    token?: string;
    accountId?: string;
  };
  if (!token?.trim()) return c.json({ error: "Missing token." }, 400);
  let acct = accountId?.trim();
  if (!acct) {
    const res = await fetchCloudflareAccountId(token.trim());
    if ("error" in res) {
      return c.json(
        { error: `${res.error}. Add your account ID (dash.cloudflare.com/<account-id>).` },
        400,
      );
    }
    acct = res.accountId;
  }
  upsertUserEnv("CLOUDFLARE_API_TOKEN", token.trim());
  upsertUserEnv("CLOUDFLARE_ACCOUNT_ID", acct);
  return c.json({ ok: true, cloudflare: cloudflareConfigured() });
});
