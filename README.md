<div align="center">

<img src="assets/tallestbuildings.webp" alt="The tallest structures humans have ever built through history, the Great Pyramid of Giza among them: built to last, tallest and longest-standing." width="820">

<em>The tallest structures we have ever built. The Great Pyramid stands among them: for nearly 4,000 years it was the tallest of all, and forty-five centuries on it is still standing.</em>

[![CI](https://github.com/AntoineF23/hemiunu/actions/workflows/ci.yml/badge.svg)](https://github.com/AntoineF23/hemiunu/actions/workflows/ci.yml)

</div>

## Meet Hemiunu

Hemiunu was the architect of the Great Pyramid of Giza (around 2560 BCE). What he
built was the tallest structure humankind would raise for nearly four thousand
years, and it still stands today, forty-five centuries later.

Hemiunu (the agent) is a **product agent for product teams**, and its purpose is
the same as its namesake's: to help you build things that last the way the Great
Pyramid has lasted. Using it, a product team becomes the great builder that
Hemiunu was.

It is one agent with two front-ends: a terminal **CLI** and a local **web app**.
It answers product questions grounded in your connected sources (local files plus
any MCP servers you add), builds **wireframe then hi-fi prototypes** for a feature,
remembers what it learns per-feature in a `PROTOTYPE.md` committed to that
feature's repo, and keeps full conversations on disk.

**It is model agnostic.** Hemiunu runs on its own engine (`packages/engine`, built
on the Vercel AI SDK), not on any single vendor. You bring whatever provider you
already have: Anthropic, OpenAI, Gemini, Groq, xAI, DeepSeek, Mistral, a gateway
(LiteLLM / OpenRouter / vLLM), or a local Ollama with no key at all. No Anthropic
key is required. Any model in the registry can be the brain.

## See and shape its memory: the Memory graph

Open the **Memory** panel in the web app and the agent's memory unfolds as an
**interactive 3D graph**: every memory file and every agent is a node, and the
edges show **who can read or write what**. The main agent sits at the gold hub,
its cyan specialist subagents around it, your violet context files nearby, and the
rest of memory in slate. Click any node to read it. The ones that are *yours* you
edit in place: `user.md`, the feature's `PROTOTYPE.md`, skills, and source maps.

It is not just a view. It is how you **shape** what the agent knows:

- **Add context files** and attach them to any agent (main or a subagent). Each is
  injected into that agent's prompt every turn. A file attached to `main` is your
  parallel to `soul.md` (which stays read-only).
- **Customise the knowledge packs.** Edit a pack and your version overrides the
  shipped one and persists across updates. Delete the override to restore the
  original.
- **Define your own subagents.** Give one a name, a *when-to-summon* description, a
  model, and a system prompt, and the main agent **summons it on its own** whenever
  a request matches, right alongside the built-in researcher, prototyper, designer,
  strategist, and analyst.

## Collect the world as you build: the Atlas

Shipping is the game. **Every time you publish a prototype to a team's `main`
branch, you discover a famous monument of the world**, drawn at random by rarity
and pinned to your personal world map, the **Atlas**. The more you build and
publish, the more of the planet you collect. Become the **ultimate builder**: the
one whose Atlas is covered edge to edge.

Each find rolls one of five tiers:

| Tier | Odds | |
|---|---|---|
| Common | 50% | everyday landmarks |
| Rare | 28% | |
| Epic | 14% | |
| Legendary | 7% | a banner day for the Atlas |
| **Wonder of the World** | **1%** | a once-in-a-blue-moon find |

77 real landmarks span the globe, and at the very top sit the **8 Wonders**: the
New7Wonders (Taj Mahal, Machu Picchu, Christ the Redeemer, Colosseum, Chichen
Itza, Petra, the Great Wall of China) plus the Great Pyramid of Giza, the one
Hemiunu himself designed. At a 1% draw they are the trophies of the collection.
**Chase the Wonders.** Every push to `main` is another roll of the dice. Keep
building, keep publishing, and watch the world fill in.

## Install and use it: a step-by-step tutorial

This walks a first-timer all the way from nothing to a first conversation. Copy
each command as you go and check what you should see after it.

### 0. Prerequisites

You need three things:

1. **Node 22 or newer.** Check what you have:

   ```bash
   node -v
   ```

   If it prints `v22.` or higher you are set. If the version is lower, or the
   command is not found, install the current LTS from
   [nodejs.org](https://nodejs.org). (Node ships Corepack, which manages the exact
   pnpm version Hemiunu pins, so you do not install pnpm separately.)

2. **git.** Check with `git --version`. If it is missing, install it from
   [git-scm.com](https://git-scm.com).

3. **A way to reach a model.** Any ONE of these is enough:
   - a **provider API key** (Anthropic, OpenAI, Gemini, Groq, xAI, DeepSeek, or
     Mistral),
   - a **gateway** URL and key (for example a LiteLLM, OpenRouter, or vLLM
     endpoint that fronts many models at once), or
   - a **local Ollama** running on your machine, which needs no key.

   You do not need to decide now. First-run setup will walk you through it.

### 1. Install

**The one-line install** (recommended for most people):

```bash
curl -fsSL https://raw.githubusercontent.com/AntoineF23/hemiunu/main/install.sh | bash
```

What it does: clones Hemiunu to `~/.hemiunu/app`, installs its dependencies (no
build step, it runs the TypeScript directly), and adds two commands to your PATH:
`hemiunu` (terminal) and `hemiunu-web` (browser app). Your config under
`~/.hemiunu/` is never touched, so re-running the line later just updates the code.

If afterwards your shell says `hemiunu: command not found`, the install directory
is not on your PATH yet. The installer prints the exact line to add (something
like `export PATH="$HOME/.local/bin:$PATH"`). Paste it into your shell profile
(`~/.zshrc` or `~/.bashrc`), open a new terminal, and try again.

**From source** (for developers who want to hack on it):

```bash
git clone https://github.com/AntoineF23/hemiunu.git && cd hemiunu
corepack pnpm install
```

There is **no build step**: `tsx` runs the TypeScript directly, so your edits are
live on the next launch. Run the CLI with `corepack pnpm dev` and the web app with
`corepack pnpm web`.

### 2. First run: pick a model provider

Launch either front-end:

```bash
hemiunu          # terminal
# or
hemiunu-web      # browser app on http://127.0.0.1:5173
```

The very first launch runs **setup** and asks which provider you want. Everything
it collects is written to `~/.hemiunu/.env` for you, so hand-editing files is
optional. There are three concrete paths:

- **(a) A direct provider key.** Choose your provider (say OpenAI or Anthropic),
  paste the key, done. That provider's models are now usable.
- **(b) A gateway (LiteLLM / OpenRouter / vLLM).** Give the base URL and the key,
  then **Test & discover** lists the models the gateway exposes and you tick which
  ones to add. This is the recommended path if you have one LiteLLM key that opens
  access to many models at once: you register them all in one step.
- **(c) A local Ollama.** Pick Ollama, no key needed. Hemiunu talks to it on your
  machine.

The app is **ready as soon as one model is usable.** You are not locked in: in the
web **Settings** tab you can add or change keys and pick your **Brain** model and
your **Research** model at any time. Models whose key is missing are hidden behind
an **Add API keys** link, so the list only shows what you can actually run.

### 3. Point it at your work

Hemiunu reads **the folder you launch it in**. Launch it from inside a project so
the agent can see that project's files:

```bash
cd ~/code/my-product
hemiunu
```

To bring in more sources (Slack, Linear, Notion, a docs site, and so on), connect
**MCP servers**:

- In the **CLI**, run `/mcp` to add and manage servers.
- In the **web app**, use the **MCP panel**.

Once a source is connected, run **`/scan`** to map it: a cheap-tier scanner
subagent explores the server and writes a Markdown source map (structure, the ids
of key pages or databases, how to query it) so the agent goes straight to the
right place instead of groping around. `/scan <name>` maps one server; `/scan`
maps them all in parallel.

### 4. Have your first conversation

Ask something grounded in what you connected, for example:

> What are the open questions on the checkout redesign, and where did each come
> from?

What to expect:

- **A permission prompt on every tool call.** Before the agent reads a file or
  queries a source it asks, with a **yes / always / no** menu. "always" remembers
  that choice so it stops asking for that kind of action.
- **Plan-first mode.** Toggle it with `/plan` (CLI) or the composer toggle (web)
  and the agent works **read-only**: it researches and proposes a plan, then waits
  for you to approve before it changes anything. `/auto` runs tools without asking,
  scoped per team.
- **Building a prototype.** Ask for a screen and the `prototyper` subagent builds a
  low-fi grayscale **wireframe** first. Approve it (or hand over a clear brief) and
  the `designer` subagent upgrades it into a **hi-fi**, on-brand React + Tailwind
  **prototype**. Previews open inline in the web app, or in your browser from the
  CLI.

### 5. Teams and GitHub

A **team = a feature = a repo** (one to one). Work on a feature and Hemiunu keeps
that feature's brief and memory in a **`PROTOTYPE.md`** at the repo root: goal,
primary user, research findings with sources, decisions, open questions. It
maintains that file itself as it learns, straight through the GitHub API, so you
(or a teammate) can enrich a feature without cloning the repo.

To connect GitHub, run **`/github`**. The agent signs you in with GitHub's OAuth
**device flow**: it shows a short code, opens `github.com/login/device`, and once
you authorize it saves the token to `~/.hemiunu/.env` and never asks again. No `gh`
install and no hand-made token required. (Fallback: `/github <token>` with a
fine-grained PAT that has *Contents: read & write* on the repo.)

```bash
hemiunu                 # pick a team interactively
hemiunu owner/repo      # start on that team (added if new)
hemiunu local           # no team, local iteration
```

One team per terminal. To work on several at once, open another terminal and pick a
different team there; each is its own isolated session, pinned to its own repo.

### 6. Update and uninstall

**Update:** re-run the one-line installer. It pulls the latest code into
`~/.hemiunu/app`. Your config in `~/.hemiunu/` (keys, MCP servers, conversations,
skills, source maps) is preserved. That guarantee is locked in by
`packages/memory/src/preserve-on-update.test.ts`.

**Uninstall:** remove the two command symlinks and the app code:

```bash
rm ~/.local/bin/hemiunu ~/.local/bin/hemiunu-web
rm -rf ~/.hemiunu/app
```

Your config under `~/.hemiunu/` stays put unless you also delete it:

```bash
rm -rf ~/.hemiunu     # only if you want to wipe keys, conversations, and memory too
```

### 7. Troubleshooting

- **`hemiunu: command not found`.** The bin directory is not on your PATH. Add the
  line the installer printed (for example `export PATH="$HOME/.local/bin:$PATH"`)
  to your shell profile and open a new terminal.
- **"needs `SOME_KEY`" when you pick a model.** That model's provider key is not
  set. Open **Settings** (web) or re-run first-run setup, add the key, and the
  model becomes usable. You can also add it directly to `~/.hemiunu/.env`.
- **A model fails with a context error.** Context windows are **per-model** now, so
  a long conversation can overflow a small window. Either switch to a
  larger-window model (`/models`) or run **`/compact`** to summarise the history.
- **Web port already in use.** Something else is on `:5173` or `:4317`. Close the
  other process, or set a different web port with `HEMIUNU_WEB_PORT`.
- **Ollama not running.** If you chose the local Ollama path, make sure the Ollama
  app or `ollama serve` is running before you launch, otherwise the model is
  unreachable.

## What it can do

- **Grounded answers.** Connects to MCP servers (the launch folder via the built-in
  filesystem server, plus anything you add) and searches them before answering.
  Every tool call is gated by a **yes / always / no** permission prompt.
- **Web search.** Built-in `web_search` and `web_fetch` tools (server-side, no extra
  key) for public and current information, weighed against your own sources.
- **Source maps (`/scan`).** `/scan <mcp>` (or `/scan` for all, in parallel) sends a
  cheap-tier **scanner** subagent into a server to map what is inside it: structure,
  the ids of key pages and databases with one-line summaries, and how to query it.
  Each map is a per-user Markdown file in `~/.hemiunu/sources/` you can also edit by
  hand. Only the one-line description is surfaced each turn; the agent pulls the full
  map on demand, so it goes straight to the right place. Re-running reconciles the
  map, and the agent also updates maps on its own when they drift. What is visible
  depends on **your** access, hence per-user.
- **Researcher subagent and model tiers.** Anything that needs looking things up is
  delegated to a `researcher` subagent on a **cheaper tier**
  (`HEMIUNU_MODEL_RESEARCH`), then synthesized on the main model.
- **Prototyping.** A **`prototyper`** subagent builds low-fi grayscale wireframes; a
  **`designer`** subagent upgrades an approved wireframe (or a clear brief) into a
  hi-fi, on-brand React + Tailwind prototype, using your connected design system if
  one is present, else a solid Vite + React + TS + Tailwind fallback. Previews
  surface inline (web) or open in your browser (CLI).
- **Plan-first mode** (`/plan`, or the web toggle). The agent works **read-only**,
  researches, and proposes a plan, then waits for your approval (**auto-accept
  edits**, **approve each step**, or **keep planning** to refine) before it builds
  anything. `/auto` runs tools without asking, scoped **per team**.
- **Other models as tools.** An `ask_model` tool lets the brain consult **any other
  model** in the registry (OpenAI, Google, Groq, xAI, DeepSeek, Mistral, another
  Claude, a gateway model, or a local Ollama) for a second opinion, then integrate
  the result. Whichever model you set as the brain stays the primary agent; any of
  the others can be summoned for a focused subtask.
- **Parallel execution.** When a task splits into independent pieces, a `parallel`
  tool fans them out across subagents concurrently (real code-level fan-out), each
  in its own isolated context, and merges the results.
- **Persistent conversations** in SQLite (`~/.hemiunu/hemiunu.db`): list, resume,
  replay, with per-model context windows and automatic compaction.
- **File-based context** (Hermes-inspired). Each turn the system prompt is built from
  `context/soul.md` (persona, ships with the app) and a **global** `user.md` of
  learned user facts in `~/.hemiunu/` (carried into every project). The agent
  maintains `user.md` autonomously via a `remember` tool; feature knowledge lives in
  each team's `PROTOTYPE.md` (see Teams below), not in the launch folder.

## Configuration

Keys and settings live in **`~/.hemiunu/`**, separate from the code, so updates
never touch them: `~/.hemiunu/.env` (keys), `~/.hemiunu/mcp.json` (your MCP servers,
merged over the default), `~/.hemiunu/hemiunu.db`, `~/.hemiunu/skills/`,
`~/.hemiunu/sources/`. Updating only ever replaces the app code at `~/.hemiunu/app`;
your conversations and memory are left in place, a guarantee locked in by
`packages/memory/src/preserve-on-update.test.ts`. See
[`.env.example`](./.env.example) for the full, commented template.

| Variable (`~/.hemiunu/.env`) | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY` | *Per provider.* **Any ONE is enough**: it unlocks that provider's models. A local keyless endpoint (Ollama) needs none. |
| `LITELLM_API_KEY` | *Gateway.* Key for the shipped LiteLLM-routed models (gpt-4o, deepseek-v3, qwen3-235b-instruct, mistral-medium); their base URL is set per entry in the registry. |
| `ANTHROPIC_BASE_URL` | *Optional.* Anthropic-compatible gateway or proxy for the Claude entries. Unset means Anthropic direct. |
| `HEMIUNU_MODEL` | Main / synthesis model id, e.g. `claude-opus-4.8`. Unset (or unusable) falls back to the first available registry model. |
| `HEMIUNU_MODEL_RESEARCH` | Retrieval tier for the `researcher` subagent. Unset falls back to the first available "research"-tagged entry. |
| `HEMIUNU_COMPACT_THRESHOLD` | Auto-compaction threshold (default `0.5`). |
| `HEMIUNU_TOOL_RESULT_BUDGET` | Per-tool-result token budget (default `60000`); larger results are truncated with a notice. |
| `HEMIUNU_THINKING_BUDGET` | Extended-thinking tokens. `0` or unset means disabled (cheaper, works everywhere). |
| *(MCP server secrets)* | *Optional.* Any `${ENV_VAR}` a server you add to `mcp.json` references. |

Context windows are **per-model** in the registry now (a `HEMIUNU_CONTEXT_WINDOW`
override exists but is rarely needed). See
**[docs/providers.md](docs/providers.md)** for the tested provider matrix (live
smoke plus capability results per model) and what to expect from weaker
tool-callers.

**Models are bring-your-own: no provider is required.** First-run setup (CLI and
web) asks which provider you want and only requires THAT credential: one provider
key, a gateway (LiteLLM / OpenRouter / vLLM, base URL plus key, models discovered
and registered), or a local Ollama with no key at all. If a selected model's key is
missing, the agent tells you which one to add.

### Connecting MCP servers

Add servers **in-app** (CLI `/mcp`, or the web MCP panel) or by editing
`~/.hemiunu/mcp.json`, standard `mcpServers` shape (`stdio` / `http` / `sse`). Use
`${ENV_VAR}` for secrets (kept in `.env`) and `${CWD}` for the launch directory. A
server is auto-skipped if it is `disabled` or any of its env vars are unset. The
only built-in default is the **filesystem** server (it reads the folder you launch
in).

### Observability (OpenTelemetry)

Hemiunu can emit **OpenTelemetry traces** of everything it does — off by default,
and a no-op until you turn it on. It speaks the **standard OTLP env contract**, so
it exports to whatever collector your team already runs (Jaeger, Grafana Tempo,
Honeycomb, Datadog, an OTel Collector, …) — nothing Hemiunu-specific to host. Anyone
who runs the agent from GitHub gets the same traces in their own stack.

**Turn it on** by pointing it at your collector (or forcing it on):

```bash
# in ~/.hemiunu/.env  (or your shell env)
HEMIUNU_OTEL=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318      # your collector
# OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20... # e.g. a SaaS backend
```

No collector handy? Run one locally in seconds and open <http://localhost:16686>:

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
HEMIUNU_OTEL=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 hemiunu
```

**What you get** — one span tree per turn:

```
hemiunu.turn            (model, tokens, cost, stop reason)
├── hemiunu.step[0]     (one per model round-trip)
│   ├── ai.streamText   (the GenAI model call: prompt, tokens, output)
│   └── hemiunu.tool.web_search   (input, result, permission decision, ms)
└── hemiunu.step[1]
    └── hemiunu.tool.delegate
        └── hemiunu.subagent.designer
            (knowledge_pack=hifi-design, knowledge_hash=…, override=true)
            └── hemiunu.step… → ai.streamText + hemiunu.tool.save_prototype …
```

**Use it to improve the agent.** Each subagent span is tagged with the
`context/knowledge/*.md` pack that drove it plus a **content hash**. Edit a pack
(shipped, or your `~/.hemiunu` override), run the same task again, and compare the
two traces by `knowledge_hash` — that is prompt-engineering your agent with evidence
instead of guessing. Model, token, and cost attributes on every span also make it
easy to spot which model/step is slow or expensive.

**Privacy.** Two defaults keep shared traces safe: the actor is **pseudonymous** (a
random, persisted instance id — no host name or user identity), and a **redacting
exporter** scrubs API keys/tokens out of recorded content. Prompt/output content is
recorded by default (richest for evaluation); dial it back if you need to.

| Variable (`~/.hemiunu/.env`) | Purpose |
| --- | --- |
| `HEMIUNU_OTEL` | `1` to enable, `0` to force off. If unset, auto-enables when an `OTEL_EXPORTER_OTLP_*` endpoint is present. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Your collector's OTLP/HTTP endpoint (e.g. `http://localhost:4318`). Standard OTel var. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` | Standard OTel: auth headers for a hosted backend; service name (default `hemiunu`). |
| `HEMIUNU_OTEL_RECORD_CONTENT` | Record prompt/output text on spans. Default `1`; set `0` for metadata-only. |
| `HEMIUNU_OTEL_REDACT` | Content redaction level: `secrets` (default) · `pii` (also emails/phones) · `off` · `all` (drop content). |
| `HEMIUNU_OTEL_ACTOR` | Override the random instance id with a team-chosen pseudonym. |
| `HEMIUNU_OTEL_REDACT_PATTERNS` | Extra redaction regexes (one per line) applied to recorded content. |

## CLI essentials

- **Slash commands.** Type `/help` for the full grouped list. Highlights: `/plan`
  (plan-first), `/auto` (auto-accept, per team), `/models`, `/team`, `/mcp`,
  `/scan`, `/github`, `/new`, `/resume <id>`, `/compact`.
- **`# <note>`.** Type `#` followed by a line to save it straight to the current
  team's `PROTOTYPE.md` (the prompt turns blue to show it is a command).
- **Permissions.** Every tool call is gated **yes / always / no**; `Esc` interrupts
  a turn.
- **Folder trust.** On startup the CLI asks whether to trust the current folder for
  file access (remembered per folder; `/trust` re-opens it).

## Skills

**Skills** are reusable, saved procedures, each a Markdown file in the canonical
`SKILL.md` structure (YAML frontmatter plus instruction body), stored per-user in
`~/.hemiunu/skills/` so they persist across every session and project.

```md
---
name: weekly-report
description: Draft the weekly product status report from the team's updates.
argument-hint: "[week]"
---
Gather this week's updates from the connected sources (delegate to the researcher), then write a
concise status report covering shipped / in-progress / blocked, scoped to:
$ARGUMENTS
```

- **Run one** with its slash command: `/weekly-report Q3` (the body becomes the
  turn's prompt; `$ARGUMENTS` and `$1`, `$2` are filled from what you type).
- **Discover.** `/skills` lists what you have; each skill's `description` is surfaced
  to the agent so it can recognise when a request matches one. The full body loads
  only when it runs.
- **Create or edit two ways.** Ask the agent ("save a skill that...") and it writes
  the file via its `save_skill` tool, or edit the `.md` directly, changes take
  effect on the next run, no restart.

## Teams and prototype knowledge

A **team = a feature = a repo** (1:1). **One team per terminal:** on launch Hemiunu
asks which team to work on (skipped on a fresh install, you start local and it
offers to create one). To work on **several teams at once, open another terminal**
and pick a different team there. Each is its own isolated session, pinned to its own
repo, so they never step on each other.

The current team is shown under the chat. Within a terminal, **Shift+Tab** switches
teams sequentially, `/team` opens a switcher, and **`/team-new <name>`** creates a
fresh **private** repo named after it and switches in. Each team carries its own
conversation and context.

Every feature has a living **`PROTOTYPE.md` at its repo root**, the feature's brief
and memory (goal, primary user, research findings plus sources, decisions, open
questions). The agent maintains it **proactively** as it learns durable things about
the feature, and reorganizes it when useful, all straight through the GitHub API, so
it (or a teammate) can enrich a feature **without cloning the repo**. (In the CLI you
can also append a line yourself with `# <note>`.)

### GitHub OAuth App (one-time, for device sign-in)

Device sign-in needs a one-time **GitHub OAuth App** (its client id is public):

1. GitHub, then *Settings, Developer settings, OAuth Apps, New OAuth App*.
2. Any name and homepage; the callback URL is unused by device flow.
3. After creating, tick **Enable Device Flow**, and copy the **Client ID**.
4. Set `HEMIUNU_GITHUB_CLIENT_ID` in `~/.hemiunu/.env` (or paste it into
   `DEFAULT_GITHUB_CLIENT_ID` in `packages/agent-core/src/github.ts` to ship it for
   everyone).

The device flow grants the classic `repo` scope (covers Contents read/write on the
user's private repos).

## Coming soon

Active directions on the roadmap:

- **Automatic deployment.** Today `deploy_prototype` publishes a prototype to a
  shareable **Cloudflare Pages** URL on demand (`/cloudflare` to connect once with
  your own free account's API token; your whole team can share one dashboard). Next:
  **auto-deploy on every change**, a live preview link that updates itself as the
  agent builds, plus a choice of targets beyond Cloudflare (Vercel, Netlify, or your
  own host) picked per team.
- **Synthesized feature memory.** Automatically assemble each feature's
  `PROTOTYPE.md` by pulling and de-duplicating substance across all connected
  sources (Slack, Linear, docs), with provenance and timestamps, so a feature's
  shared context accrues instead of being re-discovered each turn.
- **One-click MCP auth.** OAuth for remote MCP servers, so SaaS sources connect
  without a hand-made token.
- **Hosted web app** with per-user accounts, so a team can share one Hemiunu instead
  of each person running it locally.

Want a different next step? The roadmap follows what teams ask for. Open an issue.

## Develop and verify

```bash
corepack pnpm typecheck          # tsc across the workspace
corepack pnpm lint               # eslint
corepack pnpm test               # node:test unit tests
corepack pnpm smoke --offline    # structural checks, no API calls, no cost
corepack pnpm smoke              # offline checks plus one live turn through the model
corepack pnpm smoke --model gpt-4o   # target a specific registry model for the live turn
corepack pnpm cap                # live capability eval (scenarios S1, S11)
```

`smoke --offline` is free and deterministic (config, context, MCP registry,
`remember`, prototype/workspace/teams, the engine runtime and TurnEvent stream). The
live `smoke` runs one real turn to verify the persona is wired through; add
`--model <registry-id>` to point it at a specific model. There is no build step for
development (`tsx` runs the TypeScript directly); `build:release` bundles a release
with esbuild.

## Repo layout

```
apps/
  cli/          # Ink chat REPL, banner, slash commands, permission menu, status line
  web/          # local web app, Hono worker (:4317) + Vite/React client (:5173)
  eval/         # smoke / capability harness
packages/
  engine/       # the model-agnostic engine (Vercel AI SDK): model registry, the
                #   tool-calling loop, TurnEvent protocol, transcript store, compactor,
                #   MCP host, web_search / web_fetch, permission pipeline. The only
                #   package that imports `ai` / `@ai-sdk/*`.
  agent-core/   # createEngineRuntime() (the drop-in runtime facade both apps use) plus
                #   the in-process tool servers, subagents, github / deploy / scan
  memory/       # context loader (soul/user) + remember() + SQLite conversation store
  mcp/          # mcp.json registry, stdio/http/sse, ${ENV} interpolation, auto-skip
  format/       # shared presentation helpers (CLI + web)
context/        # soul.md (persona), knowledge/, user.md.example template
mcp.json        # the default MCP server (filesystem)
```
