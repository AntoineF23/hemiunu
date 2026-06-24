import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  CircleAlert,
  CornerDownRight,
  PencilLine,
  Square,
  Wrench,
} from "lucide-react";
import { friendlyTool } from "./friendly";
import { StatusWord } from "./Hieroglyphs";
import { Markdown } from "./Markdown";
import { type ChatItem, useTurnStream } from "./useTurnStream";

export function App() {
  const { items, busy, permission, lastCost, send, respond, stop } = useTurnStream();
  const [draft, setDraft] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Keep the latest content in view as the turn streams.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, permission, busy]);

  // Auto-grow the composer.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft]);

  const submit = () => {
    if (!draft.trim() || busy) return;
    send(draft);
    setDraft("");
  };

  const lastId = items[items.length - 1]?.id;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <span className="brand-word">Hemiunu</span>
        </div>

        <button className="team" disabled title="Team switcher — coming soon">
          <span className="team-dot" />
          <span className="team-name">Local workspace</span>
          <ChevronDown size={15} className="team-caret" />
        </button>

        <div className="rail-spacer" />

        <p className="rail-hint">
          Chat is the first slice. Teams, memory, prototypes and connections arrive next.
        </p>
      </aside>

      <main className="main">
        <div className="scroll" ref={scrollRef}>
          <div className="thread">
            {items.length === 0 && (
              <div className="empty">
                <div className="empty-glyphs">𓋹 𓂀 𓏏 𓆣 𓇳</div>
                <h1>What are we building?</h1>
                <p>
                  Ask Hemiunu about your product, dig through your connected sources, or describe a
                  feature to prototype.
                </p>
              </div>
            )}

            {items.map((it) => (
              <Item key={it.id} item={it} streaming={busy && it.id === lastId} />
            ))}

            {/* Before/between the agent's prose: a single changing word, so the
                wait feels alive without crowding the screen with motion. */}
            {busy && !permission && items[items.length - 1]?.kind !== "agent" && (
              <div className="thinking">
                <StatusWord />
              </div>
            )}

            {permission && (
              <div className="perm">
                <div className="perm-head">
                  <Wrench size={16} className="perm-icon" />
                  <span>
                    Hemiunu wants to{" "}
                    <strong>{friendlyTool(permission.name).label.toLowerCase()}</strong>
                  </span>
                </div>
                {permission.preview && <div className="perm-preview">{permission.preview}</div>}
                <div className="perm-actions">
                  <button className="btn primary" onClick={() => respond("yes")}>
                    Allow
                  </button>
                  <button className="btn" onClick={() => respond("always")}>
                    Always allow
                  </button>
                  <button className="btn ghost" onClick={() => respond("no")}>
                    Not now
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dock">
          <div className="dock-inner">
            <div className="composer">
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Message Hemiunu…"
                rows={1}
                disabled={!!permission}
              />
              {busy ? (
                <button className="send stop-mode" onClick={stop} aria-label="Stop">
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send"
                  onClick={submit}
                  disabled={!draft.trim()}
                  aria-label="Send"
                >
                  <ArrowUp size={17} strokeWidth={2.5} />
                </button>
              )}
            </div>

            <div className="footer">
              <span className="footer-model">claude-opus-4.8</span>
              {lastCost && (
                <button className="details-toggle" onClick={() => setShowDetails((v) => !v)}>
                  details <ChevronDown size={12} className={showDetails ? "flip" : ""} />
                </button>
              )}
            </div>
            {showDetails && lastCost && (
              <div className="details">
                context ~{Math.round(lastCost.ctxTokens / 1000)}k · last turn{" "}
                {lastCost.costUsd != null ? `$${lastCost.costUsd.toFixed(4)}` : "—"} ·{" "}
                {lastCost.outTokens} tokens out
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Item({ item, streaming }: { item: ChatItem; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="turn user-turn">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case "agent":
      return (
        <div className="turn agent-turn">
          <Markdown text={item.text} />
          {streaming && <span className="caret" />}
        </div>
      );
    case "tool": {
      const { label, icon: Icon } = friendlyTool(item.toolName ?? "");
      return (
        <div className={`activity${item.delegate ? " delegate" : ""}${item.sub ? " sub" : ""}`}>
          <Icon size={15} className="activity-icon" />
          <span className="activity-label">{label}</span>
          {item.text && <span className="activity-preview">{item.text}</span>}
        </div>
      );
    }
    case "result":
      return (
        <div className={`result${item.sub ? " sub" : ""}`}>
          <CornerDownRight size={13} className="result-icon" />
          <span>{item.text}</span>
        </div>
      );
    case "subagent":
      return <div className="subagent">{item.text}</div>;
    case "note":
      return (
        <div className="note">
          <PencilLine size={13} />
          <span>{item.text}</span>
        </div>
      );
    case "error":
      return (
        <div className="error">
          <CircleAlert size={15} />
          <span>{item.text}</span>
        </div>
      );
    default:
      return null;
  }
}
