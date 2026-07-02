// Drives one agent turn from the browser: POST /api/turn to start, then read the
// streamed SSE response (fetch + ReadableStream, since EventSource is GET-only
// and a turn needs a POST body). Upstream control — permission replies and
// abort — are ordinary POSTs keyed by the turnId the worker hands back.
import { useCallback, useRef, useState } from "react";
import { type ActivityEvent, type ActivityGroup, reduceActivity } from "@hemiunu/format/activity";
import { friendlyTool } from "./friendly";
import { sseFrames } from "./sse";
import type { PermissionDecision } from "../shared/protocol";

export interface ChatItem {
  id: number;
  kind:
    | "user"
    | "agent"
    | "tool"
    | "result"
    | "answer"
    | "note"
    | "subagent"
    | "error"
    | "artifact"
    | "atlas"
    | "group";
  text: string;
  /** for tool items */
  toolName?: string;
  delegate?: boolean;
  sub?: boolean;
  /** for artifact items: the live preview URL to embed */
  url?: string;
  /** for atlas items: the earned monument (its id opens the Atlas focused on it). */
  monumentId?: string;
  name?: string;
  tier?: string;
  /** for group items: the coalesced activity run (renders via summarizeGroup). */
  group?: ActivityGroup;
}

/** Map a flattened `subagent` SSE event back to a normalized activity event. */
function subagentEvent(label: string, detail: string): ActivityEvent {
  if (detail === "done" || detail === "failed")
    return { type: "subdone", taskLabel: label, ok: detail === "done" };
  if (detail.endsWith("running"))
    return { type: "delegate", agent: "parallel", label: "Working in parallel" };
  return { type: "subtool", taskLabel: label, toolLabel: detail };
}

export interface PermissionPrompt {
  requestId: string;
  name: string;
  preview: string;
}

export interface QuestionPrompt {
  requestId: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
}

export interface TurnState {
  items: ChatItem[];
  busy: boolean;
  permission: PermissionPrompt | null;
  question: QuestionPrompt | null;
  lastCost: { costUsd: number | null; outTokens: number; ctxTokens: number } | null;
  /** Send a turn. `display` overrides the user-bubble text (e.g. show `/skill`
   *  while sending its expanded body). */
  send: (prompt: string, display?: string, planMode?: boolean, autoAccept?: boolean) => void;
  respond: (decision: PermissionDecision) => void;
  /** Answer the agent's ask_user question with the chosen option label. */
  answerQuestion: (answer: string) => void;
  stop: () => void;
  /** Clear the conversation and start fresh (new chat). */
  reset: () => void;
  /** Load a past conversation's messages and bind its session for resuming. */
  loadConversation: (sessionId: string, messages: { role: string; content: string }[]) => void;
  /** SDK session id currently loaded in the thread (undefined for a fresh chat). */
  currentSessionId: string | undefined;
}

export function useTurnStream(onTeam?: (repo: string | null) => void): TurnState {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  const [question, setQuestion] = useState<QuestionPrompt | null>(null);
  const [lastCost, setLastCost] = useState<TurnState["lastCost"]>(null);

  // Kept in a ref so the long-lived turn stream closure always calls the latest
  // callback without re-subscribing.
  const onTeamRef = useRef(onTeam);
  onTeamRef.current = onTeam;

  const idRef = useRef(0);
  const turnIdRef = useRef<string | null>(null);
  const sessionRef = useRef<string | undefined>(undefined);
  // Aborts the live turn's fetch so stop() tears down the client stream at once,
  // rather than waiting on the server to close it.
  const abortRef = useRef<AbortController | null>(null);

  const push = useCallback((item: Omit<ChatItem, "id">) => {
    setItems((prev) => [...prev, { ...item, id: idRef.current++ }]);
  }, []);

  // Append a streaming text delta onto the open agent bubble, or open a new one.
  const appendAgentText = useCallback((delta: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "agent") {
        return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...prev, { id: idRef.current++, kind: "agent", text: delta }];
    });
  }, []);

  // Coalesce a tool/subagent event into the trailing activity group (incrementing
  // its count in place), or open a new group when it doesn't extend the last one.
  // `toolName` is kept on tool-run groups so the renderer can pick the icon.
  const addActivity = useCallback((e: ActivityEvent, toolName?: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "group" && last.group) {
        const { group, flushed } = reduceActivity(last.group, e);
        // `flushed` means this event starts a different group — `last` already
        // holds the finished one, so leave it and push the new group.
        if (flushed)
          return [...prev, { id: idRef.current++, kind: "group", text: "", group, toolName }];
        return [...prev.slice(0, -1), { ...last, group, toolName: last.toolName ?? toolName }];
      }
      const { group } = reduceActivity(null, e);
      return [...prev, { id: idRef.current++, kind: "group", text: "", group, toolName }];
    });
  }, []);

  const send = useCallback(
    (prompt: string, display?: string, planMode?: boolean, autoAccept?: boolean) => {
      const text = prompt.trim();
      if (!text || busy) return;
      push({ kind: "user", text: (display ?? prompt).trim() });
      setBusy(true);

      const ac = new AbortController();
      abortRef.current = ac;

      (async () => {
        try {
          const res = await fetch("/api/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              prompt: text,
              resume: sessionRef.current,
              ...(planMode ? { planMode: true } : {}),
              ...(autoAccept ? { autoAccept: true } : {}),
            }),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) {
            push({ kind: "error", text: `Worker error (${res.status})` });
            setBusy(false);
            return;
          }
          for await (const e of sseFrames(res.body)) {
            switch (e.type) {
              case "turn":
                turnIdRef.current = e.turnId;
                break;
              case "session":
                sessionRef.current = e.sessionId;
                break;
              case "text":
                appendAgentText(e.delta);
                break;
              case "tool":
                if (e.delegate) {
                  const label =
                    e.name === "parallel"
                      ? "Working in parallel"
                      : e.name.charAt(0).toUpperCase() + e.name.slice(1);
                  addActivity({ type: "delegate", agent: e.name, label });
                } else if (e.sub) {
                  addActivity({
                    type: "subtool",
                    taskLabel: "subagent",
                    toolLabel: friendlyTool(e.name).label,
                    preview: e.preview,
                  });
                } else {
                  addActivity(
                    { type: "tool", label: friendlyTool(e.name).label, preview: e.preview },
                    e.name,
                  );
                }
                break;
              case "result":
                // Fold the result into the open group as its latest detail, not a
                // new line; only stand alone when no group is active.
                setItems((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.kind === "group" && last.group) {
                    if (last.group.kind === "tool-run" && !e.sub)
                      return [
                        ...prev.slice(0, -1),
                        { ...last, group: { ...last.group, preview: e.text } },
                      ];
                    return prev;
                  }
                  if (e.sub) return prev;
                  return [...prev, { id: idRef.current++, kind: "result", text: e.text }];
                });
                break;
              case "answer":
                // A subagent's full final answer — rendered as an expandable
                // block under the delegation (collapsed by default so the thread
                // stays scannable; click to read what the specialist returned).
                push({ kind: "answer", name: e.agent, text: e.text });
                break;
              case "subagent":
                // Labelled events feed the delegation group; an empty label is
                // subagent step narration ("Building the Header", "Fixing …") —
                // surface it as its own visible line so the build is legible.
                if (e.label) addActivity(subagentEvent(e.label, e.detail));
                else if (e.detail) push({ kind: "subagent", text: e.detail });
                break;
              case "note":
                push({ kind: "note", text: e.text });
                break;
              case "artifact":
                push({ kind: "artifact", text: e.title, url: e.url });
                break;
              case "atlas":
                push({
                  kind: "atlas",
                  text: e.line,
                  monumentId: e.monumentId,
                  name: e.name,
                  tier: e.tier,
                });
                break;
              case "team":
                // The agent created/switched the team mid-turn — let the app
                // refresh so the workspace indicator reflects it immediately.
                onTeamRef.current?.(e.repo);
                break;
              case "permission":
                setPermission({ requestId: e.requestId, name: e.name, preview: e.preview });
                break;
              case "question":
                setQuestion({
                  requestId: e.requestId,
                  header: e.header,
                  question: e.question,
                  options: e.options,
                });
                break;
              case "cost":
                setLastCost({ costUsd: e.costUsd, outTokens: e.outTokens, ctxTokens: e.ctxTokens });
                break;
              case "interrupted":
                push({ kind: "note", text: "⎯ interrupted" });
                break;
              case "error":
                push({ kind: "error", text: e.message });
                break;
              case "done":
                break;
            }
          }
        } catch (err) {
          // stop() aborts the fetch → reader.read() rejects with AbortError; that's
          // a user interruption, not a failure, so don't surface it as an error.
          if (!(err instanceof DOMException && err.name === "AbortError"))
            push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        } finally {
          setBusy(false);
          setPermission(null);
          setQuestion(null);
          turnIdRef.current = null;
          abortRef.current = null;
        }
      })();
    },
    [busy, push, appendAgentText, addActivity],
  );

  const answerQuestion = useCallback(
    (answer: string) => {
      const turnId = turnIdRef.current;
      const q = question;
      if (!turnId || !q) return;
      setQuestion(null);
      void fetch(`/api/turn/${turnId}/question`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: q.requestId, answer }),
      });
    },
    [question],
  );

  const respond = useCallback(
    (decision: PermissionDecision) => {
      const turnId = turnIdRef.current;
      const perm = permission;
      if (!turnId || !perm) return;
      setPermission(null);
      void fetch(`/api/turn/${turnId}/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: perm.requestId, decision }),
      });
    },
    [permission],
  );

  const stop = useCallback(() => {
    // Tell the server to abort the turn (releases parked prompts + cancels
    // subagents), then tear down our own stream so the UI stops immediately even
    // if the turn started before its turnId arrived.
    const turnId = turnIdRef.current;
    if (turnId) void fetch(`/api/turn/${turnId}/abort`, { method: "POST" });
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    if (busy) return;
    setItems([]);
    setPermission(null);
    setQuestion(null);
    setLastCost(null);
    sessionRef.current = undefined;
    turnIdRef.current = null;
  }, [busy]);

  const loadConversation = useCallback(
    (sessionId: string, messages: { role: string; content: string }[]) => {
      if (busy) return;
      setPermission(null);
      setLastCost(null);
      sessionRef.current = sessionId;
      turnIdRef.current = null;
      setItems(
        messages.map((m) => ({
          id: idRef.current++,
          kind: m.role === "user" ? "user" : "agent",
          text: m.content,
        })),
      );
      // Restore the prototype artifact (re-serves its files), if this
      // conversation produced one — replays it at the bottom of the thread.
      void (async () => {
        try {
          const res = await fetch(`/api/conversations/${encodeURIComponent(sessionId)}/artifact`);
          const { artifact } = (await res.json()) as {
            artifact: { url: string; title: string } | null;
          };
          if (artifact?.url) {
            setItems((prev) => [
              ...prev,
              { id: idRef.current++, kind: "artifact", text: artifact.title, url: artifact.url },
            ]);
          }
        } catch {
          /* no artifact / worker offline — leave the thread as text-only */
        }
      })();
    },
    [busy],
  );

  return {
    items,
    busy,
    permission,
    question,
    lastCost,
    send,
    respond,
    answerQuestion,
    stop,
    reset,
    loadConversation,
    currentSessionId: sessionRef.current,
  };
}
