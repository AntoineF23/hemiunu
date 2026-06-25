// The core route: POST /api/turn streams one agent turn over SSE, and bridges
// the engine's blocking canUseTool callback to two small upstream POSTs
// (/permission, /abort). The stream-consumption switch and the permission
// auto-approvals are ported from apps/cli/src/index.tsx (runUserTurn + canUseTool).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  asStream,
  GET_SOURCE_MAP_TOOL_ID,
  PARALLEL_TOOL_ID,
  recordSeenTool,
  REMEMBER_TOOL_ID,
  resolveToolPolicy,
  runTurn,
  SAVE_SOURCE_MAP_TOOL_ID,
} from "@hemiunu/agent-core";
import { clip, prettyTool, resultText, summarizeResult, title, toolPreview } from "../format";
import { activeMcp, bootRuntime, effectiveSystem, turnRepo } from "../runtime";
import {
  alwaysAllow,
  createSession,
  endSession,
  getSession,
  type PermissionResult,
  resetAlwaysAllow,
  resolvePermission,
} from "../session";
import type { PermissionReply, ServerEvent, TurnRequest } from "../../shared/protocol";

export const turnRoute = new Hono();

turnRoute.post("/api/turn", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as TurnRequest;
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return c.json({ error: "empty prompt" }, 400);

  const rt = bootRuntime();
  // A brand-new conversation (no resume id) starts with a clean permission slate
  // so "always allow" grants never leak from a previous chat.
  if (!body.resume) resetAlwaysAllow();
  const turnId = randomUUID();
  const session = createSession(turnId);
  const { servers, patterns } = activeMcp(rt);

  return streamSSE(c, async (stream) => {
    const emit = (e: ServerEvent) => void stream.writeSSE({ data: JSON.stringify(e) });
    session.emit = emit;
    // Browser closed the tab / navigated away → abort the live turn.
    stream.onAbort(() => session.ac.abort());

    // Hard ceiling: if a turn never completes (upstream hang, model stall), abort
    // it instead of streaming forever and burning tokens. Override with
    // HEMIUNU_WEB_TURN_TIMEOUT_MS; default 10 min.
    const maxTurnMs = Number(process.env.HEMIUNU_WEB_TURN_TIMEOUT_MS) || 10 * 60_000;
    const turnTimeout = setTimeout(() => {
      if (!session.ac.signal.aborted) {
        emit({ type: "note", text: "⏱ turn exceeded the time limit — stopping." });
        session.ac.abort();
      }
    }, maxTurnMs);

    await emit({ type: "turn", turnId });

    // Permission gate: queued so concurrent tool calls ask one prompt at a time
    // (mirrors the CLI's permChain). Auto-approve the transparent local tools.
    const canUseTool = (toolName: string, input: Record<string, unknown>) => {
      const run = session.permChain.then(
        () =>
          new Promise<PermissionResult>((resolve) => {
            if (toolName === REMEMBER_TOOL_ID) {
              const note = typeof input.note === "string" ? input.note : "";
              emit({ type: "note", text: `✎ remembered: ${clip(note, 80)}` });
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            if (toolName === GET_SOURCE_MAP_TOOL_ID) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            if (toolName === SAVE_SOURCE_MAP_TOOL_ID) {
              const mcp = typeof input.mcp === "string" ? input.mcp : "";
              emit({ type: "note", text: `✎ source map updated${mcp ? `: ${mcp}` : ""}` });
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            // Persistent per-tool / per-server policy (set in the MCP panel).
            // Record the tool so the panel can list it, then honor the policy.
            recordSeenTool(toolName);
            const policy = resolveToolPolicy(toolName);
            if (policy === "block") {
              emit({ type: "note", text: `⛔ blocked by your MCP settings: ${prettyTool(toolName)}` });
              resolve({ behavior: "deny", message: "Blocked by your MCP settings." });
              return;
            }
            if (policy === "allow" || alwaysAllow.has(toolName)) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            // Genuinely gated: park the resolver and ask the browser.
            const requestId = randomUUID();
            session.pending.set(requestId, { resolve, toolName, input });
            emit({ type: "permission", requestId, name: toolName, preview: toolPreview(input) });
          }),
      );
      session.permChain = run.then(
        () => {},
        () => {},
      );
      return run;
    };

    let cost: number | null = null;
    let usage: Record<string, number> | undefined;
    let fullText = "";
    let sessionId: string | undefined = body.resume;
    // Tool ids of delegations (Task/parallel); their results are internal
    // handoffs we don't surface as raw blobs.
    const delegateIds = new Set<string>();

    try {
      for await (const m of runTurn({
        prompt,
        model: rt.model,
        systemPrompt: effectiveSystem(rt, Object.keys(servers)),
        resume: body.resume,
        canUseTool,
        mcpServers: servers,
        toolPatterns: patterns,
        abortController: session.ac,
        workspace: { repo: turnRepo() },
        onSubagentEvent: (e) => {
          if (e.type === "task-start") {
            emit({ type: "subagent", label: e.label, detail: `${e.agent} · running`, sub: true });
          } else if (e.type === "task-tool") {
            emit({ type: "subagent", label: e.label, detail: prettyTool(e.tool), sub: true });
          } else {
            emit({ type: "subagent", label: e.label, detail: e.ok ? "done" : "failed", sub: true });
          }
        },
      })) {
        const msg = asStream(m);
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
          if (sessionId) await emit({ type: "session", sessionId });
        } else if (msg.type === "assistant") {
          const sub = !!msg.parent_tool_use_id;
          for (const b of msg.message?.content ?? []) {
            if (b.type === "text") {
              const txt = b.text ?? "";
              if (sub) {
                const tx = txt.trim();
                if (tx) emit({ type: "subagent", label: "", detail: clip(tx, 240), sub: true });
                continue;
              }
              fullText += txt;
              emit({ type: "text", delta: txt });
            } else if (b.type === "tool_use") {
              if (b.name === PARALLEL_TOOL_ID) {
                if (b.id) delegateIds.add(b.id);
                const tasks = Array.isArray(b.input?.tasks) ? b.input.tasks : [];
                const summary = tasks
                  .map((t: Record<string, unknown>) => String(t.label ?? t.agent ?? "task"))
                  .join(", ");
                emit({
                  type: "tool",
                  name: "parallel",
                  preview: `${tasks.length} task${tasks.length === 1 ? "" : "s"}${
                    summary ? ` · ${clip(summary, 60)}` : ""
                  }`,
                  delegate: true,
                });
              } else if (b.name === "Agent" || b.name === "Task") {
                if (b.id) delegateIds.add(b.id);
                const who = String(b.input?.subagent_type ?? "subagent");
                const desc = clip(String(b.input?.description ?? ""), 56);
                emit({ type: "tool", name: who, preview: desc, delegate: true });
              } else {
                emit({ type: "tool", name: b.name ?? "tool", preview: toolPreview(b.input), sub });
              }
            }
          }
        } else if (msg.type === "user") {
          const sub = !!msg.parent_tool_use_id;
          for (const b of msg.message?.content ?? []) {
            if (b.type === "tool_result") {
              if (b.tool_use_id && delegateIds.has(b.tool_use_id)) continue;
              const t = resultText(b.content);
              if (t) emit({ type: "result", text: summarizeResult(t), sub });
            }
          }
        } else if (msg.type === "result") {
          cost = msg.total_cost_usd ?? null;
          usage = msg.usage;
        }
      }
    } catch (e) {
      if (session.ac.signal.aborted) emit({ type: "interrupted" });
      else emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(turnTimeout);
    }

    const ctxTokens =
      (usage?.input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0);
    emit({ type: "cost", costUsd: cost, outTokens: usage?.output_tokens ?? 0, ctxTokens });

    // Persist the exchange (same shape the CLI writes).
    if (sessionId) {
      rt.store.ensureConversation(sessionId, title(prompt), rt.model);
      rt.store.addMessage(sessionId, "user", prompt);
      rt.store.addMessage(sessionId, "assistant", fullText, cost);
    }

    await emit({ type: "done" });
    endSession(turnId);
  });
});

turnRoute.post("/api/turn/:turnId/permission", async (c) => {
  const turnId = c.req.param("turnId");
  const { requestId, decision } = (await c.req.json().catch(() => ({}))) as PermissionReply;
  if (!requestId || !decision) return c.json({ error: "bad reply" }, 400);
  const ok = resolvePermission(turnId, requestId, decision);
  if (!ok) return c.json({ error: "no such pending permission" }, 404);
  // Echo a decision note onto the turn's stream (mirrors the CLI's perm chip).
  const s = getSession(turnId);
  s?.emit({
    type: "note",
    text: `${decision === "always" ? "always allowed" : decision === "yes" ? "allowed" : "denied"}`,
  });
  return c.json({ ok: true });
});

turnRoute.post("/api/turn/:turnId/abort", (c) => {
  const s = getSession(c.req.param("turnId"));
  s?.ac.abort();
  return c.json({ ok: true });
});
