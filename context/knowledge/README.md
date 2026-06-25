# Knowledge packs

Curated **craft/method knowledge** for the agent's specialist subagents. Each
`.md` here is a focused discipline guide (principles + checklists, not a
textbook) that is injected into **one** subagent's system prompt — never into
the always-on coordinator prompt. That's what lets the agent's knowledge scale:
adding a pack costs nothing until the subagent that owns it is delegated to.

> Craft knowledge (how to do product/design/research well) lives **here**.
> Product knowledge (your actual users, decisions, data) lives in the feature's
> **PROTOTYPE.md** and your connected sources — not here.

## How to add a pack

1. Write `context/knowledge/<topic>.md` — concise, opinionated, scannable.
2. Point a subagent at it in `packages/agent-core/src/subagents.ts` by adding a
   `knowledge` field to its `SUBAGENTS` entry:
   ```ts
   knowledge: { name: "<topic>", header: "<section title>", intro?: "<optional lead-in>" }
   ```
   `subagentPrompt()` injects `# <header>` + the file into that subagent only.
3. (New discipline?) Add a subagent to the `SUBAGENTS` map with its `prompt`,
   `tier` ("synthesis" for reasoning, "research" for retrieval), `tools`, and
   `knowledge`. Mention when to delegate to it in `context/soul.md`.

## Current packs
- `design.md` → the **prototyper** (wireframe/design principles)
- `strategy.md` → the **strategist** (product judgment, prioritisation)
- `metrics.md` → the **analyst** (data interpretation)

Keep packs tight: the model already reasons well — a pack should sharpen its
judgment and vocabulary, not dump everything it might ever need.
