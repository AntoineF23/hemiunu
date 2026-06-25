import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, CircleAlert, CornerDownRight, PencilLine, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/Composer";
import { Home } from "@/components/Home";
import { ConversationsPanel } from "@/components/panels/ConversationsPanel";
import { PrototypePanel } from "@/components/panels/PrototypePanel";
import { SettingsPanel } from "@/components/panels/SettingsPanel";
import { SkillsPanel } from "@/components/panels/SkillsPanel";
import { TeamsPanel } from "@/components/panels/TeamsPanel";
import { type Panel, Rail } from "@/components/Rail";
import { friendlyTool } from "./friendly";
import { StatusWord } from "./Hieroglyphs";
import { sendJSON } from "./lib/api";
import { Markdown } from "./Markdown";
import { useSettings } from "./useSettings";
import { useSkills } from "./useSkills";
import { type ChatItem, useTurnStream } from "./useTurnStream";

const RAIL_KEY = "hemiunu.rail.collapsed";

// Built-in slash commands — they map to UI actions (a panel or new chat), run
// immediately on select. Skills (user-defined) are merged in by the composer.
const COMMANDS: { name: string; desc: string; panel: Panel | null }[] = [
  { name: "new", desc: "start a new conversation", panel: null },
  { name: "conversations", desc: "browse past conversations", panel: "conversations" },
  { name: "teams", desc: "switch / manage teams", panel: "teams" },
  { name: "prototypes", desc: "view the prototype brief", panel: "prototypes" },
  { name: "skills", desc: "manage commands & skills", panel: "skills" },
  { name: "settings", desc: "model, key, connections", panel: "settings" },
];

export function App() {
  const { items, busy, permission, lastCost, send, respond, stop, reset, loadConversation } =
    useTurnStream();
  const { settings, refresh, setModel } = useSettings();
  const { skills, refresh: refreshSkills } = useSkills();
  const [draft, setDraft] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_KEY) === "1");
  const [panel, setPanel] = useState<Panel | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Keep the latest content in view as the turn streams.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, permission, busy]);

  const runCommand = useCallback(
    (name: string) => {
      const cmd = COMMANDS.find((c) => c.name === name);
      if (!cmd) return;
      if (cmd.panel === null) reset();
      else setPanel(cmd.panel);
    },
    [reset],
  );

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;

    // Slash dispatch: built-in command → UI action; saved skill → expand + send
    // (showing the typed /command, sending the expanded body); else send as-is.
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const args = sp === -1 ? "" : text.slice(sp + 1);
      if (COMMANDS.some((c) => c.name === name)) {
        setDraft("");
        runCommand(name);
        return;
      }
      if (skills.some((s) => s.name === name)) {
        setDraft("");
        try {
          const { prompt } = await sendJSON<{ prompt: string }>(
            `/api/skills/${encodeURIComponent(name)}/expand`,
            { args },
          );
          send(prompt, text);
        } catch {
          send(text);
        }
        return;
      }
    }
    send(text);
    setDraft("");
  }, [draft, busy, send, skills, runCommand]);

  const model = settings?.model ?? "claude-opus-4.8";
  const empty = items.length === 0;
  const lastId = items[items.length - 1]?.id;

  const composer = (
    <Composer
      draft={draft}
      setDraft={setDraft}
      onSubmit={submit}
      busy={busy}
      onStop={stop}
      disabled={!!permission}
      model={model}
      onModelChange={setModel}
      autoFocus
      commands={COMMANDS.map((c) => ({ name: c.name, desc: c.desc }))}
      skills={skills}
      onRunCommand={runCommand}
    />
  );

  return (
    <div className="relative z-[1] flex h-full">
      <Rail
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        onNewChat={reset}
        activePanel={panel}
        onSelectPanel={(p) => setPanel(p)}
        team={settings?.team ?? null}
        user={settings?.user ?? null}
      />

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {empty ? (
          <Home name={settings?.user ?? null} team={settings?.team ?? null} onPick={setDraft}>
            {composer}
          </Home>
        ) : (
          <>
            <div className="scroll" ref={scrollRef}>
              <div className="thread">
                {items.map((it) => (
                  <Item key={it.id} item={it} streaming={busy && it.id === lastId} />
                ))}

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
                      <Button size="sm" onClick={() => respond("yes")}>
                        Allow
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => respond("always")}>
                        Always allow
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => respond("no")}>
                        Not now
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-border bg-gradient-to-b from-transparent to-ground px-7 pb-4 pt-2.5">
              <div className="mx-auto max-w-[760px]">
                {composer}
                <div className="mt-2 flex items-center justify-between px-1 text-xs text-ink-4">
                  <span />
                  {lastCost && (
                    <button
                      className="inline-flex items-center gap-1 hover:text-ink-2"
                      onClick={() => setShowDetails((v) => !v)}
                    >
                      details
                      <ChevronDown size={12} className={showDetails ? "rotate-180" : ""} />
                    </button>
                  )}
                </div>
                {showDetails && lastCost && (
                  <div className="mt-1 px-1 font-mono text-[11.5px] text-ink-4">
                    context ~{Math.round(lastCost.ctxTokens / 1000)}k · last turn{" "}
                    {lastCost.costUsd != null ? `$${lastCost.costUsd.toFixed(4)}` : "—"} ·{" "}
                    {lastCost.outTokens} tokens out
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <TeamsPanel
        open={panel === "teams"}
        onOpenChange={(o) => !o && setPanel(null)}
        onChanged={refresh}
      />
      <PrototypePanel open={panel === "prototypes"} onOpenChange={(o) => !o && setPanel(null)} />
      <SkillsPanel
        open={panel === "skills"}
        onOpenChange={(o) => !o && setPanel(null)}
        skills={skills}
        commands={COMMANDS.map((c) => ({ name: c.name, desc: c.desc }))}
        onChanged={refreshSkills}
      />
      <SettingsPanel
        open={panel === "settings"}
        onOpenChange={(o) => !o && setPanel(null)}
        settings={settings}
        onChanged={refresh}
        onModelChange={setModel}
      />
      <ConversationsPanel
        open={panel === "conversations"}
        onOpenChange={(o) => !o && setPanel(null)}
        onResume={(id, msgs) => {
          loadConversation(id, msgs);
          setPanel(null);
        }}
      />
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
