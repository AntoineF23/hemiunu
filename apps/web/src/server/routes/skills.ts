// Skills management + expansion for the web UI. A skill is a saved Markdown
// procedure (name + description + body with $ARGUMENTS) the user runs as
// /<name>. Backed by the same agent-core functions the CLI and agent use, so
// skills are shared across all surfaces (~/.hemiunu/skills).
import { Hono } from "hono";
import { deleteSkill, expandSkill, loadSkill, loadSkills, saveSkill } from "@hemiunu/agent-core";

export const skillsRoute = new Hono();

skillsRoute.get("/api/skills", (c) => c.json({ skills: loadSkills() }));

skillsRoute.get("/api/skills/:name", (c) => {
  const skill = loadSkill(c.req.param("name"));
  if (!skill) return c.json({ error: "No such skill." }, 404);
  return c.json(skill);
});

// Create or replace a skill.
skillsRoute.put("/api/skills/:name", async (c) => {
  const { description, body, argumentHint } = (await c.req.json().catch(() => ({}))) as {
    description?: string;
    body?: string;
    argumentHint?: string;
  };
  if (!body?.trim()) return c.json({ error: "Skill body is required." }, 400);
  try {
    const saved = saveSkill({
      name: c.req.param("name"),
      description: description ?? "",
      body,
      argumentHint,
    });
    return c.json(saved);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

skillsRoute.delete("/api/skills/:name", (c) => {
  const ok = deleteSkill(c.req.param("name"));
  return ok ? c.json({ ok: true }) : c.json({ error: "No such skill." }, 404);
});

// Expand a skill into the prompt to send (substitutes $ARGUMENTS / $1…).
skillsRoute.post("/api/skills/:name/expand", async (c) => {
  const { args } = (await c.req.json().catch(() => ({}))) as { args?: string };
  const skill = loadSkill(c.req.param("name"));
  if (!skill) return c.json({ error: "No such skill." }, 404);
  return c.json({ prompt: expandSkill(skill, args ?? "") });
});
