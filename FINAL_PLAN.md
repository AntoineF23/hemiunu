# Hemiunu — Product Agent: Final Plan

> **Status:** This is the **FINAL product vision**. Implementation starts with an **MVP** (a deliberately small subset, now built — see the MVP section). This file is the canonical reference; build-status notes are inline.

## The thesis

**Hemiunu is a product-team agent that turns a team's shared product knowledge into validated, near-production prototypes and engineer-ready specs.** It:

1. **Grounds itself in the team's shared product knowledge** by connecting to many MCP servers — the source of truth for the product (Notion, Linear, Slack, Atlassian, analytics, design systems, the codebase…). Knowledge is pulled **on demand** into context, never duplicated.
2. **Proposes and builds wireframes for new features**, informed by deep **design knowledge** and **web research** so the ideas it puts forward are the *best* available, not just the obvious ones.
3. **Upgrades an approved wireframe to a near-production prototype** by consuming a **design-system MCP server** so the result is on-brand and component-accurate.
4. **On product-team approval, produces technical + feature specs** to hand to engineers alongside the prototype, so the feature can be built.

Every step feeds back into the team's shared knowledge, so the agent gets more useful to the whole team the more it is used. The entire product is built around **teams sharing knowledge to improve the product**.

Built on the **Claude Agent SDK for TypeScript** (`@anthropic-ai/claude-agent-sdk`), backed by long-term **memory**, a managed **active context**, **tools**, **skills**, **subagents**, **hooks/harnesses**, **evaluations**, and **multi-user org access with roles** — delivered ultimately as a **hosted web app** with per-user login. The intent is to build this **slowly and master every piece**.

---

## The core loop

This is the spine of the product. Each `✋` is an explicit human-validation gate — the team stays in control of what advances.

```
   ┌──────────────────────── shared team knowledge ◄────────────────────────┐
   │            (many MCP servers as source of truth + team store)           │
   ▼                                                                         │
 idea / brief ──► wireframe ──✋──► hi-fi prototype ──✋──► specs ──► engineers ──► shipped
 (Stage A: design     (low-fi,    (Stage B: design-     (Stage C: tech +    build the   feature
  knowledge +         validate     system MCP, near-     feature specs,      feature
  web research)       & iterate)   production, validate)  design-system            └────────────► (feeds knowledge)
                                                          as contract)
```

The loop is **closed**: shipped features, validated prototypes, and the decisions made along the way flow back into the team context, so the next idea starts from more knowledge than the last.

---

## The context model — four homes, assembled on demand

Context is assembled each turn from minimal, explicit files in a project-owned **`context/`** directory (NOT the auto-loaded `CLAUDE.md` convention — *we* control exactly what's in context). It is **Hermes-inspired**: small, explicit, agent-maintained. There are four kinds of context:

1. **Soul context** — `context/soul.md`: the agent's persona, tone, goals, behaviour, and design judgment → used as the **system prompt** (Hemiunu's identity). Ships with the app; falls back to a default if empty. *(built)*
2. **User context** — global `~/.hemiunu/user.md`: what the agent has learned about the **individual** using it (role, team, stable preferences), carried into every project. Agent-updatable via `remember(target:"user")`; seeded empty from the committed `user.md.example` on first run. *(built)*
3. **Team context** — the shared knowledge layer, in two parts:
   - **(a) On-demand from shared MCP sources** — the team's MCP servers (Notion, Linear, Slack, Atlassian, analytics, the codebase…) are the **source of truth**; the agent retrieves from them per turn and never copies them into a local store.
   - **(b) A durable team store** — product facts/decisions and **per-feature prototype context** (the brief, wireframe/prototype lineage, validation status, links). Today this is the per-project `HEMIUNU.md` at the root of the launch folder, agent-updatable via `remember(target:"memory")`. It **graduates to a shared, multi-user store** (Postgres) in the hosted phase, so a whole team reads from and writes to the same memory and the prototype context for a feature is visible to everyone working on it. *(partial today → hosted-phase target)*
4. **Skill context** — reusable `SKILL.md` procedures in `~/.hemiunu/skills/` (canonical Claude skill format: YAML frontmatter + instruction body). Each skill's `description` is surfaced to the agent (metadata only) so it can recognise when a request matches; the full body loads only when the skill runs. Includes the prototyping/spec procedures. *(built)*

**Auto-appended each turn:** recent **message history** (SDK session JSONL with automatic compaction, `resume`/`fork`), **tool & skill descriptions** (from the SDK), and — when configured — **relevant external memory** (vector/RAG; later phase).

`packages/memory` owns loading `context/*.md` (`soul.md` as the system prompt; `user.md` + the team store injected via `systemPrompt.append`) and the **`remember()` tool** that writes back to user/team context. Durable per-user/team storage graduates to Postgres in the hosted phase (the SDK `agent.memory: 'user' | 'project'` field is also available).

---

## The knowledge backbone — MCP servers as the source of truth

The team's knowledge lives in **many MCP servers**, and the agent pulls from them on demand. This is the foundation everything else stands on: the better the connected sources, the better the ideas, wireframes, prototypes, and specs.

- **A registry** maps logical servers → configs (`packages/mcp`, loaded from `mcp.json`; user servers in `~/.hemiunu/mcp.json` merge over the app defaults). `stdio`, `http`, and `sse` transports; `${ENV}` interpolation for secrets; `${CWD}` for the launch dir; auto-skip when a server is `disabled` or its env is unset.
- **SaaS servers** — Notion, Linear, Slack, Figma, Atlassian/Confluence, Granola, analytics, etc. Today's default set: Notion (read), filesystem (the launch project), Tavily (web search).
- **Custom Auth0-protected servers** via `{ type: 'http', url, headers: { Authorization: 'Bearer <token>' } }`. A **token broker** exchanges the user's Auth0 session for downstream MCP access tokens (per-user, least-privilege). *(deferred; see `OAUTH_PLAN.md`)*
- **Web research is part of the backbone**, not a side concern — the Tavily MCP gives the agent public/current/external knowledge (competitor moves, market data, design patterns, standards) to weigh against the team's own sources when proposing ideas.
- **The design-system MCP is part of the backbone too** — **whatever design system the team connects via an MCP server**: Figma, shadcn, a custom component registry, or any in-house design system exposed over MCP. The pipeline is design-system-agnostic; it reads the connected DS's components, tokens, and guidelines. This is what makes Stage B prototypes on-brand and component-accurate.

### From pointers to synthesized memory (planned — see MVP_PLAN M4)
Today the agent reaches sources two ways: live, on demand (search/read per turn) and via **source maps** — per-MCP pointer indexes of *where* things live (`packages/agent-core/src/sources.ts`, refreshed by `/scan`). What's still missing for the "shared context built from all your apps" promise is an **aggregation/synthesis layer**: a triggered/periodic ingestion that pulls the *substance* across many sources (Notion + Slack + Linear + Granola + Intercom …) into the feature's `PROTOTYPE.md` (or a richer store) as structured, **attributed, time-stamped** notes — so a feature's shared memory accrues automatically instead of being re-discovered each turn. This is the highest-leverage post-MVP investment; design it before building (provenance, freshness/staleness, and de-duplication are the hard parts).

---

## The prototyping pipeline (the product's centerpiece)

Three stages, each with a human-validation gate before it advances. The team iterates cheaply early and commits expensive fidelity only to ideas that have been approved.

### Stage A — Knowledge-grounded wireframes (low-fidelity, fast iteration)

The pipeline is **research → brief → wireframe → preview → iterate**, with a structured **brief** as the grounding intermediate: *goal · primary user + JTBD · entities · screens/sections/components · real content.*

Two inputs make the ideas good, not just present:
- **Deep design knowledge** — `context/knowledge/design.md` (Apple's 8 principles of great design) is injected into the `prototyper` subagent so every wireframe is shaped by real design judgment; a compact digest lives in `soul.md` so the main loop gives grounded design *advice* without paying the full doc's tokens each turn.
- **Web research** — the agent uses web search (Tavily) to benchmark patterns, study how the best products solve the problem, and propose improvements — so it brings the *best* ideas to the brief, weighed against the team's own sources.

> **BUILT (Slice 3a, 2026-06-22) — Stage A wireframes, first slice.** The `researcher` fills brief slots from the sources; the **`prototyper`** subagent (synthesis tier) turns the brief into a **self-contained low-fi HTML wireframe** (grayscale, real labels, inline CSS, no external requests) and saves it via the **`save_prototype`** tool (`packages/agent-core/src/prototype.ts`): writes under `prototypes/<slug>/` with a path-traversal guard, then opens `index.html` in the browser (suppressed by `HEMIUNU_NO_OPEN`). Exported pure `savePrototype()` is smoke-tested (sandbox + traversal). CLI shows `⌂ prototyper · <model>` and a "Prototyping" status. soul.md carries the two-step flow. **Decision: low-fi = HTML** (fastest iteration; design system enters at Stage B). **Architectural finding:** a subagent's tools do NOT need to be in the parent `tools` allowlist (registration + `AgentDefinition.tools` suffices, verified via `allowedTools`) — so a later refinement can hide `save_prototype` from the main loop to *force* delegation. **Not yet:** multi-screen + flows, screenshot self-critique, Vercel Sandbox run/deploy.
>
> **Knowledge layer (2026-06-22):** domain guidelines live in `context/knowledge/<topic>.md` (tracked, not per-user). First entry: `design.md`. `subagents.ts` `subagentPrompt(name)` injects the relevant doc into a subagent's system prompt — the `prototyper` carries the full design guideline (noting visual Craft/Delight apply at hi-fi, not the low-fi stage). This is the pattern for "knowledge for every part of the product" — add `eng.md`, `data.md`, etc. and wire them to the relevant subagent/skill.

*Validation gate:* the team reacts to the live wireframe and iterates over multiple rounds before any visual polish.

### Stage B — Near-production prototype via the design-system MCP

Once a wireframe is approved, the agent consumes **whatever design-system MCP server the team has connected** to render the high-fidelity, on-brand version using **real components and tokens** — almost production-ready. The stage is **design-system-agnostic**: it reads the connected DS's components, tokens, fonts, and guidelines and builds against them (e.g. React + TypeScript + Tailwind, or whatever the DS prescribes), with no hand-rolled markup or guessed values. The DS could be Figma, shadcn, a custom registry, or an in-house design system exposed over MCP — the team picks.

> **Status:** the **pattern is proven** — a design-system MCP can be connected and read at session time. Remaining work: wire the **approve-wireframe → build-hi-fi** handoff into the pipeline (a `designer`/hi-fi prototyper subagent that reads the approved brief + wireframe and builds against *whichever* DS MCP is connected), and run/test in **Vercel Sandbox** + deploy a preview into the **shared Vercel project**.

*Validation gate:* the product team reviews the near-production prototype and approves it (or sends it back).

### Stage C — Engineer-ready specs (the handoff)

On prototype approval, the agent produces **technical + feature specifications** to send to engineers **alongside the prototype**, so the feature can be built. The specs are **one Markdown file per user journey**, design-system-as-contract, framework-agnostic — exhaustive and self-contained (the dev team is assumed not to have the prototype in hand).

> **Status — half-built.** The **`prototype-delivery-spec` skill** already generates this: a fixed **DELIVERY + DISCOVERY** structure per journey from a validated prototype — navigation diagram, screen-by-screen breakdown (states, validations, copy, CTAs, errors), cross-cutting rules tables from the prototype's data source of truth, anti-rules/guardrails, framework-neutral front-end (DS components per screen, example JSON returns), acceptance criteria, annexes. Remaining work: invoke it as the explicit Stage-C step in the pipeline and (hosted phase) attach the generated specs to the conversation + prototype gallery.

*Output:* prototype preview URL + per-journey specs, handed to engineering.

> Across all stages, prototypes **run/test in Vercel Sandbox** (ephemeral microVMs) and **deploy preview URLs into a shared Vercel project** (the team's shared space). Wireframe, hi-fi, and spec artifacts are all tracked on the conversation + gallery so the iteration history — and the per-feature prototype context — is visible to the whole team.

---

## Architecture layers (supporting the core loop)

Eight layers, each mapping to a package; ordered to follow the loop.

1. **Access layer** — Next.js (App Router) hosted web UI on Vercel + a thin CLI. Streams agent output (SSE). Per-user login via **Auth0** (organization + roles).
2. **Agent core** — a long-lived Node service wrapping the SDK's `query()`. One SDK session per conversation. Holds the Hemiunu system prompt, **multi-model strategy** (below), permission policy, hooks, and the tool/skill/MCP/subagent wiring.
3. **Context & memory** — the **four-home context model** above (soul/user/team/skill) + the durable **team store**, owned by `packages/memory`; `remember()` writes user/team context; graduates to Postgres in the hosted phase.
4. **Knowledge backbone (MCP)** — the registry + token broker described above; many MCP servers as the team's source of truth, pulled on demand.
5. **Tools, skills & subagents** — in-process custom tools via `tool()` + `createSdkMcpServer({ type: 'sdk' })`; **Agent Skills** in `~/.hemiunu/skills/`; specialized **subagents** (`researcher`, `prototyper`, and planned `designer`/`spec-writer`/`evaluator`) via the `agents` option.
6. **Prototyping pipeline** — the three-stage flow (A wireframe → B design-system hi-fi → C specs) with Vercel Sandbox run/test and shared-preview deploy.
7. **Governance layer** — RBAC gates which tools/MCP/subagents a role may use, enforced via `canUseTool` + `permissionMode` + `allowedTools/disallowedTools`; audit via `PostToolUse` hooks; cost caps via `maxBudgetUsd` and `total_cost_usd`. Matters most once multiple teams share one agent.
8. **Evaluation layer** — a headless harness that runs the agent against scenario fixtures and scores trajectories/outputs (assertions + LLM-as-judge), with regression tracking.

### Two foundational constraints (drive the design)
- **Anthropic auth ≠ user auth.** Third-party products may **not** use claude.ai login (per the Agent SDK docs). The app authenticates to Claude with the org's own API key (Anthropic direct, or an Anthropic-compatible gateway/proxy such as LiteLLM at `models.thiga.co`) or Bedrock/Vertex/Azure. **Auth0** is solely for *your team members logging into your product*. Keep these two identity planes separate.
- **The agent loop needs persistent compute.** The SDK stores sessions as JSONL on the filesystem and a turn can run for minutes. Run the **agent core on a long-lived worker/container** (not a short serverless function). The Next.js app is a thin client that streams from it. (Future option: swap the core for Anthropic **Managed Agents** REST API.)

### Model strategy (decided): Claude brain + others as tools, routed by subagent specialization

> **BUILT (Slice 1, 2026-06-22):** the first specialized subagent — **`researcher`** — and **model tiers** are live. `agent-core` registers a `researcher` `AgentDefinition` scoped to the connected MCP source tools and pinned to a cheaper retrieval tier (`HEMIUNU_MODEL_RESEARCH`, default `claude-sonnet-4.6`); the main/synthesis loop runs on `HEMIUNU_MODEL` and delegates retrieval to it. soul.md steers delegation; the CLI surfaces it (`⌂ researcher · sonnet` + indented `⌕` source calls); a smoke check asserts delegation + grounding. Verified: subagents inherit the parent's MCP tools, and `canUseTool` still gates their tool calls. **Caveat — `claude-haiku-4.5` is NOT usable** as a tier through the proxy: the SDK always sends an `effort` param that haiku rejects (`thinking:'disabled'` doesn't suppress it). So the cheap tier is Sonnet until we can omit `effort` (SDK lever) or the proxy ignores it for haiku.
>
> **BUILT (Slice 2, 2026-06-22):** the **`ask_model`** tool — non-Claude models as tools. An in-process SDK MCP server (`hemiunu-models`) exposes `ask_model({ provider, model, prompt, system?, max_tokens? })`, a one-shot call via each provider's OpenAI-compatible endpoint. Always available + permission-gated; the Claude main loop stays the brain and integrates the result. Core extracted as an exported `askModel()` for a deterministic smoke check. Reasoning models need headroom — default `max_tokens` 2000.
>
> **UPDATED (2026-06-22) — bring-your-own providers.** Decoupled from any one proxy. The **brain** defaults to **Anthropic direct** (`ANTHROPIC_BASE_URL` optional — set it for a gateway/proxy). **`ask_model` is provider-aware** (`packages/agent-core/src/providers.ts`): provider ∈ `openai|google|groq|xai|deepseek|mistral|proxy`, each an OpenAI-compatible endpoint resolving its key from a per-provider env var with an optional `<PROVIDER>_BASE_URL` override. Missing key → a helpful "add `X_API_KEY`" message with NO network call. The brain needs only an Anthropic key.
>
> **BUILT (Slice 3b, 2026-06-22) — parallel execution.** Subagents give context isolation, but **the models will NOT fan out `Task` calls themselves** — verified: both Sonnet and Opus dispatch subagents one-per-turn even when told to parallelise. Parallelism is therefore done in **deterministic code**: `subagents.ts` centralises the subagent specs as the single source for both the SDK `agents` map and an exported `runSubagent(name, prompt, ctx)`; `orchestrator.ts` exposes a **`parallel`** tool (`hemiunu-orchestrator`) taking `tasks: [{agent, prompt, label?}]` and running them through a bounded `pool()` (cap 5, order-preserving) concurrently, returning merged labelled results. The fan-out is real (3 researcher runs in ~1× the slowest task's wall-clock). Sub-runs auto-approve their already-scoped tools; the gate is approving the `parallel` call. Recursion prevented by not giving sub-runs the orchestrator/Task tools. **Limitation:** sub-run inner tool calls don't stream to the CLI.

- **Main loop stays Claude** — the engine is built around Anthropic tool-use/thinking; non-Claude main loops are fragile.
- **Routing across Claude tiers is done by subagent specialization** — each specialized subagent is pinned to the right tier + effort, and the orchestrator routes by delegating. E.g. `researcher → sonnet` (cheap retrieval), `prototyper/designer → synthesis tier`, an `architect → opus, effort:'high'`. Set via `AgentDefinition.model` (`'inherit'` to reuse parent).
- **Non-Claude models are exposed as tools, not as the brain** — `ask_model` calls other providers for specific subtasks; Claude decides when.
- **Design now, even in MVP:** `agent-core` treats `model` as a per-subagent parameter from day one.

### Data/flow seams to lock in now
- **One session = one conversation**, keyed by `sessionId` (UUID), owned by a user, stored with metadata; transcript JSONL on the worker's persistent volume.
- **Streaming:** web ↔ core over SSE; core consumes the `query()` async generator.
- **Identity:** Auth0 → app session → token broker → per-request MCP headers. The Anthropic key lives only on the core/worker, never in the browser.

---

## Repo skeleton (Turborepo + pnpm)

```
hemiunu/
├─ apps/
│  ├─ web/                 # Next.js App Router UI (Vercel), Auth0 login, chat + prototype gallery
│  └─ cli/                 # thin CLI client to the agent core (BUILT — the MVP)
├─ packages/
│  ├─ agent-core/          # wraps query(); system prompt; subagents; ask_model; parallel; prototype
│  ├─ memory/              # four-home context loader + remember() + SQLite store (→ Postgres team store)
│  ├─ mcp/                 # MCP registry (the knowledge backbone) + Auth0 token broker (deferred)
│  ├─ prototyper/          # (planned) Vercel Sandbox run/test + deploy-to-shared-project
│  ├─ auth/                # (planned) Auth0 + RBAC
│  ├─ evals/               # eval harness + scenario fixtures
│  └─ shared/              # types, config, logging
├─ .claude/skills/         # (also ~/.hemiunu/skills/) Agent Skills incl. prototype-delivery-spec
├─ context/                # the four context homes
│  ├─ soul.md              #   SOUL context → system prompt
│  ├─ user.md.example      #   USER context template (global user.md lives in ~/.hemiunu)
│  ├─ knowledge/*.md       #   shared domain knowledge (design.md; add eng.md, data.md…)
│  └─ (HEMIUNU.md)         #   TEAM context store, per-project today → shared Postgres store later
├─ turbo.json
└─ package.json
```

---

## Key SDK reference (verified against current docs)

- **Entry point**: `query({ prompt, options })` returns an async generator; `for await (const m of q)`.
- **System prompt**: `systemPrompt: { type: 'preset', preset: 'claude_code', append: '<persona>' }` or a fully custom string.
- **Model / effort**: `model: 'claude-opus-4-8'`, `fallbackModel`, `effort: 'high'`, `maxBudgetUsd`.
- **Custom tool**: `tool(name, desc, zodSchema, handler, { annotations })` → `createSdkMcpServer({ name, version, tools })` → register as `mcpServers: { x: { type: 'sdk', name, instance } }`.
- **Remote MCP w/ auth**: `mcpServers: { custom: { type: 'http', url, headers: { Authorization: 'Bearer <token>' } } }` (also `sse`, `stdio`).
- **Subagents**: `agents: { researcher: { description, prompt, tools, model, mcpServers, skills, memory } }`. **Verified:** the delegate tool's canonical id is **`Task`**; subagents inherit the parent's registered MCP tools (filter via `AgentDefinition.tools`); their tool calls still pass through `canUseTool`. Track output via `parent_tool_use_id`.
- **Hooks**: `hooks: { PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, ... }`.
- **Permissions**: `permissionMode`, `allowedTools`, `disallowedTools`, `canUseTool(toolName, input, opts)` → `{ behavior: 'allow'|'deny' }`.
- **Sessions**: capture `session_id` from `system/init`; `resume`, `continue`, `forkSession`; `listSessions`, `getSessionMessages`, `renameSession`, `tagSession`.
- **Settings sources**: `settingSources: ['project']` to load repo `.claude/` config; `[]` to fully isolate.
- **Skills**: `skills: ['name', ...] | 'all'`; loaded from `.claude/skills/*/SKILL.md`.
- **Structured output**: `outputFormat: { type: 'json_schema', schema }` → `msg.structured_output` (use for eval scoring and machine-readable prototype specs).
- **Custom endpoint**: pass `env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }` to point the engine at a gateway serving Claude in Anthropic format.

---

## Phased roadmap (each phase runs end-to-end and teaches one concept)

**Phase 0 — Skeleton & "hello agent".** Scaffold the Turborepo; run `query()` from a CLI with a custom system prompt against a Claude model. *Done when:* `pnpm --filter cli dev` holds a multi-turn conversation. **✅ BUILT.**

**Phase 1 — Memory & sessions.** The four-home context model, session capture/`resume`, a SQLite-backed conversation store. *Done when:* a conversation resumes with full context after restart. **✅ BUILT.**

**Phase 2 — Custom tools & skills.** In-process tools + Agent Skills. *Done when:* the agent calls your tool and a `/skill`. **✅ BUILT** (`remember`, `ask_model`, `save_prototype`, `save_skill`; skills in `~/.hemiunu/skills/`).

**Phase 3 — Knowledge backbone (SaaS first, then Auth0).** Connect SaaS MCPs (Notion, filesystem, Tavily), then a custom **HTTP MCP with a static bearer token**, then the **Auth0 token broker** for per-user tokens. *Done when:* the agent reads real data from a protected custom server using the logged-in user's token. **Partial:** SaaS MCPs + web search connected; token broker deferred (`OAUTH_PLAN.md`).

**Phase 4 — Subagents & governance.** `researcher` + `prototyper` (model-specialized); RBAC via `canUseTool` + role→tool/MCP policy; `PostToolUse` audit hook + `maxBudgetUsd`. *Done when:* a low-rights user is blocked from a restricted tool, with an audit entry. **Partial:** subagents + tiers + `parallel` built; RBAC, audit hooks, budget caps remain.

**Phase 5 — The prototyping pipeline (three stages).**
  - *5a — Wireframes:* `prototyper` generates a low-fi wireframe grounded in design knowledge + web research; iterate from team feedback; run/test in Vercel Sandbox; deploy a preview. *Done when:* "wireframe X" yields a live, iterable preview URL. **Partial:** wireframe generation + save + open built; Sandbox run + shared deploy remain.
  - *5b — Hi-fi via design system:* on approval, a `designer` subagent calls **whichever design-system MCP the team has connected** (Figma / shadcn / a custom or in-house registry) to produce the near-production prototype; deploy + track alongside its wireframe lineage. *Done when:* an approved wireframe is upgraded to a styled prototype using real DS components. **Pattern proven:** build the approve→hi-fi handoff against the connected DS MCP.
  - *5c — Engineer specs:* on prototype approval, generate per-journey technical + feature specs (the `prototype-delivery-spec` skill) and hand them to engineering with the prototype. *Done when:* an approved prototype yields self-contained specs per journey. **Half-built:** skill exists; integrate as the explicit pipeline step.

**Phase 6 — Hosted web app + shared team store.** Next.js UI: Auth0 login, org/roles, SSE chat, prototype gallery. Agent core as a persistent worker. **Graduate the team context store to shared Postgres** so a whole team reads/writes the same memory and prototype context. *Done when:* a teammate logs in, uses the agent end-to-end, and sees another teammate's prototype context.

**Phase 7 — Evaluation harness.** `evals` runs the agent headlessly over fixtures (assertions + LLM-as-judge via `outputFormat`), stores scores, flags regressions in CI. *Done when:* `pnpm eval` produces a scored report and fails CI on regression. **Partial:** one smoke scenario built.

---

## Open decisions (sensible defaults; confirm or override)
- **DB**: **MVP uses local SQLite** for full conversation persistence; the hosted phase graduates to **Postgres** (Neon via Vercel Marketplace) for users/roles/conversations/audit/eval results **and the shared team store**; Vercel Blob for prototype artifacts.
- **Anthropic access**: Anthropic direct by default; org gateway (LiteLLM at `https://models.thiga.co`) optional via `ANTHROPIC_BASE_URL`.
- **Design-system MCP**: pluggable — any design system the team connects over MCP (Figma, shadcn, a custom or in-house registry). The pipeline is DS-agnostic; teams bring their own.
- **Monorepo**: hand-rolled Turborepo + pnpm (next-forge patterns borrowed selectively).

---

## Distribution & onboarding (BUILT, 2026-06-22)

How users get and configure Hemiunu without cloning/editing files:
- **One-line install:** `curl -fsSL https://raw.githubusercontent.com/AntoineF23/hemiunu/main/install.sh | bash` (public repo). `install.sh` checks Node 24+, clones to `~/.hemiunu/app`, `corepack pnpm install` (tolerates pnpm's harmless ignored-builds exit, verifies `tsx` runs), symlinks `~/.local/bin/hemiunu` → `bin/hemiunu.mjs`. Re-run to update.
- **`hemiunu` command:** the launcher resolves the install dir from its own location, sets `HEMIUNU_HOME`, runs the CLI with the caller's cwd preserved.
- **User config separate from code (`~/.hemiunu/`):** keys in `~/.hemiunu/.env`, user MCP servers in `~/.hemiunu/mcp.json` (merged over the app default by `loadMcpRegistry(home, userPath)`). Updates never clobber config. `.env` resolution: `~/.hemiunu/.env` → `HEMIUNU_HOME/.env` → cwd.
- **First-run setup:** if no real key, the CLI shows an Ink prompt for the API key (masked) + optional gateway/Notion/Tavily, writes `~/.hemiunu/.env` via `writeUserEnv()`. `hasApiKey()` gates it; `/setup` shows the config path + which keys are set.
- **Better URL (TODO):** point a custom domain (e.g. `hemiunu.sh/install`) at the raw `install.sh` via a Vercel/Cloudflare rewrite.

---

## ▶ MVP (the first thing we built — a subset of the above)

**Goal:** smallest end-to-end thread that proves the knowledge backbone and teaches the agent core, memory, and MCP — no UI, no auth, no Stage B/C prototyping yet.

**Scope (built):**
- **Interface:** CLI only (`apps/cli`).
- **Capability:** a **product-knowledge agent** — agent core + memory + **SaaS MCPs** (Notion default; filesystem; Tavily web search) to answer product questions from real team data, plus Stage-A wireframes.
- **Users:** just you, **no Auth0 / no RBAC** yet.
- **Claude access:** Anthropic direct or any Anthropic-compatible gateway via `ANTHROPIC_BASE_URL`.
- **Context construction:** the four-home model — `soul.md`, global `user.md`, per-project `HEMIUNU.md` (team store), `~/.hemiunu/skills/` — loaded by `packages/memory`, with `remember()` to update user/team context.
- **CLI presentation:** chat REPL with an **original ASCII-art pyramid banner** on startup (per Anthropic branding rules, our own art).

**MVP packages built:** `packages/agent-core`, `packages/memory` (incl. the **SQLite** conversation store), `packages/mcp`, and `apps/cli`. Other packages stay stubs.

**Repo hygiene (hard rule):** keep the folder minimal and clean — no scaffolding cruft, no unused boilerplate, no generated junk committed. `.gitignore` covers `node_modules`, build output, `*.db`, and secrets.

**MVP steps (all done):**
- **M0 — Engine.** `query()` from the CLI against the brain (Anthropic direct or gateway), a real turn completes.
- **M1 — Persona + memory + sessions.** System prompt from `soul.md`, context homes loaded, session capture + `resume`, SQLite store, ASCII banner.
- **M2 — SaaS MCP.** Notion (+ filesystem, Tavily) through the registry; answers grounded in real data.
- **M3 — CLI polish + smoke eval.** Streaming, `list/resume`, cost display, one scenario smoke test.

**Beyond the original MVP, also built:** researcher subagent + model tiers, `ask_model`, `parallel` orchestrator, Stage-A wireframes, skills, and the one-line installer.

**Still deferred:** web app, Auth0/RBAC, custom Auth0-protected MCP + token broker, Stage B (design-system hi-fi handoff) + Stage C (specs handoff) wired into the pipeline, Vercel Sandbox run/deploy, shared Postgres team store, full eval harness.

---

## Verification (how we prove each phase works)
- **Per phase**: each has an explicit "Done when" runnable check (CLI conversation, resumed session, tool call, grounded MCP read, RBAC block + audit entry, live preview URL, per-journey specs, scored eval report).
- **Agent behavior**: drive `agent-core` via the CLI and assert on the message stream + `result`/`structured_output`; `pnpm smoke` runs offline structural checks + one live turn.
- **Knowledge/Auth0**: confirm answers are grounded in connected sources; (later) log in as a test user, confirm the token broker mints a scoped token and a lower-rights user is denied.
- **Prototyping pipeline**: Stage A — a request yields an iterable wireframe preview; Stage B — an approved wireframe upgrades to a DS-accurate prototype via the design-system MCP; Stage C — an approved prototype yields self-contained per-journey specs.
- **Evals**: `pnpm eval` over fixtures returns pass/fail + judge scores; wire into CI to gate regressions.
