// MUST be the first import in the worker entry, before any engine module.
// The engine's config.ts runs loadEnvFiles() at IMPORT time, reading
// process.env.HEMIUNU_HOME to find the repo-root .env (where the API key +
// MCP tokens live). When the worker is launched directly from apps/web
// (`pnpm --filter @hemiunu/web dev`, no bin launcher), that var is unset and
// the engine would look in the wrong place. Set it here first — apps/web/src/
// server → up four = repo root — so the .env load resolves correctly. The bin
// launcher's explicit HEMIUNU_HOME still wins.
import { join } from "node:path";

if (!process.env.HEMIUNU_HOME) {
  process.env.HEMIUNU_HOME = join(import.meta.dirname, "..", "..", "..", "..");
}
