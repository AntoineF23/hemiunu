// Memory graph + node CRUD for the web UI's 3D memory panel. The graph and every
// reader/writer are backed by the same agent-core functions the CLI and agent use,
// so what the panel shows and edits is exactly the agent's real memory.
import { Hono } from "hono";
import {
  buildMemoryGraph,
  deleteAttachment,
  deleteKnowledgeOverride,
  deleteSkill,
  deleteSourceMap,
  getPrototypeKnowledge,
  hasKnowledgeOverride,
  knowledgeDoc,
  loadAttachment,
  loadSkill,
  loadSourceMap,
  readSoul,
  readUserMemory,
  saveAttachment,
  saveKnowledgeOverride,
  saveSkill,
  saveSourceMap,
  shippedKnowledge,
  updatePrototype,
  writeUserMemory,
} from "@hemiunu/agent-core";

export const memoryRoute = new Hono();

/** Node ids are `<kind>:<rest>` (rest may itself contain a hyphen, never a colon). */
function splitId(id: string): { kind: string; rest: string } {
  const i = id.indexOf(":");
  return i === -1 ? { kind: id, rest: "" } : { kind: id.slice(0, i), rest: id.slice(i + 1) };
}

interface NodeBody {
  content?: string;
  title?: string;
  description?: string;
  agents?: string[];
}

memoryRoute.get("/api/memory/graph", (c) => {
  try {
    return c.json(buildMemoryGraph());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Read one node's underlying file (content + edit affordances).
memoryRoute.get("/api/memory/node/:id", async (c) => {
  const { kind, rest } = splitId(c.req.param("id"));
  try {
    switch (kind) {
      case "persona":
        return c.json({ kind, title: "soul.md", content: readSoul(), editable: false });
      case "user":
        return c.json({ kind, title: "user.md", content: readUserMemory(), editable: true });
      case "knowledge": {
        const override = knowledgeDoc(rest);
        const original = shippedKnowledge(rest);
        return c.json({
          kind,
          title: `${rest}.md`,
          content: override || original,
          editable: true,
          customized: hasKnowledgeOverride(rest),
          original,
        });
      }
      case "skill": {
        const s = loadSkill(rest);
        if (!s) return c.json({ error: "No such skill." }, 404);
        return c.json({
          kind,
          title: s.name,
          content: s.body,
          editable: true,
          description: s.description,
        });
      }
      case "source": {
        const m = loadSourceMap(rest);
        if (!m) return c.json({ error: "No such source map." }, 404);
        return c.json({
          kind,
          title: m.mcp,
          content: m.body,
          editable: true,
          description: m.description,
        });
      }
      case "context": {
        const a = loadAttachment(rest);
        if (!a) return c.json({ error: "No such context file." }, 404);
        return c.json({
          kind,
          title: a.title,
          content: a.body,
          editable: true,
          description: a.description,
          agents: a.agents,
        });
      }
      case "prototype": {
        const content = await getPrototypeKnowledge().catch(() => "");
        return c.json({ kind, title: "PROTOTYPE.md", content, editable: true });
      }
      default:
        return c.json({ error: "Unknown node." }, 404);
    }
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Save a node's content (metadata preserved for the structured kinds).
memoryRoute.put("/api/memory/node/:id", async (c) => {
  const { kind, rest } = splitId(c.req.param("id"));
  const { content, title, description, agents } = (await c.req
    .json()
    .catch(() => ({}))) as NodeBody;
  const text = content ?? "";
  try {
    switch (kind) {
      case "user":
        writeUserMemory(text);
        return c.json({ ok: true });
      case "knowledge":
        saveKnowledgeOverride(rest, text);
        return c.json({ ok: true, customized: true });
      case "prototype":
        await updatePrototype(text);
        return c.json({ ok: true });
      case "skill": {
        const cur = loadSkill(rest);
        saveSkill({
          name: rest,
          description: description ?? cur?.description ?? "",
          argumentHint: cur?.argumentHint,
          body: text,
        });
        return c.json({ ok: true });
      }
      case "source": {
        const cur = loadSourceMap(rest);
        saveSourceMap({
          mcp: rest,
          description: description ?? cur?.description ?? "",
          body: text,
        });
        return c.json({ ok: true });
      }
      case "context": {
        const cur = loadAttachment(rest);
        saveAttachment({
          slug: rest,
          title: title ?? cur?.title ?? rest,
          description: description ?? cur?.description ?? "",
          agents: agents ?? cur?.agents ?? [],
          body: text,
        });
        return c.json({ ok: true });
      }
      case "persona":
        return c.json(
          { error: "soul.md is view-only — attach a context file to the main agent instead." },
          400,
        );
      default:
        return c.json({ error: "Unknown node." }, 404);
    }
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Delete a node: revert a knowledge override, or remove a skill/source/context file.
memoryRoute.delete("/api/memory/node/:id", (c) => {
  const { kind, rest } = splitId(c.req.param("id"));
  try {
    switch (kind) {
      case "knowledge":
        return c.json({ ok: deleteKnowledgeOverride(rest), reverted: true });
      case "skill":
        return c.json({ ok: deleteSkill(rest) });
      case "source":
        return c.json({ ok: deleteSourceMap(rest) });
      case "context":
        return c.json({ ok: deleteAttachment(rest) });
      default:
        return c.json({ error: "This node can't be deleted." }, 400);
    }
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Create a new user context file attached to one or more agents.
memoryRoute.post("/api/memory/attachments", async (c) => {
  const { title, description, agents, content } = (await c.req
    .json()
    .catch(() => ({}))) as NodeBody;
  if (!title?.trim()) return c.json({ error: "A title is required." }, 400);
  if (!agents?.length) return c.json({ error: "Attach the file to at least one agent." }, 400);
  if (!content?.trim()) return c.json({ error: "Content is required." }, 400);
  try {
    const saved = saveAttachment({ title, description: description ?? "", agents, body: content });
    return c.json(saved);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
