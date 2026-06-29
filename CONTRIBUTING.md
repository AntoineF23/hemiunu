# Contributing

Thanks for working on Hemiunu. This is a short guide to getting set up and the
conventions the repo follows. For how the code is organized, read
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Prerequisites

- **Node 20+** (the conversation store uses `better-sqlite3`, a native module).
- **pnpm** via Corepack — no separate install needed. Every command below uses
  `corepack pnpm …`; if you have `pnpm` on your PATH already, drop the `corepack`
  prefix.

```bash
git clone https://github.com/AntoineF23/hemiunu.git && cd hemiunu
corepack pnpm install
```

There is **no build step** — `tsx` runs the TypeScript directly, so your edits
are live on the next launch.

## Running it

```bash
corepack pnpm dev    # CLI (Ink terminal REPL)
corepack pnpm web    # web app — http://127.0.0.1:5173 (worker on :4317)
```

Both read the folder you launch them in (the agent's file-access scope) and share
your config in `~/.hemiunu/`. On first run the app asks for an Anthropic API key.

## Verify before you push

CI runs exactly these on every push and PR (`.github/workflows/ci.yml`); run them
locally first:

```bash
corepack pnpm typecheck        # tsc across the workspace
corepack pnpm lint             # eslint
corepack pnpm format           # prettier --check  (use format:write to fix)
corepack pnpm test             # node:test unit tests in packages/**
corepack pnpm smoke --offline  # structural checks, no API calls, no cost
```

The live `corepack pnpm smoke` (one real model turn) and `corepack pnpm cap`
(capability eval) cost money and need an API key — they are **not** run in CI.

## Conventions

- **TypeScript, strict mode.** Avoid `any`; ESLint warns on it. Public surfaces
  are typed (`packages/agent-core/src/index.ts` is the engine's API).
- **Formatting & linting are enforced.** A Husky pre-commit hook runs
  `lint-staged` (ESLint `--fix` + Prettier) on staged files, and CI re-checks the
  whole repo. Don't hand-format — let Prettier do it.
- **Commit messages**: imperative mood, one concern per commit
  (e.g. "Give the prototype agent paginated reads"). Keep `main` green.
- **Secrets stay out of the repo.** Keys live in `~/.hemiunu/.env`; the repo's
  `.env` is gitignored. Use `.env.example` to document new variables.
- **Tests** use the built-in Node test runner (`node:test`) and live next to the
  code as `*.test.ts`. Cover non-obvious logic; the `apps/eval` harness covers
  end-to-end behavior.
