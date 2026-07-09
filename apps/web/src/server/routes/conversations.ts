// Conversation history for the web UI: list past conversations and fetch one to
// replay/resume. Conversations are keyed by the ENGINE conversation id (see
// turn.ts), so the id doubles as the `resume` token the client echoes back on
// the next turn — the engine transcript replays the full history from it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { resolveGithubToken, restoreCheckpoint, startPreview } from "@hemiunu/agent-core";
import { getArtifact, removeArtifact } from "../artifacts";
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
  if (!rec) return c.json({ artifact: null });
  let dir = rec.dir;
  // The recorded dir can go missing — a no-team local folder that was migrated
  // into a team, or a team workspace reset/cleared. If we know the repo, restore
  // the prototype from its pushed checkpoint branch and serve that instead.
  if (!existsSync(join(dir, "index.html")) && rec.repo) {
    const restored = await restoreCheckpoint(rec.repo, { token: resolveGithubToken() });
    if (restored) dir = restored;
  }
  if (!existsSync(join(dir, "index.html"))) return c.json({ artifact: null });
  const res = await startPreview(rec.repo ?? "prototype", dir);
  return c.json({ artifact: "url" in res ? { url: res.url, title: rec.title } : null });
});

// Delete a conversation: removes it and its messages from SQLite (the source of
// truth and the resume token), plus any prototype-artifact record it produced.
conversationsRoute.delete("/api/conversations/:id", (c) => {
  const rt = bootRuntime();
  const id = c.req.param("id");
  rt.store.deleteConversation(id);
  removeArtifact(id);
  return c.json({ ok: true });
});
