import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writeSecretFile } from "./config";
import { timeoutSignal } from "./net";

/**
 * OAuth 2.1 for REMOTE MCP servers (the standard MCP authorization flow: PKCE +
 * dynamic client registration + resource indicators). Remote servers like the
 * hosted Figma MCP answer 401 with a `WWW-Authenticate: Bearer …` challenge; the
 * Claude Agent SDK's http/sse config only accepts static `headers`, so Hemiunu
 * runs the flow itself, stores the token (~/.hemiunu/mcp-oauth.json), refreshes
 * it, and injects `Authorization: Bearer …` into that server's config each turn.
 *
 * No new dependencies — `fetch` + `node:crypto`. DCR-only: a server without a
 * registration endpoint surfaces a clear "not supported" error.
 */

const OAUTH_TIMEOUT_MS = 20_000;
const sig = () => timeoutSignal(OAUTH_TIMEOUT_MS);

// --- token store (~/.hemiunu/mcp-oauth.json), keyed by server name -----------

export interface McpOAuthRecord {
  /** Server name = the mcp.json key (also the injection key). */
  server: string;
  /** The MCP server URL (the OAuth "resource"). */
  serverUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (absent = unknown/never). */
  expiresAt?: number;
}

interface McpOAuthFile {
  records: McpOAuthRecord[];
}

function authPath(): string {
  return join(configDir(), "mcp-oauth.json");
}

function loadFile(): McpOAuthFile {
  try {
    const raw = JSON.parse(readFileSync(authPath(), "utf8")) as Partial<McpOAuthFile>;
    const records = Array.isArray(raw.records)
      ? raw.records.filter(
          (r): r is McpOAuthRecord =>
            !!r && typeof r.server === "string" && typeof r.accessToken === "string",
        )
      : [];
    return { records };
  } catch {
    return { records: [] };
  }
}

function saveFile(f: McpOAuthFile): void {
  mkdirSync(configDir(), { recursive: true });
  writeSecretFile(authPath(), `${JSON.stringify(f, null, 2)}\n`);
}

function getRecord(server: string): McpOAuthRecord | undefined {
  return loadFile().records.find((r) => r.server === server);
}

function putRecord(rec: McpOAuthRecord): void {
  const f = loadFile();
  const i = f.records.findIndex((r) => r.server === rec.server);
  if (i >= 0) f.records[i] = rec;
  else f.records.push(rec);
  saveFile(f);
}

/** Forget a server's OAuth token (e.g. on "disconnect" / re-authorize from scratch). */
export function removeMcpOAuth(server: string): void {
  const f = loadFile();
  f.records = f.records.filter((r) => r.server !== server);
  saveFile(f);
}

/** Whether a server has a stored token (for the UI status). */
export function mcpOAuthStatus(server: string): { authorized: boolean; expiresAt?: number } {
  const r = getRecord(server);
  return { authorized: !!r, expiresAt: r?.expiresAt };
}

// --- PKCE --------------------------------------------------------------------

/** S256 code challenge for a verifier (exported for testing against RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

// --- discovery ---------------------------------------------------------------

/** Parse the hints out of a `WWW-Authenticate: Bearer …` challenge header. */
export function parseWwwAuthenticate(header: string): {
  resourceMetadata?: string;
  authorizationUri?: string;
  scope?: string;
} {
  return {
    resourceMetadata: /resource_metadata="([^"]+)"/.exec(header)?.[1],
    authorizationUri: /authorization_uri="([^"]+)"/.exec(header)?.[1],
    scope: /scope="([^"]+)"/.exec(header)?.[1],
  };
}

interface AuthServerMeta {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: sig() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** A candidate may be an issuer base OR a full metadata URL — try both shapes. */
async function fetchAuthMeta(candidate: string): Promise<AuthServerMeta | null> {
  const base = candidate.replace(/\/$/, "");
  const urls = /\/\.well-known\//.test(base)
    ? [base]
    : [
        `${base}/.well-known/oauth-authorization-server`,
        `${base}/.well-known/openid-configuration`,
      ];
  for (const u of urls) {
    const m = await fetchJson<AuthServerMeta>(u);
    if (m?.authorization_endpoint && m.token_endpoint) return m;
  }
  return null;
}

export interface DiscoveredAuth {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scope?: string;
}

/**
 * Discover a server's OAuth endpoints: read the 401 `WWW-Authenticate` hints,
 * then the protected-resource + authorization-server metadata. Throws if the
 * server doesn't advertise dynamic client registration (DCR-only).
 */
export async function discoverMcpAuth(serverUrl: string): Promise<DiscoveredAuth> {
  const origin = new URL(serverUrl).origin;
  let hint: ReturnType<typeof parseWwwAuthenticate> = {};
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
      signal: sig(),
    });
    hint = parseWwwAuthenticate(res.headers.get("www-authenticate") ?? "");
  } catch {
    // fall through to well-known probing
  }

  const prm = await fetchJson<{ authorization_servers?: string[] }>(
    hint.resourceMetadata ?? `${origin}/.well-known/oauth-protected-resource`,
  );
  const candidates = [hint.authorizationUri, ...(prm?.authorization_servers ?? []), origin].filter(
    (c): c is string => !!c,
  );

  for (const c of candidates) {
    const meta = await fetchAuthMeta(c);
    if (!meta) continue;
    if (!meta.registration_endpoint) {
      throw new Error(
        "This server doesn't support automatic sign-up (dynamic client registration) — not supported yet.",
      );
    }
    return {
      authorizationEndpoint: meta.authorization_endpoint!,
      tokenEndpoint: meta.token_endpoint!,
      registrationEndpoint: meta.registration_endpoint,
      scope: hint.scope ?? meta.scopes_supported?.join(" "),
    };
  }
  throw new Error("Couldn't find this server's sign-in endpoints (OAuth metadata).");
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hemiunu", version: "0" },
    },
  });
}

// --- dynamic client registration (RFC 7591) ----------------------------------

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Hemiunu",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: sig(),
  });
  if (res.status === 401 || res.status === 403) {
    // Endpoint exists but won't let just anyone register — it's gated to
    // pre-approved partner apps (Figma's hosted MCP behaves this way).
    throw new Error(
      "this server doesn't allow automatic sign-up (its registration is restricted to approved apps) — not supported yet.",
    );
  }
  if (!res.ok) throw new Error(`client registration failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!j.client_id) throw new Error("client registration returned no client_id");
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

// --- authorization flow ------------------------------------------------------

interface PendingAuth {
  server: string;
  serverUrl: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  scope?: string;
}

// Short-lived, in-process — only spans the seconds between "start" and the
// browser redirect "callback". Keyed by the opaque `state`.
const pending = new Map<string, PendingAuth>();

/**
 * Begin authorizing a remote MCP server: discover endpoints, register a client,
 * and build the authorization URL the user opens in a browser. Returns the URL
 * and the `state` the callback must echo back.
 */
export async function startMcpAuth(
  server: string,
  serverUrl: string,
  redirectUri: string,
): Promise<{ authUrl: string; state: string }> {
  const disc = await discoverMcpAuth(serverUrl);
  const { clientId, clientSecret } = await registerClient(disc.registrationEndpoint, redirectUri);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");
  pending.set(state, {
    server,
    serverUrl,
    verifier,
    clientId,
    clientSecret,
    authorizationEndpoint: disc.authorizationEndpoint,
    tokenEndpoint: disc.tokenEndpoint,
    redirectUri,
    scope: disc.scope,
  });

  const u = new URL(disc.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", serverUrl); // RFC 8707
  if (disc.scope) u.searchParams.set("scope", disc.scope);
  return { authUrl: u.toString(), state };
}

/** Complete the flow: exchange the authorization code for tokens and store them. */
export async function completeMcpAuth(state: string, code: string): Promise<{ server: string }> {
  const p = pending.get(state);
  if (!p) throw new Error("unknown or expired authorization session");
  pending.delete(state);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
    resource: p.serverUrl,
  });
  if (p.clientSecret) body.set("client_secret", p.clientSecret);

  const res = await fetch(p.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: sig(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!j.access_token) throw new Error("token exchange returned no access_token");

  putRecord({
    server: p.server,
    serverUrl: p.serverUrl,
    authorizationEndpoint: p.authorizationEndpoint,
    tokenEndpoint: p.tokenEndpoint,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    scope: j.scope ?? p.scope,
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
  });
  return { server: p.server };
}

// --- refresh + per-turn injection --------------------------------------------

async function refreshRecord(rec: McpOAuthRecord): Promise<McpOAuthRecord | null> {
  if (!rec.refreshToken) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: rec.refreshToken,
    client_id: rec.clientId,
    resource: rec.serverUrl,
  });
  if (rec.clientSecret) body.set("client_secret", rec.clientSecret);
  try {
    const res = await fetch(rec.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: sig(),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!j.access_token) return null;
    const next: McpOAuthRecord = {
      ...rec,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? rec.refreshToken,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    };
    putRecord(next);
    return next;
  } catch {
    return null;
  }
}

/**
 * Header supplier for the engine's McpHost (`McpHostOptions.headers`): a fresh
 * `Authorization: Bearer …` for servers with a stored OAuth token (refreshed
 * near expiry via bearerFor), undefined otherwise. McpHost consults this
 * before EVERY tool call, so refreshed bearers apply without a reconnect —
 * and a 401 still triggers its reconnect-with-fresh-headers retry.
 */
export async function mcpOAuthHeaders(server: string): Promise<Record<string, string> | undefined> {
  const token = await bearerFor(server);
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** A valid access token for a server (refreshing if near expiry), or undefined. */
export async function bearerFor(server: string): Promise<string | undefined> {
  let rec = getRecord(server);
  if (!rec) return undefined;
  if (rec.expiresAt && rec.expiresAt - Date.now() < 60_000) {
    rec = (await refreshRecord(rec)) ?? rec; // refresh failed → try the existing token
  }
  return rec.accessToken;
}

/**
 * Return a COPY of the server map with `Authorization: Bearer …` injected for
 * every server that has a stored OAuth token (refreshed as needed). Never
 * mutates the cached registry. Call this just before runTurn each turn.
 */
export async function applyMcpOAuth(
  servers: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const records = loadFile().records;
  if (!records.length) return servers;
  const out: Record<string, unknown> = { ...servers };
  for (const [name, cfg] of Object.entries(servers)) {
    if (!records.some((r) => r.server === name)) continue;
    const token = await bearerFor(name);
    if (!token) continue;
    const c = cfg as Record<string, unknown>;
    out[name] = {
      ...c,
      headers: {
        ...((c.headers as Record<string, string>) ?? {}),
        Authorization: `Bearer ${token}`,
      },
    };
  }
  return out;
}

// --- reachability / auth probe (UI diagnostic) -------------------------------

export type McpProbe = "ok" | "needs-auth" | "unreachable";

/**
 * Probe a remote MCP URL: `needs-auth` (401), `unreachable` (connection error /
 * timeout), or `ok` (responded). Note: a server we HAVE a token for still probes
 * `needs-auth` here (we probe without the token) — callers combine this with
 * mcpOAuthStatus() to decide what to show.
 */
export async function probeMcpServer(url: string): Promise<McpProbe> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
      signal: timeoutSignal(8000),
    });
    return res.status === 401 ? "needs-auth" : "ok";
  } catch {
    return "unreachable";
  }
}
