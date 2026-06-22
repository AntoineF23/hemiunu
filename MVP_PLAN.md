# Hemiunu — MVP Implementation Plan

> **Status: SHIPPED — kept as a historical record.** The MVP described here is
> built and the project has since grown past it (subagents, prototyping,
> `ask_model`, and the eval harness — listed below as "out of scope" — now
> exist). For how Hemiunu actually works today, **the README is the source of
> truth**; read this doc for the original milestone reasoning only.

> Standalone, execution-focused plan for the **first build**. The long-term product vision lives in `FINAL_PLAN.md`; this document only covers the MVP and is self-contained.

## What we're building (MVP)

**Hemiunu** — a CLI **product-knowledge agent**. Single user, no auth. It answers product questions grounded in **Notion (read-only)** via MCP, keeps **full conversations in SQLite** (list / resume / replay), and builds its context each turn from **file-based context construction** (Hermes-inspired): `soul.md` (persona → system prompt), `user.md` (agent-learned user facts), `memory.md` (durable notes). Built on the **Claude Agent SDK (TypeScript)**, talking to **`claude-opus-4.8`** through the org **LiteLLM proxy**.

**Out of scope for the MVP:** web UI, Auth0/RBAC, custom Auth0-protected MCP, subagents, prototyping (wireframes/design system), full eval harness. (All in `FINAL_PLAN.md`.)

## Principles
- **Minimal, clean repo** — every file earns its place; no scaffolding cruft, no empty stub packages. We add a package only when its milestone needs it.
- **Small runnable increments** — each milestone runs end-to-end and has a clear "done".
- **Future-proof seams, not future code** — `model` is a per-agent parameter from day one (MVP uses one Claude tier), so tiers and the `ask_model` tool slot in later with no refactor.

## Stack
- TypeScript + pnpm + Turborepo (lean), run via `tsx`
- `@anthropic-ai/claude-agent-sdk`
- `node:sqlite` (Node 24+ built-in) for the conversation store
- `zod`
- Notion MCP (read-only)

## Repo layout (only what the MVP uses)
```
hemiunu/
├─ apps/
│  └─ cli/                # chat REPL, ASCII banner, slash commands
├─ packages/
│  ├─ agent-core/         # query() wrapper: system prompt, model/env config, session glue
│  ├─ memory/             # context/ loader (soul/user/memory) + remember() tool + SQLite conversation store
│  └─ mcp/                # MCP registry (Notion, read-only)
├─ context/               # file-based context construction (Hermes-inspired)
│  ├─ soul.md             #   Hemiunu persona/behavior/goals → system prompt
│  ├─ user.md             #   what the agent learns about you (agent-updatable)
│  └─ memory.md           #   durable notes / workflows / facts (agent-updatable)
├─ .env                   # ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, NOTION_TOKEN (gitignored)
├─ .gitignore             # node_modules, dist, *.db, .env
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
└─ package.json
```
No `web/`, `auth/`, `prototyper/`, `evals/` packages yet — created when their phase arrives.

## Milestones

### M0 — Scaffold + proxy gate (the blocker) ✅ DONE
- Lean Turborepo: `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, root `package.json`.
- `packages/agent-core`: `runTurn()` calling `query()` with
  `env: { ANTHROPIC_BASE_URL: 'https://models.thiga.co', ANTHROPIC_API_KEY: <key> }`, `model: 'claude-opus-4.8'`, a custom `systemPrompt`.
- `apps/cli`: minimal entry that sends one hardcoded prompt and prints the result.
- `.env` (you add the LiteLLM key) + `.gitignore`.
- **GATE:** confirm the proxy serves the **Anthropic `/v1/messages`** format the SDK calls (the `/v1/models` list is OpenAI-format and does not prove this). If it fails → ask the platform team to enable LiteLLM's Anthropic endpoint, or add a thin Anthropic→OpenAI adapter.
- **Done:** `pnpm dev` prints a real `claude-opus-4.8` answer through the proxy.

### M1 — Context construction + SQLite sessions + banner ✅ DONE
- `packages/memory`:
  - `loadContext()` reads `context/soul.md`, `context/user.md`, `context/memory.md`. **`soul.md` → system prompt**; `user.md` + `memory.md` → injected via `systemPrompt.append`. Empty `soul.md` falls back to a sane default persona.
  - `remember(target, note)` tool that appends/updates `user.md` or `memory.md`, so the agent learns over time.
  - SQLite (`better-sqlite3`): `conversations(id, title, created_at, model)` and `messages(id, conversation_id, role, content, ts, cost_usd)`. Persist every turn.
- `agent-core`: assembles context from the files above; capture `session_id` from the `system/init` message; support `resume`. Expose `remember` to the agent (in-process SDK MCP tool).
- `apps/cli`: interactive REPL; **original ASCII-art "HEMIUNU" banner** on startup (our own art — not a copy of Claude Code's); commands `/new`, `/list`, `/resume <id>`, `/exit`; per-turn cost readout.
- **Done:** hold a conversation, quit, `/resume` it later with full context; banner shows; messages are in SQLite.

### M1.5 — Permission prompts + cost control ✅ DONE
- `tools` allowlist restricts the available toolset (default ~29 built-ins billed every turn → trimmed to what's needed).
- Interactive `canUseTool` permission gate (yes / always / no), persisted per session.
- Prompt caching confirmed working through the proxy (turn 2 reads turn 1's cached tokens; ~10× cheaper). CLI cost line shows tokens + cache.

### M2 — General MCP registry ✅ + local & Notion MCP live ✅
- `packages/mcp`: declarative **`mcp.json`** registry (standard `mcpServers` shape) supporting remote (`http`/`sse`) and local (`stdio`) servers, `${ENV}` interpolation (secrets stay in `.env`), `disabled` flag, and **auto-skip** when a referenced env var is unset. Returns `{ mcpServers, toolPatterns, skipped }`.
- Wired into `runTurn` via `mcpServers` + wildcard `toolPatterns` (`mcp__<name>__*`); every MCP call is gated by the yes/always/no permission prompt. CLI shows connect/skip status + a `/mcp` command. **All verified except a live external connection.**
- **Local (stdio) MCP ✅ VERIFIED LIVE** — filesystem server; Hemiunu read the real project folder via `mcp__filesystem__*`.
- **Notion (stdio, integration token) ✅ VERIFIED LIVE** — `@notionhq/notion-mcp-server` with `NOTION_TOKEN` (in `.env`); Hemiunu called `mcp__notion__API-post-search` and returned real workspace pages. ⚠ Cost: ~$0.87 cold turn because Notion exposes ~20+ large-schema tools; mitigate with **MCP tool search** and/or a per-server tool allowlist (search + retrieve only). Also: first `npx` run can exceed the 60s connect timeout — pre-install the server to avoid cold-start failures.
- **Deferred: OAuth-protected remote servers** (hosted Notion, Auth0 custom) — the Agent SDK does NOT do OAuth automatically, so we build our own token-broker. Full design captured in **`OAUTH_PLAN.md`**.
- **Done when:** Hemiunu answers a question grounded in real local files via a live stdio MCP server, with the permission prompt gating the call.

### M3 — Polish + smoke check ✅ DONE
- ✅ Streaming output in the CLI (Ink TUI consumes the `query()` generator incrementally).
- ✅ Cost display (`total_cost_usd`) per turn / per session (status footer).
- ✅ Smoke / eval harness — `apps/eval` (`corepack pnpm smoke [--offline]`): offline structural checks (config, context, MCP registry, `remember`) + a live M0 gate turn through the proxy. Exits non-zero on failure, so it doubles as a pre-push gate.
- ✅ Concise `README.md`: setup, env vars, MCP, slash commands, how to run.
- **Done:** smooth streamed chat, persisted to SQLite, grounded in connected sources; `corepack pnpm dev` launches Hemiunu; `corepack pnpm smoke` is green (7/7).

## Needed from you
- **LiteLLM key** → `.env` (`ANTHROPIC_API_KEY`). You add it directly so it never passes through me.
- **Notion** internal integration token + shared workspace (M2).
- **`context/` content** — `soul.md` (Hemiunu's persona/tone/goals) and a `memory.md` seed (team, product areas, glossary, KPIs). I'll scaffold templates with sensible defaults for you to refine; `user.md` starts empty and the agent fills it.

## Risks / watch-items
- **Proxy Anthropic-format gate** (M0) — the one thing that could force a config change or adapter.
- **Notion MCP shape** — confirm the chosen Notion MCP server accepts an internal-integration token in read-only mode; otherwise fall back to OAuth.

## MVP definition of done
Ask Hemiunu a product question → it answers grounded in our Notion workspace → the conversation persists in SQLite and can be resumed tomorrow, all running from the CLI via `claude-opus-4.8` on the proxy.
