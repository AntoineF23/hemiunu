# Architecture

A map of how Hemiunu is put together, for anyone reading the code for the first
time. For what it does and how to run it, see the [README](./README.md); for how to
work on it, see [CONTRIBUTING](./CONTRIBUTING.md).

## The shape in one sentence

One model-agnostic engine (`packages/engine`) runs the agent turn; `agent-core`
wraps it as `createEngineRuntime()` and adds the in-process tool servers; two
interchangeable front-ends (a terminal CLI and a local web app) drive that runtime
and stream the `TurnEvent`s it yields.

```
┌── apps/cli ──┐     ┌── apps/web ──────────────┐
│ Ink REPL     │     │ Vite/React SPA (:5173)   │
│ (terminal)   │     │   fetch /api             │
│              │     │ Hono worker (:4317)      │
└──────┬───────┘     └───────────┬──────────────┘
       │   both call             │
       └── createEngineRuntime() ─┘        packages/agent-core
                        │  .runTurn() streams TurnEvents
        ┌───────────────┼────────────────────────────┐
        │               │                             │
  packages/engine    in-process tool           MCP servers from
  loop + model       servers (remember,        ~/.hemiunu/mcp.json
  registry (any      ask_model, skills,        (filesystem + yours)
  provider)          workspace, ...)
```

## Packages and apps

| Path | Role |
| --- | --- |
| `packages/engine` | The model-agnostic engine (built on the Vercel AI SDK). Model registry, the tool-calling loop, the `TurnEvent` protocol, transcript store, compactor, MCP host, `web_search` / `web_fetch`, permission pipeline. The only package that imports `ai` / `@ai-sdk/*`. |
| `packages/agent-core` | `createEngineRuntime()` (the drop-in runtime facade both apps use) plus every in-process tool server, the subagents, and github / deploy / scan. No UI. |
| `packages/memory` | Context loader (`soul.md` + `user.md`) and the SQLite conversation store. |
| `packages/mcp` | `mcp.json` registry: parse, `${ENV}` / `${CWD}` interpolation, auto-skip. |
| `packages/format` | Presentation helpers shared by CLI and web (activity grouping). |
| `apps/cli` | Ink (React-for-terminal) chat REPL: streaming, permission menu, slash commands. |
| `apps/web` | Hono worker (`:4317`) + Vite/React SPA (`:5173`). |
| `apps/eval` | `smoke` (structural checks) and `cap` (live capability) harnesses, both driving `createEngineRuntime()`. |
| `context/` | `soul.md` persona + `knowledge/` packs, shipped with the app. |

## The turn pipeline

`createEngineRuntime()` (in `packages/agent-core/src/runtime.ts`) returns a runtime
whose `runTurn()` is an **async generator**: both front-ends call it and stream the
`TurnEvent`s it yields. The generator body runs on the engine loop
(`packages/engine/src/loop.ts`). Per turn it:

1. **Loads config** (`config.ts`): provider keys, model tiers, thinking budget, from
   `~/.hemiunu/.env` with env overrides. The main model is resolved from the
   registry (any provider), not hardcoded to one vendor.
2. **Builds the system prompt** from files: `context/soul.md` (persona) plus
   `~/.hemiunu/user.md` (learned user facts) plus the active team's `PROTOTYPE.md`
   when one is selected. Context is files, not hardcoded strings.
3. **Wires MCP servers**: the built-in filesystem server scoped to the launch folder
   (`${CWD}`), plus anything in `~/.hemiunu/mcp.json`.
4. **Assembles the in-process tool servers** (see below) and runs the engine's
   tool-calling loop against the selected model through the Vercel AI SDK.
5. **Yields `TurnEvent`s** (partial text, tool calls, results, usage). Each tool call
   is gated by a permission callback the front-end supplies (yes / always / no).
6. On completion, persists the conversation to SQLite and auto-titles it.

## Key patterns

- **In-process tool servers.** Each capability is its own small tool server created
  in `agent-core` and passed into the runtime: `remember`, `ask_model` (consult any
  other registry model), `save_prototype`, `parallel` fan-out, skills,
  workspace/git, `PROTOTYPE.md` CRUD, source maps, GitHub. Adding a capability means
  adding a server, not touching the loop.

- **Model-agnostic registry.** `packages/engine/src/models.ts` holds the shipped
  entries (Anthropic, OpenAI, Gemini, OpenAI-compatible providers, LiteLLM-routed
  gateway models, local Ollama), merged with `~/.hemiunu/models.json`. Any entry can
  drive a whole turn; context windows and capabilities are per-entry.

- **Subagent delegation and model tiers.** Retrieval and building are delegated to
  cheaper-tier subagents (`researcher`, `prototyper`, `designer`) defined in
  `engine-subagents.ts`; the main model synthesizes. `HEMIUNU_MODEL_RESEARCH` sets
  the retrieval tier.

- **Per-turn workspace isolation.** The engine's workspace context (`AsyncLocalStorage`)
  pins a turn to exactly one team/repo, so concurrent turns (different terminals or
  teams) never read or write each other's workspace.

- **Tool-output cap in the pipeline.** The permission pipeline truncates oversized
  built-in tool results to protect the context window
  (`HEMIUNU_TOOL_RESULT_BUDGET`), while exempting MCP results (the substantive
  retrievals). It also enforces user "block" decisions and confines file writes to
  the prototype workspace.

- **Two front-ends, one runtime.** The CLI calls `createEngineRuntime().runTurn()`
  directly. The web app runs it inside the Hono worker (`apps/web/src/server`) and
  streams results to the browser over SSE; the SPA is untrusted and the worker
  accepts only `localhost` origins (DNS-rebinding guard).

## Persistence and config

- **Conversations**: SQLite at `~/.hemiunu/hemiunu.db` (`packages/memory/src/store.ts`),
  via `better-sqlite3`. Also stores folder-trust decisions.
- **User config lives outside the repo** in `~/.hemiunu/` (`.env`, `mcp.json`,
  `models.json`, `skills/`, `sources/`), so updating the code never touches a
  user's setup.

## Observability (OpenTelemetry)

Tracing is **opt-in and off by default** (`packages/engine/src/telemetry.ts`). When
the operator sets `HEMIUNU_OTEL=1` or an `OTEL_EXPORTER_OTLP_*` endpoint, the engine
starts an OTLP exporter against the standard env contract, so a teammate running
Hemiunu sees its traces in the observability stack they already run — nothing
Hemiunu-specific to host. Each turn is a `hemiunu.turn` span with a `hemiunu.step`
child per model round-trip; under each step sit the AI SDK's GenAI model span (via
`experimental_telemetry`) and a `hemiunu.tool.<name>` span per tool call (input,
result, permission decision) — the tool spans are ours because the loop runs tools
itself (the SDK never does). A delegated subagent is a nested `hemiunu.subagent.<name>`
span tagged with its knowledge pack + a content hash, so a team can correlate edits
to `context/knowledge/*.md` with traced outcomes. Two privacy defaults: the actor is
pseudonymous (a persisted random instance id — no host/user identity on the resource),
and a redacting exporter scrubs secrets from recorded content. See `.env.example` for
the full knob list.

## Build and runtime

There is **no build step** in development: `tsx` runs the TypeScript directly, so
edits are live on next launch. `turbo` orchestrates `typecheck` across the
workspace; `esbuild` is used only by `scripts/build-release.mjs` to bundle a
release. See [CONTRIBUTING](./CONTRIBUTING.md) for commands.
