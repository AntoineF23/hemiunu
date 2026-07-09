// Prototype-knowledge management for the web UI: read / append-note / replace
// the current team's PROTOTYPE.md. Backed by the same agent-core functions the
// agent uses (GitHub Contents API with a local fallback when no team is set).
import { Hono } from "hono";
import {
  addPrototypeNote,
  currentTeam,
  getPrototypeKnowledge,
  type NoteKind,
  parseFrontmatter,
  updatePrototype,
} from "@hemiunu/agent-core";

export const prototypeRoute = new Hono();

const NOTE_KINDS = new Set<NoteKind>(["decision", "question", "feedback", "note"]);

prototypeRoute.get("/api/prototype", async (c) => {
  const raw = await getPrototypeKnowledge();
  const { meta, body } = parseFrontmatter(raw);
  return c.json({ team: currentTeam() ?? null, meta, body, raw });
});

prototypeRoute.post("/api/prototype/note", async (c) => {
  const { kind, text } = (await c.req.json().catch(() => ({}))) as {
    kind?: string;
    text?: string;
  };
  if (!kind || !NOTE_KINDS.has(kind as NoteKind)) return c.json({ error: "Bad note kind." }, 400);
  if (!text?.trim()) return c.json({ error: "Empty note." }, 400);
  const message = await addPrototypeNote(kind as NoteKind, text.trim());
  return c.json({ message });
});

prototypeRoute.put("/api/prototype", async (c) => {
  const { content } = (await c.req.json().catch(() => ({}))) as { content?: string };
  if (typeof content !== "string" || !content.trim())
    return c.json({ error: "Empty content." }, 400);
  const message = await updatePrototype(content);
  return c.json({ message });
});
