// Memory graph + node CRUD for the web UI's 3D memory panel. The graph and every
// reader/writer are backed by the same agent-core functions the CLI and agent use,
// so what the panel shows and edits is exactly the agent's real memory.
import { Hono } from "hono";
import { buildSystemPrompt, loadContext } from "@hemiunu/memory";
import {
  attachmentsBlock,
  buildMemoryGraph,
  configDir,
  deleteCustomAgent,
  isBuiltinAgent,
  loadCustomAgent,
  saveCustomAgent,
  SUBAGENTS,
  SUBAGENT_NAMES,
  subagentPrompt,
  type SubagentName,
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
  slugify,
  updatePrototype,
  writeUserMemory,
} from "@hemiunu/agent-core";
import { bootRuntime } from "../runtime";

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
  model?: string;
}

memoryRoute.get("/api/memory/graph", (c) => {
  try {
    // Only show source maps for servers that are actually connected right now —
    // the agent surfaces maps the same way, and it avoids confusing stale scan
    // files for servers the user has since disconnected.
    const rt = bootRuntime();
    const connectedServers = Object.keys(rt.registry.mcpServers).filter((n) => n !== rt.fsName);
    return c.json(buildMemoryGraph(undefined, { connectedServers }));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Read one node's underlying file (content + edit affordances).
memoryRoute.get("/api/memory/node/:id", async (c) => {
  const { kind, rest } = splitId(c.req.param("id"));
  try {
    switch (kind) {
      case "agent": {
        // View the agent's actual system prompt (read-only). To add to it, the
        // user attaches a context file — surfaced as a hint in the UI.
        if (rest === "main") {
          const base = buildSystemPrompt(
            loadContext({ appRoot: process.env.HEMIUNU_HOME, userRoot: configDir() }),
          );
          return c.json({
            kind,
            title: "main",
            content: base + attachmentsBlock("main"),
            editable: false,
            description: "The coordinator — talks to you and delegates to subagents.",
          });
        }
        if ((SUBAGENT_NAMES as string[]).includes(rest)) {
          const name = rest as SubagentName;
          return c.json({
            kind,
            title: name,
            content: subagentPrompt(name),
            editable: false,
            description: SUBAGENTS[name].description,
          });
        }
        // A user-defined subagent — its system prompt is editable.
        const ca = loadCustomAgent(rest);
        if (ca) {
          return c.json({
            kind,
            title: ca.name,
            content: ca.prompt,
            editable: true,
            description: ca.description,
            model: ca.model,
          });
        }
        return c.json({ error: "Unknown agent." }, 404);
      }
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
  const { content, title, description, agents, model } = (await c.req
    .json()
    .catch(() => ({}))) as NodeBody;
  const text = content ?? "";
  try {
    switch (kind) {
      case "agent": {
        if (isBuiltinAgent(rest)) {
          return c.json({ error: "Built-in agents are view-only." }, 400);
        }
        const cur = loadCustomAgent(rest);
        if (!cur) return c.json({ error: "No such agent." }, 404);
        // All four fields are editable, like creation. Renaming writes a new
        // <slug>.md and removes the old file; refuse a rename that would clobber
        // a different existing agent (or a built-in name).
        const nextSlug = slugify(title?.trim() || rest);
        if (!nextSlug) return c.json({ error: "A name is required." }, 400);
        if (nextSlug !== rest && (isBuiltinAgent(nextSlug) || loadCustomAgent(nextSlug)))
          return c.json({ error: `An agent named '${nextSlug}' already exists.` }, 400);
        const saved = saveCustomAgent({
          name: nextSlug,
          description: description ?? cur.description,
          // An explicit "" clears the model (back to the main model); omitting
          // it leaves the current one untouched.
          model: model === undefined ? cur.model : model || undefined,
          prompt: content ?? cur.prompt,
        });
        if (nextSlug !== rest) deleteCustomAgent(rest);
        return c.json({ ok: true, id: `agent:${saved.name}` });
      }
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
      case "agent":
        if (isBuiltinAgent(rest))
          return c.json({ error: "Built-in agents can't be deleted." }, 400);
        return c.json({ ok: deleteCustomAgent(rest) });
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

// Create a new user-defined subagent the main agent can summon.
memoryRoute.post("/api/memory/agents", async (c) => {
  const { title, description, model, content } = (await c.req.json().catch(() => ({}))) as NodeBody;
  if (!title?.trim()) return c.json({ error: "A name is required." }, 400);
  if (!description?.trim())
    return c.json({ error: "A description (when to summon it) is required." }, 400);
  if (!content?.trim()) return c.json({ error: "A system prompt is required." }, 400);
  try {
    const saved = saveCustomAgent({ name: title, description, model, prompt: content });
    return c.json(saved);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
