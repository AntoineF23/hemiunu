# Architecture

A map of how Hemiunu is put together, for anyone reading the code for the first
time. For what it does and how to run it, see the [README](./README.md); for how
to work on it, see [CONTRIBUTING](./CONTRIBUTING.md).

## The shape in one sentence

One agent engine (`packages/agent-core`) is driven by two interchangeable
front-ends — a terminal CLI and a local web app — over a single streaming
function, `runTurn()`.

```
┌── apps/cli ──┐     ┌── apps/web ──────────────┐
│ Ink REPL     │     │ Vite/React SPA (:5173)   │
│ (terminal)   │     │   ↕ fetch /api           │
│              │     │ Hono worker (:4317)      │
└──────┬───────┘     └───────────┬──────────────┘
       │      both call           │
       └──────────► runTurn() ◄────┘        packages/agent-core
                        │
        ┌───────────────┼────────────────────────────┐
        │               │                             │
  Claude Agent SDK   in-process MCP            MCP servers from
  query()            tool servers              ~/.hemiunu/mcp.json
                     (remember, ask_model,     (filesystem + yours)
                      skills, workspace, …)
```

## Packages and apps

| Path | Role |
| --- | --- |
| `packages/agent-core` | The engine. `runTurn()` + every in-process tool server. No UI. |
| `packages/memory` | Context loader (`soul.md` + `user.md`) and the SQLite conversation store. |
| `packages/mcp` | `mcp.json` registry: parse, `${ENV}`/`${CWD}` interpolation, auto-skip. |
| `packages/format` | Presentation helpers shared by CLI and web (activity grouping). |
| `apps/cli` | Ink (React-for-terminal) chat REPL: streaming, permission menu, slash commands. |
| `apps/web` | Hono worker (`:4317`) + Vite/React SPA (`:5173`). |
| `apps/eval` | `smoke` (structural checks) and `cap` (live capability) harnesses. |
| `context/` | `soul.md` persona + `knowledge/` packs, shipped with the app. |

## The turn pipeline — `runTurn()`

`runTurn()` (in `packages/agent-core/src/agent.ts`) is an **async generator**:
both front-ends call it and stream the messages it yields. Per turn it:

1. **Loads config** (`config.ts`) — API key, model tiers, thinking budget — from
   `~/.hemiunu/.env` with env overrides.
2. **Builds the system prompt** from files: `context/soul.md` (persona) +
   `~/.hemiunu/user.md` (learned user facts) + the active team's `PROTOTYPE.md`
   when one is selected. Context is files, not hardcoded strings.
3. **Wires MCP servers**: the built-in filesystem server scoped to the launch
   folder (`${CWD}`), plus anything in `~/.hemiunu/mcp.json`.
4. **Assembles in-process tool servers** (see below) and calls the Claude Agent
   SDK `query()`.
5. **Yields SDK messages** (partial text, tool calls, results). Each tool call is
   gated by a permission callback the front-end supplies (yes / always / no).
6. On completion, persists the conversation to SQLite and auto-titles it.

## Key patterns

- **In-process MCP tool servers.** Each capability is its own small tool server
  created in `agent-core` and passed to `query()`: `remember` (`tools.ts`),
  `ask_model` (consult other LLMs, `tools.ts`/`providers.ts`), `save_prototype`
  (`prototype.ts`), `parallel` fan-out (`orchestrator.ts`), skills (`skills.ts`),
  workspace/git (`workspace.ts`), `PROTOTYPE.md` CRUD (`prototypes.ts`), source
  maps (`sources.ts`), GitHub (`github.ts`). Adding a capability = adding a
  server, not touching the loop.

- **Subagent delegation + model tiers.** Retrieval and building are delegated to
  cheaper-tier subagents (`researcher`, `prototyper`, `designer`) defined in
  `subagents.ts`; the main model synthesizes. `HEMIUNU_MODEL_RESEARCH` sets the
  retrieval tier.

- **Per-turn workspace isolation.** `workspace-context.ts` uses `AsyncLocalStorage`
  to pin a turn to exactly one team/repo, so concurrent turns (different
  terminals/teams) never read or write each other's workspace.

- **Tool-output cap as a hook.** `toolcap.ts` installs a `PostToolUse` hook that
  truncates oversized **built-in** tool results to protect the context window,
  while **exempting MCP results** (the substantive retrievals). Companion
  `PreToolUse` hooks enforce user "block" decisions and confine file writes to
  the prototype workspace.

- **Two front-ends, one engine.** The CLI imports `runTurn()` directly. The web
  app runs it inside the Hono worker (`apps/web/src/server`) and streams results
  to the browser over SSE; the SPA is untrusted and the worker accepts only
  `localhost` origins (DNS-rebinding guard).

## Persistence & config

- **Conversations**: SQLite at `~/.hemiunu/hemiunu.db` (`packages/memory/src/store.ts`),
  via `better-sqlite3`. Also stores folder-trust decisions.
- **User config lives outside the repo** in `~/.hemiunu/` (`.env`, `mcp.json`,
  `skills/`, `sources/`), so updating the code never touches a user's setup.

## Build & runtime

There is **no build step** in development: `tsx` runs the TypeScript directly, so
edits are live on next launch. `turbo` orchestrates `typecheck` across the
workspace; `esbuild` is used only by `scripts/build-release.mjs` to bundle a
release. See [CONTRIBUTING](./CONTRIBUTING.md) for commands.
