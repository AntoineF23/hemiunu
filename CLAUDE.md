# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hemiunu is an organization-wide AI **Product Agent** for a product team, built on the **Claude Agent SDK for TypeScript** (`@anthropic-ai/claude-agent-sdk`). The current build is a CLI MVP. The README is the canonical user-facing doc; `FINAL_PLAN.md` (vision) and `MVP_PLAN.md` (milestones) are kept in sync and steered from — update them when decisions change.

## Commands

- `corepack pnpm install` — install (pnpm is **not** on PATH; always prefix with `corepack`, or use `npx pnpm`).
- `corepack pnpm dev` — launch the CLI TUI from the repo. Needs a TTY, so it can't be headless-tested.
- `corepack pnpm smoke` — offline structural checks + one live turn through the proxy.
- `corepack pnpm smoke --offline` — deterministic checks only, no API calls, no cost. Run this for fast iteration.
- `corepack pnpm cap` — live capability eval (scenarios S1–S11 in `apps/eval/src/capability.ts`). `corepack pnpm cap S6 S8` filters by id; `CAP_DEBUG=1` traces tools/delegations/text.
- `corepack pnpm typecheck` — `turbo run typecheck` across the workspace (each package runs `tsc --noEmit`).
- Requires **Node 20+**. The conversation store uses `better-sqlite3` (a native module with prebuilt binaries) so it runs on Node 20 LTS, not just Node 24 — this is what lets `npx hemiunu` reach a normal install base. Buildless dev via `tsx` — no compile step; run `.ts`/`.tsx` directly.

## Architecture

Lean pnpm + Turborepo monorepo. Everything funnels through one function: **`runTurn()`** in `packages/agent-core/src/agent.ts`, a wrapper around the SDK's `query()` that assembles the model config, system prompt, MCP servers, tool allowlist, and subagent definitions for a single turn.

- **`packages/agent-core`** — the brain. `agent.ts` (`runTurn`) is the entry point; `index.ts` is the public surface. Built from many small in-process SDK MCP servers, each a `create*Server()` + a `*_TOOL_ID`/`*_TOOLS` pattern, all registered in `runTurn`: memory (`remember`), models (`ask_model`), prototype (`save_prototype`), orchestrator (`parallel`), skills, prototype-knowledge (`add_prototype_note`), workspace/iterate, share, control, github/teams, vercel. `subagents.ts` is the single source of truth for subagent specs (`SUBAGENTS` map: `researcher` on the retrieval tier, `prototyper` on the synthesis tier).
- **`packages/memory`** — `context.ts` builds the system prompt from `context/` files (Hermes-style); `store.ts` is the SQLite `ConversationStore` on `better-sqlite3`; the `remember()` core lives here.
- **`packages/mcp`** — reads `mcp.json` (standard `mcpServers` shape, `stdio`/`http`/`sse`), `${ENV}` interpolation, `${CWD}` → launch dir, auto-skips servers whose env vars are unset or `disabled`.
- **`apps/cli`** — `index.tsx`, a single-file **Ink (React) TUI**: `<Static>` scrollback, live streaming, arrow-key permission menu, status footer, slash commands, auto-compaction. `tsconfig` sets `jsx: react-jsx`.
- **`apps/eval`** — `smoke.ts` (offline + live), `capability.ts` (S1–S11), shared helpers in `harness.ts`.

### Context construction (Hermes-inspired)
We fully control context (`settingSources: []`, so the SDK does **not** auto-load `CLAUDE.md`). The system prompt is assembled from just two files (`packages/memory/src/context.ts`): `context/soul.md` (persona, ships with the app) + a **global** `user.md` in `~/.hemiunu/` (facts about the *user*, carried across all projects). The agent updates these via two distinct, deliberately separated tools — don't conflate them: `remember` writes USER facts to the global `user.md` (no `target` param), while `add_prototype_note`/`update_prototype` write FEATURE facts to the team's `PROTOTYPE.md`. There is intentionally **no** per-launch-folder memory file — feature knowledge lives in `PROTOTYPE.md` in the team repo (committed straight through the GitHub Contents API, no clone). (Note: the README still describes a per-project `HEMIUNU.md`; that's aspirational and not implemented.) Keep large domain knowledge out of the always-on `soul.md` — put it in `context/knowledge/<topic>.md` and inject it only into the subagent that needs it via `subagentPrompt(name)`.

### Three filesystem roots — keep them distinct
1. **HOME** (`HEMIUNU_HOME`, the install dir) — where `soul.md`/`mcp.json` ship from.
2. **config dir** (`~/.hemiunu`, override `HEMIUNU_CONFIG_DIR`) — user `.env`, `mcp.json` overlay, `hemiunu.db`, `user.md`, skills, team workspaces. Separate from the cloned code so `git pull` never clobbers user config.
3. **CWD** (`process.cwd()`, the launch dir) — file access scope for the filesystem MCP (`${CWD}`) and folder-trust. `bin/hemiunu.mjs` sets `HEMIUNU_HOME` to the install and leaves `cwd` as the user's launch dir, so the agent reads *that* folder with its brain from the install.

### Teams & concurrency
A team = a feature = a repo (1:1), worked via the GitHub API (no clone needed for knowledge edits). **Concurrency = one team per terminal process**, NOT in-window background concurrency (this was built and deliberately reverted). The safety mechanism is **per-turn repo binding**: `withWorkspace`/`currentWorkspace` (an `AsyncLocalStorage` in `workspace-context.ts`) — every turn resolves its repo from the binding, not shared mutable state, so two terminals never write to each other's repo. Don't re-propose in-window concurrency.

## Critical constraints & gotchas

- **Cost = the `tools` allowlist.** The SDK bills every tool's schema each turn. Pass `tools` (allowlist) — NOT `allowedTools` (that only controls auto-approval). Restricting tools is what keeps turns cheap. `canUseTool` provides interactive yes/always/no permission; when set, blanket `allowedTools` auto-approve is dropped.
- **Prompt caching is on by default and verified through the proxy** — the cold first turn pays the full schema cost; multi-turn sessions amortize it (~10× cheaper). MCP **tool search does NOT work through a LiteLLM proxy** (the proxy doesn't forward `tool_reference` blocks → tools go invisible). Decision: rely on caching alone, expose all tools per server as `mcp__<name>__*` wildcards.
- **Thinking, not effort, is the lever.** The engine defaults to `effort: xhigh`, which non-Opus models reject; the top-level `effort` option does NOT override it. Use the `thinking` option: `{ type: 'disabled' }` (default, cheapest, works everywhere) or set `HEMIUNU_THINKING_BUDGET` > 0.
- **`claude-haiku-4.5` is unusable as a tier through the proxy** — the SDK always sends an `effort` param haiku rejects, and `thinking: disabled` doesn't suppress it. The cheap/retrieval tier stays Sonnet.
- **Parallelism must be deterministic code, not model-driven.** Both Sonnet and Opus dispatch `Task`/subagents one-per-turn even when told to parallelize. The `parallel` tool (`orchestrator.ts`, `pool()`) is real code-level fan-out. (Eval note: Opus-4.8 *uses* the `parallel` tool for explicit parallel requests; Sonnet-4.6 does sequential delegations — that's why S8 passes on Opus and fails on Sonnet, a known gap not a regression.)
- **Filesystem MCP ignores the CLI-arg path** — modern `@modelcontextprotocol/server-filesystem` takes its root from the SDK client roots = `process.cwd()`. To point it at a fixture you must `process.chdir()` for the turn (and `realpathSync` on macOS for `/var`→`/private/var`).
- Pre-install MCP servers — a cold `npx` download can exceed the SDK's 60s connect timeout on first run.

## Working style

Build **slowly and master every piece** — small, runnable increments over speed. Keep the repo minimal and clean: no scaffolding cruft, no empty stub packages; add a file/package only when its milestone needs it. Surface genuine architectural forks as explicit choices rather than silently picking. Don't over-build the MVP — web/auth/full prototyping are deferred to their phases.
