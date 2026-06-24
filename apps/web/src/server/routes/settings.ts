// Read-only status, mirroring the CLI's /settings readout. Returns booleans
// only — secrets (API key, tokens) never leave the worker.
import { Hono } from "hono";
import {
  currentTeam,
  hasApiKey,
  listTeams,
  resolveGithubToken,
  vercelLoggedIn,
} from "@hemiunu/agent-core";
import { bootRuntime } from "../runtime";

export const settingsRoute = new Hono();

settingsRoute.get("/api/settings", (c) => {
  const rt = bootRuntime();
  return c.json({
    model: rt.model,
    hasApiKey: hasApiKey(),
    github: !!resolveGithubToken(),
    vercel: vercelLoggedIn(),
    team: currentTeam() ?? null,
    teams: listTeams(),
    mcpServers: Object.keys(rt.registry.mcpServers),
    mcpSkipped: rt.registry.skipped,
  });
});
