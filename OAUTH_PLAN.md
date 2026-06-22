# Hemiunu — OAuth / Token-Broker for MCP (deferred milestone)

> **Status:** DEFERRED. Captured for later. Hemiunu starts with local (stdio) MCP servers, which need no auth. Build this when we want OAuth-protected remote servers (hosted Notion at `mcp.notion.com`, and the final-vision Auth0-protected custom servers).

## Why this is needed

The **Agent SDK does not perform OAuth flows automatically** (confirmed in the official MCP docs: *"The SDK doesn't handle OAuth flows automatically, but you can pass access tokens via headers after completing the OAuth flow in your application."*). The `claude mcp add … → /mcp → OAuth` convenience belongs to the **Claude Code CLI**, not the library. So Hemiunu must run its **own** OAuth 2.1 client, obtain a token, and inject `Authorization: Bearer <token>` into the SDK `http` server config. This is the **token broker** from `FINAL_PLAN.md`.

## Module layout

- `packages/mcp/src/oauth.ts` — discovery, dynamic client registration, PKCE auth-code flow (browser + loopback), token exchange, refresh.
- `packages/mcp/src/store.ts` — credential store at `.hemiunu/credentials.json` (already gitignored).

## Flow (MCP OAuth 2.1)

1. **Discovery**
   - POST the MCP url unauthenticated → expect `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
   - Fetch that **Protected Resource Metadata** (RFC 9728) → `authorization_servers[0]`.
   - Fetch **Authorization Server Metadata** (RFC 8414) at `<as>/.well-known/oauth-authorization-server`, falling back to `/.well-known/openid-configuration` → `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `scopes_supported`.
2. **Dynamic Client Registration** (RFC 7591)
   - POST `registration_endpoint`: `{ client_name:"Hemiunu", redirect_uris:[loopback], grant_types:["authorization_code","refresh_token"], response_types:["code"], token_endpoint_auth_method:"none" }` → `client_id` (+ optional `client_secret`).
   - Fallback: a pre-set `clientId` in `mcp.json` if the AS doesn't support DCR.
3. **Authorization Code + PKCE (S256)**
   - Start a loopback HTTP server on an ephemeral port → `redirect_uri = http://localhost:<port>/callback`.
   - Generate `code_verifier` (32 random bytes, base64url) + `code_challenge` (SHA-256, base64url) + `state`.
   - Open the browser to the authorize URL: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`, `resource=<mcp url>` (RFC 8707), optional `scope`. Print the URL as a fallback if the browser doesn't open.
   - Capture `code`, verify `state`, show a success page.
4. **Token exchange**
   - POST `token_endpoint` (form-encoded): `grant_type=authorization_code, code, redirect_uri, client_id, code_verifier, resource` (+ `client_secret` if confidential) → `access_token`, `refresh_token`, `expires_in`.
5. **Store** — `.hemiunu/credentials.json`, per server: `{ accessToken, refreshToken, expiresAt, clientId, clientSecret?, tokenEndpoint, resource }`.
6. **Refresh** — `ensureToken(name)`: load credential; if expiring (<60s) and a `refresh_token` exists, POST `grant_type=refresh_token`, update the store; return the access token.

## Registry integration

- Extend the `mcp.json` schema: remote servers accept `"auth": "oauth"` (+ optional `clientId`, `scopes`).
- `loadMcpRegistry` returns `oauthServers: { name, url, clientId?, scopes? }[]` (not yet authed).
- New async `prepareRegistry()` resolves each oauth server via `ensureToken`:
  - token present → add to `mcpServers` as `http` + `Authorization: Bearer …` header + `mcp__<name>__*` tool pattern;
  - no token → `skipped` with reason `needs login: /login <name>`.

## CLI

- `/login <server>` — run the interactive flow (browser + loopback), store tokens, re-prepare servers.
- `/mcp` — also show auth status (authed / needs-login).

## Browser open

Spawn `open` (darwin) / `xdg-open` (linux) / `start` (win); always also print the URL.

## Caveats

- Loopback redirect per RFC 8252 (allowed for native apps).
- DCR may be unsupported → fall back to a pre-set `client_id`.
- Some authorization servers require a `scope`.
- Token TTLs vary; rely on refresh.

## Verification

- Unit-test **discovery** against public metadata (no consent needed).
- Full flow: `/login notion` → browser consent → token stored → `mcp__notion__*` available → a Notion-grounded answer. Then quit/relaunch and confirm refresh works without re-consent.
