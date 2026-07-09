// The core route: POST /api/turn streams one agent turn over SSE, and bridges
// the engine's blocking canUseTool callback to two small upstream POSTs
// (/permission, /abort). The turn runs on the engine runtime (agent-core's
// createEngineRuntime): TurnEvents stream out of runtime.runTurn — true
// token-level text streaming — and ../turn-events maps each one onto the wire
// protocol. Policy blocks/allows, always-allow, workspace confinement and
// compaction all happen engine-side now; this route only owns the interactive
// permission gate, the idle guard, and the artifact/team side-channels.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  activeProtoDir,
  checkpointWorkspace,
  explainError,
  githubViewer,
  hasDevScript,
  previewStatus,
  resolveGithubToken,
  startPreview,
} from "@hemiunu/agent-core";
import { PLAN_EXIT_TOOL, type CanUseToolResult } from "@hemiunu/engine";
import { recordArtifact } from "../artifacts";
import { title, toolPreview } from "../format";
import { activeMcp, bootRuntime, effectiveSystem, turnRepo } from "../runtime";
import {
  abortSession,
  alwaysAllow,
  createSession,
  endSession,
  getSession,
  resetAlwaysAllow,
  resolvePermission,
  resolveQuestion,
} from "../session";
import { createTurnMapper } from "../turn-events";
import { isPermissionDecision } from "../../shared/protocol";
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

    // TurnEvent → ServerEvent mapping state for this turn (delegations, task
    // labels, streamed text, prototype touches, the finish record).
    const mapper = createTurnMapper();

    // Interactive permission gate. The engine's pipeline already handles the
    // persistent tool policy (block/allow), the session always-allow set, and
    // `permission: "auto"` tools — only genuinely gated calls land here, one at
    // a time (the pipeline serializes prompts; the local chain is belt and
    // braces so a second parked ask can never race the single prompt card).
    const canUseTool = (toolName: string, input: unknown): Promise<CanUseToolResult> => {
      const record = (input ?? {}) as Record<string, unknown>;
      const run = session.permChain.then(
        () =>
          new Promise<CanUseToolResult>((resolve) => {
            // The plan-approval gate: surface the plan text first, then park for
            // the client's plan menu (exit_plan_mode ALWAYS asks — approving it
            // is what ends plan mode, even when auto-accept is on).
            if (toolName === PLAN_EXIT_TOOL) {
              const plan = typeof record.plan === "string" ? record.plan : "";
              if (plan) {
                emit({ type: "note", text: `Proposed plan:\n${plan}` });
                mapper.planNoted(plan);
              }
            } else if (session.autoAccept) {
              // Auto-accept mode: approve every gated tool without asking. Flipped
              // on by the request body or by approving a plan with "auto"; the
              // client resets it when the team changes, so it never crosses repos.
              resolve({ behavior: "allow", updatedInput: record });
              return;
            }
            // Genuinely gated: park the resolver and ask the browser. The chosen
            // decision resolves it via resolvePermission (plan choices map to the
            // engine's plan-decision flow there).
            const requestId = randomUUID();
            session.pending.set(requestId, { resolve, toolName, input: record });
            emit({ type: "permission", requestId, name: toolName, preview: toolPreview(input) });
          }),
      );
      session.permChain = run.then(
        () => {},
        () => {},
      );
      return run;
    };

    // The engine conversation id (mapper.conversationId once turn-start lands)
    // doubles as the resume token AND the history key.
    let sessionId: string | undefined = body.resume;
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

    try {
      for await (const event of rt.engine.runTurn({
        prompt,
        model: rt.model,
        researchModel: rt.researchModel,
        systemPrompt: effectiveSystem(rt, Object.keys(servers)),
        resume: body.resume,
        canUseTool,
        alwaysAllow,
        ...(body.planMode ? { permissionMode: "plan" as const } : {}),
        // The folder-trust-gated server subset for THIS turn; the runtime's MCP
        // host injects fresh OAuth bearers itself (mcpOAuthHeaders).
        mcpServers: servers,
        toolPatterns: patterns,
        abortController: session.ac,
        // No team → empty repo; the pipeline's workspace binding normalizes ""
        // back to the local (no-team) session, same as the old runtime's null.
        workspace: { repo: turnRepo() ?? "" },
      })) {
        for (const se of mapper.map(event)) emit(se);
        if (mapper.conversationId) sessionId = mapper.conversationId;

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

      // The engine ends an interrupted turn with turn-finish (it never throws
      // on abort), so surface the stop explicitly, like the old runtime did.
      if (mapper.finish?.stopReason === "aborted") emit({ type: "interrupted" });
      else if (mapper.finish?.stopReason === "max-steps")
        emit({ type: "note", text: "⚠ stopped at this turn's step limit." });

      // The prototype changed this turn but no artifact has been shown yet —
      // either it was built via save_prototype (no preview server runs), or it was
      // rebuilt on top of a preview that was already up from a previous turn (same
      // URL, so the watch above never fired). Start a preview if needed and surface
      // the inline artifact exactly once, so it's always shown.
      if (mapper.touchedPrototype && !artifactEmitted) {
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
      if (mapper.touchedPrototype) {
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

    // Context size = the LAST step's input side (prompt + cache reads/writes);
    // output tokens come from the whole turn's cumulative usage.
    const last = mapper.lastStepUsage;
    emit({
      type: "cost",
      costUsd: mapper.finish ? mapper.finish.costUsd : null,
      outTokens: mapper.finish?.usage.outputTokens ?? 0,
      ctxTokens: last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens,
    });

    // Persist the exchange (same shape the CLI writes). The engine transcript
    // (resume history) is written by the loop itself; this is the history list.
    if (sessionId) {
      const sid = sessionId;
      rt.store.ensureConversation(sid, title(prompt), rt.model);
      rt.store.addMessage(sid, "user", prompt);
      rt.store.addMessage(sid, "assistant", mapper.fullText, mapper.finish?.costUsd ?? null);
      // First turn of a new conversation → upgrade the truncated title to an
      // LLM-generated one (the registry's title-tagged model). Fire-and-forget:
      // the truncation already shows in history immediately; this refines it
      // without blocking the turn.
      if (!body.resume) {
        void rt.engine
          .generateTitle(prompt)
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
  const { requestId, decision } = (await c.req
    .json()
    .catch(() => ({}))) as Partial<PermissionReply>;
  if (typeof requestId !== "string" || !requestId || !isPermissionDecision(decision))
    return c.json({ error: "bad reply" }, 400);
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
  const { requestId, answer } = (await c.req.json().catch(() => ({}))) as Partial<QuestionReply>;
  if (typeof requestId !== "string" || !requestId || typeof answer !== "string")
    return c.json({ error: "bad reply" }, 400);
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
