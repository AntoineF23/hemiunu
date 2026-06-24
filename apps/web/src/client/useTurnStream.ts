// Drives one agent turn from the browser: POST /api/turn to start, then read the
// streamed SSE response (fetch + ReadableStream, since EventSource is GET-only
// and a turn needs a POST body). Upstream control — permission replies and
// abort — are ordinary POSTs keyed by the turnId the worker hands back.
import { useCallback, useRef, useState } from "react";
import type {
  PermissionDecision,
  ServerEvent,
} from "../shared/protocol";

export interface ChatItem {
  id: number;
  kind: "user" | "agent" | "tool" | "result" | "note" | "subagent" | "error";
  text: string;
  /** for tool items */
  toolName?: string;
  delegate?: boolean;
  sub?: boolean;
}

export interface PermissionPrompt {
  requestId: string;
  name: string;
  preview: string;
}

export interface TurnState {
  items: ChatItem[];
  busy: boolean;
  permission: PermissionPrompt | null;
  lastCost: { costUsd: number | null; outTokens: number; ctxTokens: number } | null;
  send: (prompt: string) => void;
  respond: (decision: PermissionDecision) => void;
  stop: () => void;
}

/** Parse a fetch stream as SSE, yielding each `data:` frame's parsed JSON. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(5).trim()) as ServerEvent;
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

export function useTurnStream(): TurnState {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  const [lastCost, setLastCost] =
    useState<TurnState["lastCost"]>(null);

  const idRef = useRef(0);
  const turnIdRef = useRef<string | null>(null);
  const sessionRef = useRef<string | undefined>(undefined);

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

  const send = useCallback(
    (prompt: string) => {
      const text = prompt.trim();
      if (!text || busy) return;
      push({ kind: "user", text });
      setBusy(true);

      (async () => {
        try {
          const res = await fetch("/api/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: text, resume: sessionRef.current }),
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
                push({
                  kind: "tool",
                  text: e.preview,
                  toolName: e.name,
                  delegate: e.delegate,
                  sub: e.sub,
                });
                break;
              case "result":
                push({ kind: "result", text: e.text, sub: e.sub });
                break;
              case "subagent":
                push({
                  kind: "subagent",
                  text: e.label ? `${e.label} · ${e.detail}` : e.detail,
                  sub: true,
                });
                break;
              case "note":
                push({ kind: "note", text: e.text });
                break;
              case "permission":
                setPermission({ requestId: e.requestId, name: e.name, preview: e.preview });
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
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        } finally {
          setBusy(false);
          setPermission(null);
          turnIdRef.current = null;
        }
      })();
    },
    [busy, push, appendAgentText],
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
    const turnId = turnIdRef.current;
    if (!turnId) return;
    void fetch(`/api/turn/${turnId}/abort`, { method: "POST" });
  }, []);

  return { items, busy, permission, lastCost, send, respond, stop };
}
