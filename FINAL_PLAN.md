# Product Agent — Architecture Skeleton & Phased Roadmap

> **Status:** This is the **FINAL product vision**. Implementation starts with an **MVP** (a deliberately small subset), which we are defining in detail separately. This file is the canonical reference.

## Context

We are building a **Product Agent**: an organization-wide AI agent for an entire product team, built on the **Claude Agent SDK for TypeScript** (`@anthropic-ai/claude-agent-sdk`). It will surface the best ideas, information, and **deployable web-app prototypes** by orchestrating many MCP servers (SaaS + custom Auth0-protected ones), backed by long-term **memory**, a managed **active session/context**, **tools**, **skills**, **subagents**, **harnesses/hooks**, **evaluations**, **multi-user org access with roles**, and the ability to **build, test, and deploy prototypes to a shared space** (Vercel).

The intent is to build this **slowly and master every piece**, designing the full architecture skeleton first, delivered ultimately as a **hosted web app** with per-user login.

### Two foundational constraints (drive the design)
- **Anthropic auth ≠ user auth.** Third-party products may **not** use claude.ai login (per official Agent SDK docs). The app authenticates to Claude with the **org's own API key / proxy** (here: a **LiteLLM proxy** at `models.thiga.co`) or Bedrock/Vertex/Azure. **Auth0** is solely for *your team members logging into your product*. Keep these two identity planes separate.
- **The agent loop needs persistent compute.** The SDK stores sessions as JSONL on the filesystem and a turn can run for minutes. Run the **agent core on a long-lived worker/container** (not a short serverless function). The Next.js app is a thin client that streams from it. (Future option: swap the core for Anthropic **Managed Agents** REST API if we'd rather not operate session infra.)

---

## Target Architecture (the "skeleton")

Eight layers, each maps to a package.

1. **Access layer** — Next.js (App Router) hosted web UI on Vercel + a thin CLI. Streams agent output (SSE). Per-user login via **Auth0** (organization + roles).
2. **Agent core** — A long-lived Node service wrapping the SDK's `query()`. One SDK session per conversation. Holds the Product-Agent system prompt, **multi-model strategy** (see below), permission policy, hooks, and the tool/skill/MCP/subagent wiring.
3. **Memory & context construction (file-based, Hermes-inspired)** — context is assembled each turn from minimal, explicit files in a project-owned **`context/`** directory (NOT the auto-loaded `CLAUDE.md` convention — *we* control exactly what's in context):
   - **`soul.md`** — the agent's persona, tone, goals, behavior → used as the **system prompt** (Hemiunu's identity). Falls back to a default if empty.
   - **`user.md`** — what the agent has learned about the user → injected into context and **updated by the agent** as it learns.
   - **`memory.md`** — broader durable notes: workflows, tool-usage details, facts → injected and **updated by the agent**.
   - **Auto-appended each turn:** recent **message history** (SDK session JSONL, automatic compaction, `resume`/`fork`), **tool & skill descriptions** (from the SDK), and — when configured — **relevant external memory** (vector/RAG; later phase).
   - `packages/memory` owns loading `context/*.md` (injecting `user.md` + `memory.md` via `systemPrompt.append`, `soul.md` as the system prompt) and a **`remember()` tool** that appends/updates `user.md`/`memory.md`. Durable per-user/team storage graduates to Postgres in the hosted phase (the SDK `agent.memory: 'user' | 'project'` field also available).
4. **Tools & Skills layer** — in-process custom tools via `tool()` + `createSdkMcpServer({ type: 'sdk' })`; **Agent Skills** in `.claude/skills/*/SKILL.md`; specialized **subagents** (researcher, prototyper, designer, evaluator) via the `agents` option.
5. **MCP layer** — a registry mapping logical servers → configs. SaaS servers (Notion, Linear, Slack, Figma, Atlassian…) and **custom Auth0-protected** servers via `{ type: 'http', url, headers: { Authorization: 'Bearer <token>' } }`. A **token broker** exchanges the user's Auth0 session for downstream MCP access tokens (per-user, least-privilege).
6. **Prototyping layer** — a **two-stage** flow:
   - **Stage A — Wireframes (low-fidelity, fast iteration):** the `prototyper` subagent first generates lightweight wireframe prototypes (structure/flows/layout, minimal styling) so the team can react and iterate cheaply before visual polish. Multiple rounds expected.
   - **Stage B — Final prototype (high-fidelity via design system):** once a wireframe is approved, the agent consumes a **design-system MCP server** (e.g. Figma/shadcn/registry MCP) to render the final, on-brand version using real components and tokens.
   - Both stages **run/test in Vercel Sandbox** (ephemeral microVMs) and **deploy preview URLs into a shared Vercel project** (the team's shared space). Wireframe and final URLs are both tracked on the conversation + gallery so the iteration history is visible.
7. **Governance layer** — RBAC gates which tools/MCP/subagents a role may use, enforced through `canUseTool` + `permissionMode` + `allowedTools/disallowedTools`; audit via `PostToolUse` hooks; cost caps via `maxBudgetUsd` and `total_cost_usd` tracking.
8. **Evaluation layer** — a headless harness that runs the agent against scenario fixtures and scores trajectories/outputs (assertions + LLM-as-judge), with regression tracking in Postgres.

### Model strategy (decided): Claude brain + others as tools, routed by subagent specialization
- **Main loop stays Claude** (the engine is built around Anthropic tool-use/thinking — non-Claude main loops are fragile).
- **Routing across Claude tiers is done by subagent specialization:** each specialized subagent is pinned to the right tier + effort, and the orchestrator routes by delegating. E.g. `extractor → claude-haiku` (cheap/mechanical), `analyst → claude-sonnet`, `architect → claude-opus, effort:'high'`. Set via `AgentDefinition.model` (`'inherit'` to reuse parent).
- **Non-Claude models are exposed as tools, not as the brain:** a `tools` package wrapper (e.g. `ask_model({ model, prompt })`) calls other providers **through the LiteLLM proxy** (`models.thiga.co`) for specific subtasks; a Claude-driven agent decides when to call them. This gives multi-provider reach without destabilizing the agent loop.
- **Model names must match what the LiteLLM proxy exposes**; the main agent must point at a Claude model there. `fallbackModel` + `effort` available per query/subagent.
- **Design now, even in MVP:** `agent-core` treats `model` as a per-subagent parameter from day one (MVP uses a single Claude tier; tiers/tool-models are added without refactor).

### Data/flow seams to lock in now
- **One session = one conversation**, keyed by `sessionId` (UUID we mint), owned by a user, stored with metadata in Postgres; transcript JSONL on the worker's persistent volume / object storage.
- **Streaming**: web ↔ core over SSE; core consumes the `query()` async generator.
- **Identity**: Auth0 → app session → token broker → per-request MCP headers. Anthropic/LiteLLM key lives only on the core/worker, never in the browser.

---

## Repo Skeleton (Turborepo + pnpm)

```
product-agent/
├─ apps/
│  ├─ web/                 # Next.js App Router UI (Vercel), Auth0 login, chat + prototype gallery
│  └─ cli/                 # thin CLI client to the agent core
├─ packages/
│  ├─ agent-core/          # wraps @anthropic-ai/claude-agent-sdk query(); system prompt; session mgmt
│  ├─ tools/               # custom in-process tools (tool() + createSdkMcpServer); incl. ask_model wrapper for non-Claude models via LiteLLM
│  ├─ mcp/                 # MCP server registry + Auth0 token broker
│  ├─ memory/             # knowledge store + memory adapters (Postgres)
│  ├─ prototyper/          # Vercel Sandbox run/test + deploy-to-shared-project
│  ├─ auth/                # Auth0 + RBAC (roles, rights, policy map)
│  ├─ evals/               # eval harness + scenario fixtures
│  └─ shared/              # types, config, logging
├─ .claude/
│  ├─ skills/              # Agent Skills (SKILL.md per skill)
│  ├─ agents/              # subagent definitions (also definable programmatically)
├─ context/               # file-based context construction (Hermes-inspired), owned by packages/memory
│  ├─ soul.md             #   agent persona/behavior/goals → system prompt
│  ├─ user.md             #   what the agent learns about the user (agent-updatable)
│  └─ memory.md           #   durable notes/workflows/tool-tips/facts (agent-updatable)
├─ turbo.json
└─ package.json
```

> Optional accelerator: `npx next-forge@latest init` gives a production Turborepo to graft these packages onto — but it defaults to Clerk auth; we'd swap in Auth0. Recommendation: scaffold our own lean Turborepo to keep every piece understood; borrow next-forge patterns selectively.

---

## Key SDK reference (verified against current docs)

- **Entry point**: `query({ prompt, options })` returns an async generator of messages; `for await (const m of q)`.
- **System prompt**: `systemPrompt: { type: 'preset', preset: 'claude_code', append: '<persona>' }` or a fully custom string.
- **Model / effort**: `model: 'claude-opus-4-8'`, `fallbackModel`, `effort: 'high'`, `maxBudgetUsd`.
- **Custom tool**: `tool(name, desc, zodSchema, handler, { annotations })` → bundle with `createSdkMcpServer({ name, version, tools })` → register as `mcpServers: { x: { type: 'sdk', name, instance } }`.
- **Remote MCP w/ auth**: `mcpServers: { custom: { type: 'http', url, headers: { Authorization: 'Bearer <token>' } } }` (also `type: 'sse'`, `type: 'stdio'`).
- **Subagents**: `agents: { researcher: { description, prompt, tools, model, mcpServers, skills, memory } }`; invoked via the `Agent` tool (add `Agent` to `allowedTools`). Track output via `parent_tool_use_id`.
- **Hooks**: `hooks: { PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, ... }` with `{ matcher, hooks: [cb] }`.
- **Permissions**: `permissionMode` (`default|acceptEdits|plan|dontAsk|auto|bypassPermissions`), `allowedTools`, `disallowedTools`, and `canUseTool(toolName, input, opts)` returning `{ behavior: 'allow'|'deny', ... }`.
- **Sessions**: capture `session_id` from the `system/init` message; `resume`, `continue`, `forkSession`; `listSessions`, `getSessionMessages`, `renameSession`, `tagSession`.
- **Settings sources**: `settingSources: ['project']` to load only repo `.claude/` config; `[]` to fully isolate.
- **Skills**: `skills: ['name', ...] | 'all'`; loaded from `.claude/skills/*/SKILL.md`.
- **Structured output**: `outputFormat: { type: 'json_schema', schema }` → `msg.structured_output` (use for eval scoring and machine-readable prototype specs).
- **Custom endpoint (LiteLLM)**: pass `env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }` to point the engine at the proxy; the proxy must serve a Claude model in Anthropic format.

---

## Phased Roadmap (each phase runs end-to-end and teaches one concept)

**Phase 0 — Skeleton & "hello agent".** Scaffold the Turborepo. In `agent-core`, run `query()` from a CLI with a custom system prompt against a Claude model. *Done when:* `pnpm --filter cli dev` holds a multi-turn conversation.

**Phase 1 — Memory & sessions.** Wire `.claude/CLAUDE.md` (global), session capture/`resume`, and a Postgres-backed conversation store. *Done when:* a conversation resumes with full context after restart.

**Phase 2 — Custom tools & skills.** Add 1–2 in-process tools and 1 Agent Skill in `.claude/skills`. *Done when:* the agent calls your tool and a `/skill`.

**Phase 3 — MCP integration (SaaS first, then Auth0).** Connect one SaaS MCP, then one custom **HTTP MCP with a static bearer token**, then add the **Auth0 token broker** for per-user tokens. *Done when:* the agent reads real data from a protected custom server using the logged-in user's token.

**Phase 4 — Subagents & governance.** Define `researcher` + `prototyper` subagents (model-specialized); add RBAC enforced via `canUseTool` + role→tool/MCP policy; add `PostToolUse` audit hook and `maxBudgetUsd`. *Done when:* a low-rights user is blocked from a restricted tool, with an audit entry.

**Phase 5 — Prototyping & deploy (two stages).**
  - *5a — Wireframes:* `prototyper` generates a low-fidelity Next.js wireframe, runs/tests it in **Vercel Sandbox**, deploys a preview into the **shared Vercel project**; iterate over multiple rounds from team feedback. *Done when:* "wireframe X" yields a live, iterable preview URL.
  - *5b — Final via design system:* after approval, the agent calls a **design-system MCP server** (Figma / shadcn / custom registry) to produce the high-fidelity, on-brand prototype; deploy + track alongside its wireframe lineage. *Done when:* an approved wireframe is upgraded to a styled prototype using real design-system components.

**Phase 6 — Hosted web app.** Next.js UI: Auth0 login, org/roles, chat with SSE streaming, prototype gallery. Agent core runs as a persistent worker; web app is the thin client. *Done when:* a teammate logs in and uses the agent end-to-end.

**Phase 7 — Evaluation harness.** `evals` package runs the agent headlessly over scenario fixtures (assertions + LLM-as-judge via `outputFormat`), stores scores, flags regressions in CI. *Done when:* `pnpm eval` produces a scored report and fails CI on regression.

---

## Open decisions (sensible defaults; confirm or override)
- **DB**: **MVP uses local SQLite** for full conversation persistence. The hosted phase graduates to Postgres (Neon via Vercel Marketplace) for users/roles/conversations/audit/eval results; Vercel Blob for prototype artifacts.
- **Anthropic access**: org **LiteLLM proxy** at `https://models.thiga.co`, main model `claude-opus-4.8` (pending the `/v1/messages` gate).
- **First SaaS MCP**: Notion (or Linear/Atlassian/Confluence/Granola).
- **Monorepo**: hand-rolled Turborepo + pnpm (vs. next-forge accelerator).

---

## ▶ MVP (the first thing we build — a subset of the above)

**Goal:** smallest end-to-end thread that proves the knowledge backbone and teaches the agent core, memory, and MCP — no UI, no auth, no prototyping yet.

**Scope (decided):**
- **Interface:** CLI only (`apps/cli`).
- **Capability:** a **product-knowledge agent** — agent core + memory + **one SaaS MCP** (default **Notion**; swappable via the MCP registry) to answer product questions from real team data.
- **Users:** just you, **no Auth0 / no RBAC** yet.
- **Claude access:** the org **LiteLLM proxy** at `https://models.thiga.co`, wired via the SDK `env` option (`ANTHROPIC_BASE_URL=https://models.thiga.co` + `ANTHROPIC_API_KEY=<litellm key>`). Confirmed available Claude IDs (dotted): `claude-opus-4.8`, `claude-opus-4.6`, `claude-sonnet-4.6`, `claude-haiku-4.5`.
- **⚠ Gate:** the proxy's `/v1/models` is OpenAI-format; we must verify it also serves the **Anthropic Messages API** (`POST /v1/messages`) that the SDK engine calls. If not enabled → ask platform team to enable LiteLLM's Anthropic endpoint, or add a thin Anthropic→OpenAI adapter.
- **Model:** start on `claude-opus-4.8` (single tier), but `agent-core` treats `model` as a per-subagent parameter from day one. The proxy's non-Claude models (`gemini-3.1-pro-preview`, `gpt-5.5`, `grok-4.3`, `deepseek-r1`, `qwen3-coder`, …) are reachable later via the `ask_model` tool over the proxy's OpenAI endpoint.
- **Context construction (Hermes-inspired):** a `context/` dir with **`soul.md`** (persona → system prompt), **`user.md`** (agent-learned user facts), **`memory.md`** (durable notes) — loaded by `packages/memory`, with a `remember()` tool to update `user.md`/`memory.md`.
- **CLI presentation:** chat REPL only for now, with an **original ASCII-art logo banner** on startup (product working name **Hemiunu**). Per Anthropic branding rules, the banner must be our own art — not a copy of Claude Code's.

**MVP repo:** scaffold the full Turborepo skeleton, but implement only `packages/agent-core`, `packages/memory` (incl. the **SQLite** conversation store), `packages/mcp` (one server), and `apps/cli`. Other packages stay as stubs.

**Repo hygiene (hard rule):** keep the folder **minimal and clean** — no scaffolding cruft, no unused boilerplate, no generated junk committed. Every file must earn its place; prune anything a generator adds that we don't use. `.gitignore` covers `node_modules`, build output, `*.db`, and secrets.

**Conversation persistence:** **SQLite** (via `packages/memory`) stores **full conversations** — every message + session metadata (id, title, created_at, model, cost) — so a session can be listed, resumed, and replayed entirely. This is our own durable store; the SDK's JSONL session files remain the engine's working state.

**MVP steps:**
- **M0 — Engine + proxy (the gate).** Scaffold Turborepo; run `query()` from the CLI against the proxy (`env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_API_KEY`, `model: 'claude-opus-4.8'`). **Verify a real turn completes via the Anthropic `/v1/messages` format** before doing anything else; if it fails, resolve per the ⚠ Gate above. *Done when:* a CLI conversation works through `models.thiga.co`.
- **M1 — Persona + memory + sessions.** Product-Agent system prompt, always-on org context loaded from project-root **`memory.md`** (read by `packages/memory`, injected via `systemPrompt.append`), session capture + `resume`, **SQLite** store persisting full conversations (messages + session metadata). Add the **ASCII logo banner** on CLI startup. *Done when:* a conversation resumes with full context after restart and the banner shows.
- **M2 — One SaaS MCP.** Connect Notion (remote HTTP/SSE, OAuth) through the `mcp` registry; agent answers questions grounded in real Notion data. *Done when:* a product question pulls a correct answer from Notion.
- **M3 — CLI polish + smoke eval.** Streaming output, `list/resume` sessions, cost display (`total_cost_usd`); one scenario smoke test in `packages/evals`. *Done when:* `pnpm eval` runs one scenario green.

**Explicitly deferred to post-MVP:** web app, Auth0/RBAC, custom Auth0-protected MCP, subagents, wireframe→design-system prototyping, full eval harness.

---

## Verification (how we'll prove each phase works)
- **Per phase**: each phase has an explicit "Done when" runnable check (CLI conversation, resumed session, tool call, protected-MCP read, RBAC block + audit entry, live preview URL, scored eval report).
- **Agent behavior**: drive `agent-core` via the CLI and assert on the message stream + `result`/`structured_output`.
- **MCP/Auth0**: log in as a test user, confirm the token broker mints a scoped token and the agent reads protected data; confirm a second user with fewer rights is denied.
- **Prototyping**: trigger a prototype request; confirm Vercel Sandbox test run passes and a preview URL resolves in the shared project.
- **Evals**: `pnpm eval` over fixtures returns pass/fail + judge scores; wire into CI to gate regressions.
