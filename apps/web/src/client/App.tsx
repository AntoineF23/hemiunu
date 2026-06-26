import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, CircleAlert, CornerDownRight, PencilLine, Share2, Wrench } from "lucide-react";
import { summarizeGroup } from "@hemiunu/format/activity";
import { Button } from "@/components/ui/button";
import { ArtifactCard } from "@/components/ArtifactCard";
import { Composer } from "@/components/Composer";
import { Home } from "@/components/Home";
import { ConversationsPanel } from "@/components/panels/ConversationsPanel";
import { McpPanel } from "@/components/panels/McpPanel";
import { PrototypePanel } from "@/components/panels/PrototypePanel";
import { SettingsPanel } from "@/components/panels/SettingsPanel";
import { SkillsPanel } from "@/components/panels/SkillsPanel";
import { TeamsPanel } from "@/components/panels/TeamsPanel";
import { type Panel, Rail } from "@/components/Rail";
import { Sheet, SheetContent } from "@/components/ui/sheet";
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
  { name: "mcp", desc: "MCP servers & tool permissions", panel: "mcp" },
  { name: "settings", desc: "model, key, connections", panel: "settings" },
];

export function App() {
  const { settings, refresh, setModel } = useSettings();
  const {
    items,
    busy,
    permission,
    lastCost,
    send,
    respond,
    stop,
    reset,
    loadConversation,
    currentSessionId,
    // Refresh settings the instant the agent creates/switches a team mid-turn,
    // so the workspace indicator updates without waiting for the turn to end.
  } = useTurnStream(refresh);
  const { skills, refresh: refreshSkills } = useSkills();
  const [draft, setDraft] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_KEY) === "1");
  // One docked panel inside a single persistent shell. Switching just swaps the
  // shell's content (the column never closes/reopens), so there's no flash.
  // Opening collapses the rail and it stays collapsed afterwards.
  const [panel, setPanel] = useState<Panel | null>(null);
  // Animate the rail's width only on a manual toggle; opening a panel collapses
  // it instantly so the panel content doesn't slide sideways as the rail shrinks.
  const [railAnimate, setRailAnimate] = useState(true);
  const selectPanel = useCallback((p: Panel) => {
    setRailAnimate(false);
    setPanel((cur) => (cur === p ? null : p));
    setCollapsed(true);
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // The agent can create/switch/rename the team mid-turn (via the control
  // bridge). That only updates server-side state, so refresh settings when a
  // turn finishes to keep the visible team indicator in sync.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

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
      else {
        setRailAnimate(false);
        setPanel(cmd.panel);
        setCollapsed(true);
      }
    },
    [reset],
  );

  // Switch the active GitHub profile — teams are scoped per account, so the
  // visible team list (and avatar) update after refreshing settings.
  const switchAccount = useCallback(
    async (login: string) => {
      await sendJSON("/api/github/switch", { login }).catch(() => {});
      refresh();
    },
    [refresh],
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
        animate={railAnimate}
        onToggle={() => {
          setRailAnimate(true);
          setCollapsed((v) => !v);
        }}
        onNewChat={reset}
        openPanels={panel ? [panel] : []}
        onSelectPanel={selectPanel}
        team={settings?.team ?? null}
        user={settings?.user ?? null}
        githubLogin={settings?.githubLogin ?? null}
        accounts={settings?.githubAccounts ?? []}
        onSwitchAccount={switchAccount}
      />

      {/* One persistent docked shell right of the rail; main reduces beside it.
          Switching panels swaps the content inside (keyed fade), so the column
          itself never closes/reopens. */}
      <Sheet open={panel !== null} onOpenChange={(o) => !o && setPanel(null)}>
        <SheetContent>
          <div key={panel ?? "none"} className="panel-content flex min-h-full flex-col gap-4">
            {panel === "conversations" && (
              <ConversationsPanel
                open
                onOpenChange={(o) => !o && setPanel(null)}
                onResume={(id, msgs) => {
                  loadConversation(id, msgs);
                  setPanel(null);
                }}
                onDeleted={(id) => {
                  // If we just deleted the conversation we're viewing, clear the
                  // thread so the next turn doesn't resume a now-deleted session.
                  if (id === currentSessionId) reset();
                }}
              />
            )}
            {panel === "teams" && (
              <TeamsPanel open onOpenChange={(o) => !o && setPanel(null)} onChanged={refresh} />
            )}
            {panel === "prototypes" && (
              <PrototypePanel open onOpenChange={(o) => !o && setPanel(null)} />
            )}
            {panel === "skills" && (
              <SkillsPanel
                open
                onOpenChange={(o) => !o && setPanel(null)}
                skills={skills}
                commands={COMMANDS.map((c) => ({ name: c.name, desc: c.desc }))}
                onChanged={refreshSkills}
              />
            )}
            {panel === "mcp" && <McpPanel open onOpenChange={(o) => !o && setPanel(null)} />}
            {panel === "settings" && (
              <SettingsPanel
                open
                onOpenChange={(o) => !o && setPanel(null)}
                settings={settings}
                onChanged={refresh}
                onModelChange={setModel}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <main className="paper-main relative flex min-w-0 flex-1 flex-col overflow-hidden">
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

            <div className="bg-gradient-to-b from-transparent to-ground px-7 pb-4 pt-2.5">
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
    </div>
  );
}

// A coalesced activity run: one summary row (icon + "Reading Notion pages · 9 —
// 'title'"), expandable to reveal the individual steps when there's detail.
function GroupItem({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  const g = item.group;
  if (!g) return null;
  const isDelegation = g.kind === "delegation";
  const Icon = isDelegation ? Share2 : friendlyTool(item.toolName ?? "").icon;
  // Only offer expansion when the steps hold more than the summary already shows.
  const expandable = isDelegation ? g.children.length > 0 : g.count > 1;
  return (
    <div className={`activity-group${isDelegation ? " delegate" : ""}`}>
      <button
        type="button"
        className={`activity activity-summary${expandable ? " expandable" : ""}`}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        {expandable ? (
          <ChevronDown size={14} className={`activity-chevron${open ? " open" : ""}`} />
        ) : (
          <span className="activity-chevron-spacer" />
        )}
        <Icon size={15} className="activity-icon" />
        <span className="activity-label">{summarizeGroup(g)}</span>
        {expandable && <span className="activity-hint">{open ? "hide" : "details"}</span>}
      </button>
      {open && (
        <div className="activity-children">
          {g.children.map((c, i) => (
            <div key={i} className="activity sub">
              <CornerDownRight size={13} className="activity-icon" />
              <span className="activity-label">{c.label}</span>
              {c.preview && <span className="activity-preview">{c.preview}</span>}
            </div>
          ))}
        </div>
      )}
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
    case "group":
      return <GroupItem item={item} />;
    case "subagent":
      return <div className="subagent">{item.text}</div>;
    case "artifact":
      return item.url ? <ArtifactCard url={item.url} title={item.text} /> : null;
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
