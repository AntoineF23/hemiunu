<div align="center">

<img src="assets/hemiunu-banner.svg" alt="Hemiunu — product agent for product teams" width="760">

</div>

An organization-wide AI **Product Agent** for a product team, built on the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) (TypeScript).

Same agent, two front-ends: a terminal **CLI** and a local **web app**. Hemiunu
answers product questions grounded in your connected sources (local files + any
MCP servers you add), builds **wireframe → hi-fi prototypes** for a feature,
remembers what it learns per-feature in a `PROTOTYPE.md` committed to that
feature's repo, and keeps full conversations on disk.

## Collect the world as you build — the Atlas

Shipping is the game. **Every time you publish a prototype to a team's `main`
branch, you discover a famous monument of the world** — drawn at random by
rarity and pinned to your personal world map, the **Atlas**. The more you build
and publish, the more of the planet you collect. Become the **ultimate builder**:
the one whose Atlas is covered edge to edge.

Each find rolls one of five tiers:

| Tier | Odds | |
|---|---|---|
| 🟫 Common | 50% | everyday landmarks |
| 🟦 Rare | 28% | |
| 🟪 Epic | 14% | |
| 🟨 Legendary | 7% | a banner day for the Atlas |
| 🌟 **Wonder of the World** | **1%** | a once-in-a-blue-moon find |

77 real landmarks span the globe — and at the very top sit the **8 Wonders**:
the New7Wonders (Taj Mahal, Machu Picchu, Christ the Redeemer, Colosseum, Chichén
Itzá, Petra, the Great Wall of China) plus the Great Pyramid of Giza. At a 1%
draw they're the trophies of the collection. **Chase the Wonders** — every push
to `main` is another roll of the dice. Keep building, keep publishing, and watch
the world fill in.

## Install

One line (requires **Node 20+**):

```bash
curl -fsSL https://raw.githubusercontent.com/AntoineF23/hemiunu/main/install.sh | bash
```

This clones Hemiunu to `~/.hemiunu/app`, installs dependencies, and puts the
`hemiunu` command on your PATH. Re-run any time to update — your config in
`~/.hemiunu/` is never touched.

**On first run it asks for your Anthropic API key** (the Claude brain) and,
optionally, an Anthropic-compatible gateway URL — no file editing. Keys are
saved to `~/.hemiunu/.env`.

### From source (for development)

Node 20+ (the conversation store uses `better-sqlite3`). Uses **pnpm** — via
Corepack (`corepack pnpm …`), an installed `pnpm`, or `npx pnpm …` if you have
neither.

```bash
git clone https://github.com/AntoineF23/hemiunu.git && cd hemiunu
corepack pnpm install
```

There's **no build step** — `tsx` runs the TypeScript directly, so your edits
are live on the next launch (no recompile).

## Run it — CLI or web app

Both front-ends drive the same engine and read the **folder you launch them in**
(the agent's file-access scope), with the brain from the install. Your config in
`~/.hemiunu/` is shared between them.

**CLI (terminal):**

```bash
hemiunu                  # after the curl install — from any folder
# or, from the repo:
corepack pnpm dev
```

A full-screen chat REPL: live streaming, an arrow-key permission menu, slash
commands, plan-first mode, and a status line.

**Web app (browser):**

```bash
corepack pnpm web        # from the repo
# or, from anywhere:     node /path/to/hemiunu/bin/hemiunu-web.mjs
```

Opens **http://127.0.0.1:5173** (a local worker runs on `:4317`). The same agent
with a graphical shell: chat with **inline prototype previews**, and docked
panels for MCP servers, teams, settings, skills, and the prototype brief.
Plan-first and auto-accept are toggles in the composer.

> Launch either inside a project folder to let the agent read *that* folder. The
> curl installer wires up the `hemiunu` command; to call the web app from
> anywhere, add an alias to `…/bin/hemiunu-web.mjs` or run it by path.

## What it can do

- **Grounded answers** — connects to MCP servers (the launch folder via the
  built-in filesystem server, plus anything you add) and searches them before
  answering. Every tool call is gated by a **yes / always / no** permission
  prompt.
- **Web search** — built-in `WebSearch` / `WebFetch` tools (server-side, no
  extra key) for public/current information, weighed against your own sources.
- **Source maps (`/scan`)** — `/scan <mcp>` (or `/scan` for all, in parallel)
  sends a cheap-tier **scanner** subagent into a server to map what's inside it:
  structure, the ids of key pages/databases with one-line summaries, and how to
  query it. Each map is a per-user Markdown file in `~/.hemiunu/sources/` you can
  also edit by hand. Only the one-line description is surfaced to the agent each
  turn; it pulls the full map on demand before searching, so it goes straight to
  the right place. Re-running reconciles the map; the agent also updates maps on
  its own when they drift. What's visible depends on **your** access — hence
  per-user.
- **Researcher subagent + model tiers** — anything that needs looking things up
  is delegated to a `researcher` subagent on a **cheaper tier**
  (`HEMIUNU_MODEL_RESEARCH`, default Sonnet), then synthesized on the main model.
- **Prototyping** — a **`prototyper`** subagent builds low-fi grayscale
  wireframes; a **`designer`** subagent upgrades an approved wireframe (or a
  clear brief) into a hi-fi, on-brand React + Tailwind prototype — using your
  connected design system if one is present, else a solid Vite + React + TS +
  Tailwind fallback. Previews surface inline (web) or open in your browser (CLI).
- **Plan-first mode** — `/plan` (or the web toggle): the agent works **read-only**,
  researches, proposes a plan, and waits for your approval — **auto-accept
  edits**, **approve each step**, or **keep planning** to refine — before it
  builds anything. `/auto` runs tools without asking, scoped **per team**.
- **Other models as tools** — an `ask_model` tool lets Claude consult any
  non-Claude model (OpenAI, Google, Groq, xAI, DeepSeek, Mistral) for a second
  opinion, then integrate the result. Claude stays the brain.
- **Parallel execution** — when a task splits into independent pieces, a
  `parallel` tool fans them out across subagents concurrently (real code-level
  fan-out), each in its own isolated context, and merges the results.
- **Persistent conversations** in SQLite (`~/.hemiunu/hemiunu.db`) — list,
  resume, replay — with per-model context windows and automatic compaction.
- **File-based context** (Hermes-inspired): each turn the system prompt is built
  from `context/soul.md` (persona, ships with the app) and a **global** `user.md`
  of learned user facts in `~/.hemiunu/` (carried into every project). The agent
  maintains `user.md` autonomously via a `remember` tool; feature knowledge lives
  in each team's `PROTOTYPE.md` (see Teams below), not in the launch folder.

## Configuration

Keys and settings live in **`~/.hemiunu/`**, separate from the code, so updates
never touch them: `~/.hemiunu/.env` (keys), `~/.hemiunu/mcp.json` (your MCP
servers, merged over the default), `~/.hemiunu/hemiunu.db`, `~/.hemiunu/skills/`,
`~/.hemiunu/sources/`.

| Variable (`~/.hemiunu/.env`) | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Key for the Claude brain. **Required.** |
| `ANTHROPIC_BASE_URL` | *Optional.* Anthropic-compatible gateway/proxy. Unset = Anthropic direct. |
| `HEMIUNU_MODEL` | Main / synthesis model id, e.g. `claude-opus-4.8`. |
| `HEMIUNU_MODEL_RESEARCH` | Retrieval tier for the `researcher` subagent (default `claude-sonnet-4.6`). |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY` | *Optional, per provider.* Enable that provider for the `ask_model` tool. |
| *(MCP server secrets)* | *Optional.* Any `${ENV_VAR}` a server you add to `mcp.json` references. |
| `HEMIUNU_THINKING_BUDGET` | Extended-thinking tokens. `0`/unset = disabled (cheaper, works everywhere). |
| `HEMIUNU_CONTEXT_WINDOW` / `HEMIUNU_COMPACT_THRESHOLD` | Context window override / auto-compaction threshold (default `0.5`). |

**Models are bring-your-own.** The brain is Claude (Anthropic directly, or any
Anthropic-compatible gateway via `ANTHROPIC_BASE_URL`). For `ask_model`, add each
provider's key to `~/.hemiunu/.env`; if a key is missing, the agent tells you
which one to add.

### Connecting MCP servers

Add servers **in-app** (CLI `/mcp`, or the web MCP panel) or by editing
`~/.hemiunu/mcp.json` — standard `mcpServers` shape (`stdio` / `http` / `sse`).
Use `${ENV_VAR}` for secrets (kept in `.env`) and `${CWD}` for the launch
directory. A server is auto-skipped if it's `disabled` or any of its env vars
are unset. The only built-in default is the **filesystem** server (it reads the
folder you launch in).

## CLI essentials

- **Slash commands** — type `/help` for the full grouped list. Highlights:
  `/plan` (plan-first) · `/auto` (auto-accept, per team) · `/models` · `/team` ·
  `/mcp` · `/scan` · `/github` · `/new` · `/resume <id>` · `/compact`.
- **`# <note>`** — type `#` followed by a line to save it straight to the current
  team's `PROTOTYPE.md` (the prompt turns blue to show it's a command).
- **Permissions** — every tool call is gated **yes / always / no**; `Esc`
  interrupts a turn.
- **Folder trust** — on startup the CLI asks whether to trust the current folder
  for file access (remembered per folder; `/trust` re-opens it).

## Skills

**Skills** are reusable, saved procedures — each a Markdown file in the canonical
Claude `SKILL.md` structure (YAML frontmatter + instruction body), stored
per-user in `~/.hemiunu/skills/` so they persist across every session and
project.

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
  turn's prompt; `$ARGUMENTS` / `$1`, `$2`… are filled from what you type).
- **Discover** — `/skills` lists what you have; each skill's `description` is
  surfaced to the agent so it can recognise when a request matches one. The full
  body loads only when it runs.
- **Create / edit two ways:** ask the agent ("save a skill that…") and it writes
  the file via its `save_skill` tool, or edit the `.md` directly — changes take
  effect on the next run, no restart.

## Teams & prototype knowledge

A **team = a feature = a repo** (1:1). **One team per terminal:** on launch
Hemiunu asks which team to work on (skipped on a fresh install — you start local
and it offers to create one). To work on **several teams at once, open another
terminal** and pick a different team there — each is its own isolated session,
pinned to its own repo, so they never step on each other.

```bash
hemiunu                 # pick a team interactively
hemiunu owner/repo      # start on that team (added if new)
hemiunu local           # start with no team (local iteration)
```

The current team is shown under the chat. Within a terminal, **Shift+Tab**
switches teams sequentially, `/team` opens a switcher, and **`/team-new <name>`**
creates a fresh **private** repo named after it and switches in. Each team
carries its own conversation + context.

Every feature has a living **`PROTOTYPE.md` at its repo root** — the feature's
brief and memory (goal, primary user, research findings + sources, decisions,
open questions). The agent maintains it **proactively** as it learns durable
things about the feature, and reorganizes it when useful — all straight through
the GitHub API, so it (or a teammate) can enrich a feature **without cloning the
repo**. (In the CLI you can also append a line yourself with `# <note>`.)

### Connect GitHub

Run **`/github`** — the agent connects your account via GitHub's OAuth **device
flow** (no `gh` install, no hand-made token): it shows a short code, opens
`github.com/login/device`, and once you authorize it saves the token to
`~/.hemiunu/.env` and never asks again. `/github` alone shows who you're signed
in as. (Fallback: `/github <token>` with a fine-grained PAT that has *Contents:
read & write* on the repo.)

Device sign-in needs a one-time **GitHub OAuth App** (its client id is public):

1. GitHub → *Settings → Developer settings → OAuth Apps → New OAuth App*.
2. Any name/homepage; the callback URL is unused by device flow.
3. After creating, tick **Enable Device Flow**, and copy the **Client ID**.
4. Set `HEMIUNU_GITHUB_CLIENT_ID` in `~/.hemiunu/.env` (or paste it into
   `DEFAULT_GITHUB_CLIENT_ID` in `packages/agent-core/src/github.ts` to ship it
   for everyone).

The device flow grants the classic `repo` scope (covers Contents read/write on
the user's private repos).

## Coming soon

Active directions on the roadmap:

- **Automatic deployment.** Today `deploy_prototype` publishes a prototype to a
  shareable **Vercel** URL on demand (`/vercel` to connect once, no token). Next:
  **auto-deploy on every change** — a live preview link that updates itself as
  the agent builds — plus a choice of targets beyond Vercel (Netlify, Cloudflare
  Pages, or your own host) picked per team.
- **Synthesized feature memory.** Automatically assemble each feature's
  `PROTOTYPE.md` by pulling and de-duplicating substance across all connected
  sources (Slack, Linear, docs, …), with provenance and timestamps — so a
  feature's shared context accrues instead of being re-discovered each turn.
- **One-click MCP auth.** OAuth for remote MCP servers, so SaaS sources connect
  without a hand-made token.
- **Hosted web app** with per-user accounts, so a team can share one Hemiunu
  instead of each person running it locally.

Want a different next step? The roadmap follows what teams ask for — open an
issue.

## Develop & verify

```bash
corepack pnpm typecheck        # tsc across the workspace
corepack pnpm smoke --offline  # structural checks — no API calls, no cost
corepack pnpm smoke            # offline checks + one live turn through the model
corepack pnpm cap              # live capability eval (scenarios S1–S11)
```

`smoke --offline` is free and deterministic (config, context, MCP registry,
`remember`, prototype/workspace/teams, …). The live `smoke` runs one real turn
to verify the persona is wired through (uses `HEMIUNU_MODEL`; override with
`HEMIUNU_EVAL_MODEL`).

## Repo layout

```
apps/
  cli/          # Ink chat REPL — banner, slash commands, permission menu, status line
  web/          # local web app — Hono worker (:4317) + Vite/React client (:5173)
  eval/         # smoke / capability harness
packages/
  agent-core/   # runTurn() — the SDK query() wrapper + in-process tool servers
  memory/       # context loader (soul/user) + remember() + SQLite conversation store
  mcp/          # mcp.json registry — stdio/http/sse, ${ENV} interpolation, auto-skip
  format/       # shared presentation helpers (CLI + web)
context/        # soul.md (persona) · knowledge/ · user.md.example template
mcp.json        # the default MCP server (filesystem)
```
