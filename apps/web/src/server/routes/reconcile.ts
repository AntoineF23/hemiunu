// New-conversation workspace reconciliation. With deferred publishing, the team's
// tmp workspace can hold un-published work (on the checkpoint branch) that diverges
// from main. On a fresh conversation the client asks for the status; if it's
// `diverged`, it offers Keep / Fresh / Publish and POSTs the chosen action here.
import { Hono } from "hono";
import {
  freshenWorkspace,
  githubViewer,
  publishWorkspace,
  reconcileWorkspace,
  resolveGithubToken,
} from "@hemiunu/agent-core";
import { turnRepo } from "../runtime";

export const reconcileRoute = new Hono();

reconcileRoute.get("/api/reconcile", async (c) => {
  const repo = turnRepo();
  const token = resolveGithubToken();
  // Local (no-team) prototypes have no main; without a token we can't fetch.
  if (!repo || !token) return c.json({ status: "none" });
  try {
    const rec = await reconcileWorkspace(repo, { token });
    return c.json({ status: rec.status, summary: rec.summary ?? null, mainMoved: !!rec.mainMoved, repo });
  } catch {
    return c.json({ status: "none" });
  }
});

reconcileRoute.post("/api/reconcile", async (c) => {
  const repo = turnRepo();
  const token = resolveGithubToken();
  if (!repo || !token) return c.json({ error: "No team selected, or not signed in to GitHub." }, 400);
  const { action } = (await c.req.json().catch(() => ({}))) as { action?: string };
  try {
    if (action === "fresh") {
      const { binned } = await freshenWorkspace(repo, { token });
      return c.json({
        ok: true,
        note: binned
          ? "Started fresh from main — your previous work was saved to the recycle bin."
          : "Started fresh from main.",
      });
    }
    if (action === "publish") {
      const login = (await githubViewer(token)) ?? undefined;
      const r = await publishWorkspace(repo, { token, login });
      return c.json({ ok: r.ok, note: r.ok ? `Published your previous work to ${repo} (main).` : r.note });
    }
    // "keep" (or anything else) is a no-op — continue on the existing workspace.
    return c.json({ ok: true, note: "Keeping your un-published work." });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
