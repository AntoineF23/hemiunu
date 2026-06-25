// Teammate management for the web UI: list / add / remove collaborators on the
// CURRENT team's repo. Add & remove reuse agent-core's addTeammate/removeTeammate
// (same logic as the /team-add CLI command and the agent's tools — repo
// resolution, auth, and the owner-only check for removal all live there).
import { Hono } from "hono";
import {
  addTeammate,
  currentTeam,
  listCollaborators,
  removeTeammate,
  repoAccess,
  resolveGithubToken,
} from "@hemiunu/agent-core";

export const teammatesRoute = new Hono();

// Current team's collaborators + whether the caller can remove people (admin).
teammatesRoute.get("/api/teammates", async (c) => {
  const repo = currentTeam() ?? null;
  const token = resolveGithubToken();
  if (!repo) return c.json({ repo: null, github: !!token, admin: false, teammates: [] });
  if (!token) return c.json({ repo, github: false, admin: false, teammates: [] });
  const access = await repoAccess(token, repo);
  const teammates = await listCollaborators(token, repo);
  return c.json({
    repo,
    github: true,
    admin: "error" in access ? false : access.admin,
    teammates,
  });
});

teammatesRoute.post("/api/teammates", async (c) => {
  const { username } = (await c.req.json().catch(() => ({}))) as { username?: string };
  if (!username?.trim()) return c.json({ error: "Give a GitHub username." }, 400);
  const message = await addTeammate(username.trim());
  return c.json({ message });
});

teammatesRoute.delete("/api/teammates/:username", async (c) => {
  const message = await removeTeammate(c.req.param("username"));
  return c.json({ message });
});
