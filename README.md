<div align="center">

<img src="assets/hemiunu-banner.svg" alt="Hemiunu — product agent for product teams" width="760">

</div>

An organization-wide AI **Product Agent** for a product team, built on the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) (TypeScript).

The current build is the **CLI MVP**: a product-knowledge agent that answers
questions grounded in your connected sources (Notion, local files, any MCP
server), remembers what it learns, and keeps full conversations on disk. The
long-term vision — prototyping (wireframes → design system → deploy), a hosted
web app, and per-user auth — lives in [`FINAL_PLAN.md`](./FINAL_PLAN.md).

## What it does today

- **Chat REPL** (Ink TUI) with a pyramid banner, live status line, and
  Claude-Code-style streaming.
- **Grounded answers** — connects to MCP servers (Notion read-only, local
  filesystem, or anything you add to `mcp.json`) and searches them before
  answering. Every tool call is gated by a **yes / always / no** permission
  prompt (queued, arrow-key select, `Esc` to interrupt).
- **Researcher subagent + model tiers** — for anything that needs looking
  things up, the main model delegates retrieval to a `researcher` subagent
  running on a **cheaper tier** (`HEMIUNU_MODEL_RESEARCH`, default Sonnet),
  then synthesizes the findings on the main model. The CLI shows the
  delegation (`⌂ researcher · sonnet`) and the subagent's source calls.
- **Other models as tools** — an `ask_model` tool lets the Claude agent
  consult any non-Claude model on the proxy (Gemini, GPT, Grok, DeepSeek,
  Qwen, …) for a second opinion or a specialized subtask, then integrate the
  result. Claude stays the brain; other models are tools it calls.
- **Wireframes (low-fi)** — ask Hemiunu to mock up a screen or flow and it
  assembles a brief from your sources, then a `prototyper` subagent generates a
  self-contained grayscale HTML wireframe into `prototypes/<slug>/` and opens it
  in your browser. Structure and flow first; the design system comes later.
- **Parallel execution** — when a task splits into independent pieces, a
  `parallel` tool fans them out across subagents concurrently (real code-level
  fan-out, not the model's sequential dispatch), each in its own isolated
  context, and merges the results. Genuinely parallel + no cross-contamination.
- **File-based context construction** (Hermes-inspired): each turn the system
  prompt is assembled from `context/soul.md` (persona), `context/user.md`
  (learned user facts), and `context/memory.md` (durable notes). The agent
  updates the latter two **autonomously** via a `remember` tool. `user.md` and
  `memory.md` are **per-user and gitignored** — the repo ships empty
  `*.md.example` templates, and the live files are seeded from them on first
  run, so every clone starts with a blank slate.
- **Persistent conversations** in SQLite (`~/.hemiunu/hemiunu.db`) — list,
  resume, replay.
- **Adaptive context management** — per-model context window with automatic
  compaction (rolling summary) plus `/compact` and `/clear`.
- **Runtime model switching** via `/models` (lists the Claude models your key
  exposes on the proxy).

## Setup

Requires Node 24+ (uses the built-in `node:sqlite`). pnpm via Corepack.

```bash
corepack pnpm install
cp .env.example .env      # then fill in your key (see below)
corepack pnpm dev         # launch the CLI (from the repo)
```

### The `hemiunu` command

To launch with a single word from any folder — like `claude` — install the
`hemiunu` command once:

```bash
corepack pnpm link --global    # registers `hemiunu` on your PATH
# or, if pnpm's global bin isn't on PATH:
ln -s "$PWD/bin/hemiunu.mjs" /usr/local/bin/hemiunu
```

Then, from anywhere:

```bash
hemiunu
```

Hemiunu's own config (`soul.md`, `mcp.json`, `.env`) is read from where it's
installed, while file access (the filesystem MCP) and folder-trust follow the
directory you launch it in — so `hemiunu` in a project lets the agent read
*that* project, with its brain coming from the install.

### Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Anthropic-compatible endpoint (the org LiteLLM proxy). |
| `ANTHROPIC_API_KEY` | Key for that endpoint. **Required.** |
| `HEMIUNU_MODEL` | Main / synthesis model id, e.g. `claude-opus-4.8` / `claude-sonnet-4.6`. |
| `HEMIUNU_MODEL_RESEARCH` | Retrieval tier for the `researcher` subagent (default `claude-sonnet-4.6`). Haiku isn't supported — see note below. |
| `HEMIUNU_THINKING_BUDGET` | Extended-thinking tokens. `0`/unset = disabled (cheaper, works everywhere). |
| `HEMIUNU_CONTEXT_WINDOW` | Override the context window (for compaction). |
| `HEMIUNU_COMPACT_THRESHOLD` | Fraction of the window that triggers auto-compaction (default `0.5`). |
| `NOTION_TOKEN` | Notion integration token — connects the Notion MCP server. |

### Connecting MCP servers

Edit [`mcp.json`](./mcp.json) (standard `mcpServers` shape — `stdio`, `http`,
or `sse`). Use `${ENV_VAR}` for secrets (kept in `.env`); `${CWD}` resolves to
the launch directory. A server is auto-skipped if it's `disabled` or any of its
env vars are unset. `/mcp` in the CLI shows connection status.

On startup the CLI asks whether to **trust the current folder** for file
access; the decision is remembered per folder. `/trust` re-opens it.

## Slash commands

`/new` `/clear` `/compact` `/models` `/trust` `/list` `/resume` `/mcp`
`/help` `/exit`

## Smoke / eval harness

A tiny harness gates the MVP end-to-end:

```bash
corepack pnpm smoke            # offline checks + one live turn through the proxy
corepack pnpm smoke --offline  # structural checks only — no API calls, no cost
```

Offline checks (free, deterministic): config loads, the system prompt is built
from `context/`, `mcp.json` parses into tool patterns, servers with unset env
are skipped, and `remember()` writes to disk. The live section runs one real
turn (the M0 gate) and verifies the persona is wired through. It uses
`HEMIUNU_MODEL` by default; override with `HEMIUNU_EVAL_MODEL`.

## Repo layout

```
apps/
  cli/          # Ink chat REPL — banner, slash commands, permission menu, status line
  eval/         # smoke / eval harness
packages/
  agent-core/   # runTurn() — SDK query() wrapper: model/env/thinking config, remember tool
  memory/       # context loader (soul/user/memory) + remember() + SQLite conversation store
  mcp/          # mcp.json registry — stdio/http/sse, ${ENV} interpolation, auto-skip
context/         # soul.md (persona, tracked) · *.md.example templates (tracked)
                 #   user.md / memory.md are per-user, gitignored, seeded on first run
mcp.json         # connected MCP servers
```

## Planning docs

- [`FINAL_PLAN.md`](./FINAL_PLAN.md) — the full product vision.
- [`MVP_PLAN.md`](./MVP_PLAN.md) — the CLI MVP milestones (M0–M3).
- [`OAUTH_PLAN.md`](./OAUTH_PLAN.md) — deferred OAuth / token-broker design for
  OAuth-protected remote MCP servers.
