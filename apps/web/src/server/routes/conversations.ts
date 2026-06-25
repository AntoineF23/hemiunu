// Conversation history for the web UI: list past conversations and fetch one to
// replay/resume. Conversations are keyed by SDK session id (see turn.ts), so the
// id doubles as the `resume` token the client echoes back on the next turn.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { startPreview } from "@hemiunu/agent-core";
import { getArtifact } from "../artifacts";
import { bootRuntime } from "../runtime";

export const conversationsRoute = new Hono();

conversationsRoute.get("/api/conversations", (c) => {
  const rt = bootRuntime();
  return c.json({ conversations: rt.store.listConversations(50) });
});

conversationsRoute.get("/api/conversations/:id", (c) => {
  const rt = bootRuntime();
  const id = c.req.param("id");
  const messages = rt.store.getMessages(id).map((m) => ({
    role: m.role,
    content: m.content,
    ts: m.ts,
  }));
  return c.json({ id, messages });
});

// Restore the prototype a conversation produced: re-serve its (still on disk)
// files and hand back a fresh preview URL, so resuming shows the artifact again.
conversationsRoute.get("/api/conversations/:id/artifact", async (c) => {
  const rec = getArtifact(c.req.param("id"));
  if (!rec || !existsSync(join(rec.dir, "index.html"))) return c.json({ artifact: null });
  const res = await startPreview(rec.repo ?? "prototype", rec.dir);
  return c.json({ artifact: "url" in res ? { url: res.url, title: rec.title } : null });
});
