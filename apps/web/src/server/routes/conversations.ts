// Conversation history for the web UI: list past conversations and fetch one to
// replay/resume. Conversations are keyed by SDK session id (see turn.ts), so the
// id doubles as the `resume` token the client echoes back on the next turn.
import { Hono } from "hono";
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
