// The core route: POST /api/turn streams one agent turn over SSE, and bridges
// the engine's blocking canUseTool callback to two small upstream POSTs
// (/permission, /abort). The stream-consumption switch and the permission
// auto-approvals are ported from apps/cli/src/index.tsx (runUserTurn + canUseTool).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  activeProtoDir,
  applyMcpOAuth,
  asStream,
  checkpointWorkspace,
  explainError,
  generateTitle,
  GET_SOURCE_MAP_TOOL_ID,
  githubViewer,
  hasDevScript,
  PARALLEL_TOOL_ID,
  previewStatus,
  recordSeenTool,
  ASK_USER_TOOL_ID,
  REMEMBER_TOOL_ID,
  resolveGithubToken,
  resolveToolPolicy,
  runTurn,
  SAVE_SOURCE_MAP_TOOL_ID,
  startPreview,
} from "@hemiunu/agent-core";
import { recordArtifact } from "../artifacts";
import {
  clip,
  prettyTool,
  resultText,
  resultTextRaw,
  cleanResultPreview,
  title,
  toolPreview,
  isSpilledResultPath,
} from "../format";
import { activeMcp, bootRuntime, effectiveSystem, turnRepo } from "../runtime";
import {
  abortSession,
  alwaysAllow,
  createSession,
  endSession,
  getSession,
  type PermissionResult,
  resetAlwaysAllow,
  resolvePermission,
  resolveQuestion,
} from "../session";
import type {
  PermissionReply,
  QuestionReply,
  ServerEvent,
  TurnRequest,
} from "../../shared/protocol";

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
  // Seed auto-accept from the request (the client echoes its per-team toggle).
  // Plan-first turns start read-only, so auto-accept only kicks in once the plan
  // is approved with "auto" (resolvePermission flips it on then).
  session.autoAccept = body.planMode ? false : !!body.autoAccept;
  const { servers, patterns } = activeMcp(rt);

  return streamSSE(c, async (stream) => {
    // Idle guard: catch a real stall (upstream hang, model stall) without killing
    // a turn that's actively making progress. A long prototyping turn narrates and
    // writes files step-by-step for many minutes — all of that flows through emit()
    // below, so every event re-arms the timer. The turn only aborts after idleMs of
    // complete silence. Override with HEMIUNU_WEB_TURN_IDLE_MS (old
    // HEMIUNU_WEB_TURN_TIMEOUT_MS still honored); default 5 min.
    const idleMs =
      Number(process.env.HEMIUNU_WEB_TURN_IDLE_MS) ||
      Number(process.env.HEMIUNU_WEB_TURN_TIMEOUT_MS) ||
      5 * 60_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (session.ac.signal.aborted) return;
        // Waiting on the user is NOT a stall: while a permission prompt or an
        // ask_user question is parked, the turn is blocked on THEM, not hung. Don't
        // count that time — just re-arm and keep waiting until they respond.
        if (session.pending.size > 0 || session.askPending.size > 0) {
          armIdle();
          return;
        }
        emit({ type: "note", text: "turn stalled (no activity) — stopping." });
        session.ac.abort();
      }, idleMs);
    };
    // Serialize SSE writes through a promise chain so events keep their order
    // under backpressure, and swallow writes that reject after the client has
    // disconnected (otherwise they surface as unhandled rejections).
    let writeChain: Promise<void> = Promise.resolve();
    const emit = (e: ServerEvent) => {
      armIdle();
      writeChain = writeChain.then(() =>
        stream.writeSSE({ data: JSON.stringify(e) }).catch(() => {
          /* client gone / stream closed — stop writing */
        }),
      );
      return writeChain;
    };
    session.emit = emit;
    // Browser closed the tab / navigated away → abort the live turn.
    stream.onAbort(() => session.ac.abort());
    armIdle(); // guard the gap before the first event

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
            // Asking the user IS the action — auto-approve so the question shows
            // directly instead of behind a "may I ask?" permission prompt.
            if (toolName === ASK_USER_TOOL_ID) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            // Planning tools (built-in). TodoWrite + EnterPlanMode are internal
            // & read-only — auto-approve, shown as a note. ExitPlanMode is the
            // plan-approval gate: surface the plan, then fall through to gating.
            if (toolName === "TodoWrite") {
              const todos = Array.isArray(input.todos)
                ? (input.todos as { status?: string; activeForm?: string; content?: string }[])
                : [];
              const done = todos.filter((t) => t?.status === "completed").length;
              const active = todos.find((t) => t?.status === "in_progress");
              const label = active?.activeForm || active?.content || "";
              emit({
                type: "note",
                text: `◷ plan · ${done}/${todos.length}${label ? ` — ${clip(label, 60)}` : ""}`,
              });
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            if (toolName === "EnterPlanMode") {
              emit({
                type: "note",
                text: "◷ planning — researching before proposing an approach…",
              });
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            if (toolName === "ExitPlanMode") {
              const plan = typeof input.plan === "string" ? input.plan : "";
              if (plan) emit({ type: "note", text: `Proposed plan:\n${plan}` });
              // Park for the client's plan menu (handled by the gating below).
            } else if (session.autoAccept) {
              // Auto-accept mode: approve every gated tool without asking. Flipped
              // on by the request body or by approving a plan with "auto"; the
              // client resets it when the team changes, so it never crosses repos.
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            // Persistent per-tool / per-server policy (set in the MCP panel).
            // Record the tool so the panel can list it, then honor the policy.
            recordSeenTool(toolName);
            const policy = resolveToolPolicy(toolName);
            if (policy === "block") {
              emit({
                type: "note",
                text: `⛔ blocked by your MCP settings: ${prettyTool(toolName)}`,
              });
              resolve({ behavior: "deny", message: "Blocked by your MCP settings." });
              return;
            }
            if (policy === "allow" || alwaysAllow.has(toolName)) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            // Genuinely gated: park the resolver and ask the browser. ExitPlanMode
            // shows the Claude-Code plan menu client-side; the chosen decision
            // drives the mode switch in resolvePermission.
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
    // Tool ids of delegations (Task/parallel) → the subagent that ran them. We
    // don't surface their results as raw inline blobs; instead we emit the full
    // answer as a dedicated, expandable `answer` event keyed to the subagent.
    const delegateIds = new Map<string, string>();
    // When the agent starts (or switches) a localhost preview during the turn,
    // surface it as an inline artifact card. previewStatus() is in-process, so
    // we just watch it change as iterate_prototype / edits run.
    let lastPreviewUrl = previewStatus()?.url ?? null;
    // Whether we've shown the prototype as an artifact this turn — so a rebuild on
    // top of an already-running preview (same URL) still surfaces the card once.
    let artifactEmitted = false;
    // The active team at turn start. The agent can create/switch a team mid-turn
    // (control bridge → setCurrentTeam), so we watch turnRepo() change and emit a
    // `team` event the moment it does — the UI updates its workspace indicator
    // immediately instead of waiting for the (possibly long) turn to finish.
    let lastRepo = turnRepo();
    // Whether the agent built/edited a prototype this turn — if it used
    // save_prototype (which just writes files, no server), we start a static
    // preview ourselves afterwards so it still shows as an inline artifact.
    let touchedPrototype = false;

    try {
      for await (const m of runTurn({
        prompt,
        model: rt.model,
        systemPrompt: effectiveSystem(rt, Object.keys(servers)),
        resume: body.resume,
        canUseTool,
        ...(body.planMode ? { permissionMode: "plan" as const } : {}),
        // Inject a fresh OAuth bearer (refreshed if needed) for any remote server
        // the user authorized; a no-op when none are.
        mcpServers: await applyMcpOAuth(servers),
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
              if (/save_prototype|write_workspace_file|iterate_prototype/.test(b.name ?? "")) {
                touchedPrototype = true;
              }
              if (b.name === PARALLEL_TOOL_ID) {
                if (b.id) delegateIds.set(b.id, "parallel");
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
                const who = String(b.input?.subagent_type ?? "subagent");
                if (b.id) delegateIds.set(b.id, who);
                const desc = clip(String(b.input?.description ?? ""), 56);
                emit({ type: "tool", name: who, preview: desc, delegate: true });
              } else if (b.name === ASK_USER_TOOL_ID) {
                // Asking IS the action — the question card renders it directly, so
                // don't also show a redundant "ask_user" activity line.
              } else {
                // A read_workspace_file that targets an SDK tool-result overflow
                // file is internal bookkeeping, not prototype work — relabel it so
                // it doesn't read as "Working on the prototype" in an internal dir.
                const rawName = b.name ?? "tool";
                const path = typeof b.input?.path === "string" ? b.input.path : "";
                const name =
                  /read_workspace_file/.test(rawName) && isSpilledResultPath(path)
                    ? "read_saved_result"
                    : rawName;
                emit({ type: "tool", name, preview: toolPreview(b.input), sub });
              }
            }
          }
        } else if (msg.type === "user") {
          const sub = !!msg.parent_tool_use_id;
          for (const b of msg.message?.content ?? []) {
            if (b.type === "tool_result") {
              // A delegation's result is the subagent's final answer. Surface it
              // in full as its own expandable `answer` block (keyed to the
              // subagent) rather than dropping it or dumping it as a raw line.
              if (b.tool_use_id && delegateIds.has(b.tool_use_id)) {
                const agent = delegateIds.get(b.tool_use_id) ?? "subagent";
                const answer = resultTextRaw(b.content);
                if (answer) emit({ type: "answer", agent, text: answer });
                continue;
              }
              const t = resultText(b.content);
              // Only emit a CLEAN structured summary; raw dumps, oversized output
              // and errors are dropped so they never leak into the activity feed.
              const preview = t && cleanResultPreview(t);
              if (preview) emit({ type: "result", text: preview, sub });
            }
          }
        } else if (msg.type === "result") {
          cost = msg.total_cost_usd ?? null;
          usage = msg.usage;
        }

        // A preview appeared (or changed) → emit it as an inline artifact.
        const preview = previewStatus();
        if (preview && preview.url !== lastPreviewUrl) {
          lastPreviewUrl = preview.url;
          const t = preview.repo || "Prototype";
          await emit({ type: "artifact", url: preview.url, title: t });
          artifactEmitted = true;
          if (sessionId)
            recordArtifact(sessionId, { dir: activeProtoDir(), repo: turnRepo(), title: t });
        }

        // The active team changed mid-turn (agent created/switched one) → tell
        // the UI so the workspace indicator updates right away.
        const repoNow = turnRepo();
        if (repoNow !== lastRepo) {
          lastRepo = repoNow;
          await emit({ type: "team", repo: repoNow });
        }
      }

      // The prototype changed this turn but no artifact has been shown yet —
      // either it was built via save_prototype (no preview server runs), or it was
      // rebuilt on top of a preview that was already up from a previous turn (same
      // URL, so the watch above never fired). Start a preview if needed and surface
      // the inline artifact exactly once, so it's always shown.
      if (touchedPrototype && !artifactEmitted) {
        let preview = previewStatus();
        if (!preview) {
          const dir = activeProtoDir();
          // A self-contained wireframe has a root index.html; a hi-fi build (Vite /
          // Next.js) is served via its own dev server, keyed off a package.json `dev`
          // script even when its entry isn't a root index.html.
          if (existsSync(join(dir, "index.html")) || hasDevScript(dir)) {
            const res = await startPreview(turnRepo() ?? "prototype", dir);
            if ("url" in res) preview = previewStatus();
          }
        }
        if (preview) {
          const t = preview.repo || turnRepo() || "Prototype";
          await emit({ type: "artifact", url: preview.url, title: t });
          artifactEmitted = true;
          if (sessionId)
            recordArtifact(sessionId, { dir: activeProtoDir(), repo: turnRepo(), title: t });
        }
      }

      // Auto-checkpoint: when a team is active and the prototype changed this
      // turn, commit + push it to the team's checkpoint branch so the work
      // always reaches GitHub and survives a workspace reset. The default branch
      // stays clean — publishing there is still an explicit, confirmed step.
      if (touchedPrototype) {
        const repo = turnRepo();
        if (repo) {
          const token = resolveGithubToken();
          const login = token ? ((await githubViewer(token)) ?? undefined) : undefined;
          const cp = await checkpointWorkspace(repo, {
            token,
            login,
            message: title(prompt),
          });
          if (cp.pushed)
            await emit({ type: "note", text: `⤴ progress saved (not yet published to main)` });
        }
      }
    } catch (e) {
      if (session.ac.signal.aborted) emit({ type: "interrupted" });
      // explainError turns raw API/network failures into one plain-language
      // line (it falls back to the raw message when it doesn't recognise one).
      else emit({ type: "error", message: explainError(e) });
    } finally {
      clearTimeout(idleTimer);
    }

    const ctxTokens =
      (usage?.input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0);
    emit({ type: "cost", costUsd: cost, outTokens: usage?.output_tokens ?? 0, ctxTokens });

    // Persist the exchange (same shape the CLI writes).
    if (sessionId) {
      const sid = sessionId;
      rt.store.ensureConversation(sid, title(prompt), rt.model);
      rt.store.addMessage(sid, "user", prompt);
      rt.store.addMessage(sid, "assistant", fullText, cost);
      // First turn of a new conversation → upgrade the truncated title to an
      // LLM-generated one (small model). Fire-and-forget: the truncation already
      // shows in history immediately; this refines it without blocking the turn.
      if (!body.resume) {
        void generateTitle(prompt)
          .then((t) => {
            if (t) rt.store.setTitle(sid, t);
          })
          .catch(() => {});
      }
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
  const DECISION_NOTE: Record<string, string> = {
    always: "always allowed",
    yes: "allowed",
    no: "denied",
    "plan-auto": "plan approved — auto-accepting edits",
    "plan-manual": "plan approved — approving each step",
    "plan-refine": "keep planning — refining the plan",
  };
  const s = getSession(turnId);
  s?.emit({ type: "note", text: DECISION_NOTE[decision] ?? "denied" });
  return c.json({ ok: true });
});

turnRoute.post("/api/turn/:turnId/question", async (c) => {
  const turnId = c.req.param("turnId");
  const { requestId, answer } = (await c.req.json().catch(() => ({}))) as QuestionReply;
  if (!requestId || typeof answer !== "string") return c.json({ error: "bad reply" }, 400);
  const ok = resolveQuestion(turnId, requestId, answer);
  if (!ok) return c.json({ error: "no such pending question" }, 404);
  const s = getSession(turnId);
  s?.emit({ type: "note", text: `· you chose: ${answer}` });
  return c.json({ ok: true });
});

turnRoute.post("/api/turn/:turnId/abort", (c) => {
  abortSession(c.req.param("turnId"));
  return c.json({ ok: true });
});
