import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleHelp,
  ClipboardList,
  CornerDownRight,
  FileText,
  MapPin,
  PencilLine,
  Share2,
  Wrench,
  Zap,
} from "lucide-react";
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
import { useSettings, DEFAULT_MODEL } from "./useSettings";
import { useSkills } from "./useSkills";
import { type ChatItem, useTurnStream } from "./useTurnStream";

// The Atlas globe pulls in three.js (~heavy) — load it only when the panel is
// opened, so the initial app bundle stays lean.
const GlobePanel = lazy(() =>
  import("@/components/panels/GlobePanel").then((m) => ({ default: m.GlobePanel })),
);

// The memory graph pulls in three.js + the force-graph lib — code-split it so
// the initial bundle stays lean; it renders full-canvas in the main area.
const MemoryView = lazy(() =>
  import("@/components/MemoryView").then((m) => ({ default: m.MemoryView })),
);

const RAIL_KEY = "hemiunu.rail.collapsed";

// Built-in slash commands — they map to UI actions (a panel or new chat), run
// immediately on select. Skills (user-defined) are merged in by the composer.
const COMMANDS: { name: string; desc: string; panel: Panel | null }[] = [
  { name: "new", desc: "start a new conversation", panel: null },
  { name: "conversations", desc: "browse past conversations", panel: "conversations" },
  { name: "teams", desc: "switch / manage teams", panel: "teams" },
  { name: "prototypes", desc: "view the prototype brief", panel: "prototypes" },
  { name: "atlas", desc: "your world map of discovered monuments", panel: "atlas" },
  { name: "memory", desc: "explore & edit the agent's memory", panel: "memory" },
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
    question,
    lastCost,
    send,
    respond,
    answerQuestion,
    stop,
    reset,
    loadConversation,
    currentSessionId,
    // Refresh settings the instant the agent creates/switches a team mid-turn,
    // so the workspace indicator updates without waiting for the turn to end.
  } = useTurnStream(refresh);
  const { skills, refresh: refreshSkills } = useSkills();
  const [draft, setDraft] = useState("");
  // Plan-first mode (/plan or the composer toggle): the next turns start
  // read-only — the agent proposes a plan and executes nothing until approved.
  const [planMode, setPlanMode] = useState(false);
  // Auto-accept mode: run tools without prompting. Set by approving a plan with
  // "auto" (or the composer toggle). Reset whenever the team changes (below) so
  // an auto grant for one repo never carries into another.
  const [autoAccept, setAutoAccept] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  // New-conversation reconcile: un-published prototype work that diverges from main.
  const [reconcile, setReconcile] = useState<{ summary: string | null; mainMoved: boolean } | null>(
    null,
  );
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_KEY) === "1");
  // One docked panel inside a single persistent shell. Switching just swaps the
  // shell's content (the column never closes/reopens), so there's no flash.
  // Opening collapses the rail and it stays collapsed afterwards.
  const [panel, setPanel] = useState<Panel | null>(null);
  // When set, the Atlas panel opens focused on this monument (from an earned-
  // monument card, or a ?atlas=<id> deep link the CLI announcement points to).
  const [focusMonument, setFocusMonument] = useState<string | null>(null);
  const openAtlas = useCallback((monumentId: string | null) => {
    setFocusMonument(monumentId);
    setRailAnimate(false);
    setPanel("atlas");
    setCollapsed(true);
  }, []);
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

  // Deep link: ?atlas=<monument-id> (the CLI's earned-monument announcement
  // links here) opens the Atlas focused on that monument, then clears the query
  // so a refresh doesn't keep reopening it.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("atlas");
    if (!id) return;
    openAtlas(id);
    const url = new URL(window.location.href);
    url.searchParams.delete("atlas");
    window.history.replaceState(null, "", url.pathname + url.search);
  }, [openAtlas]);

  // Auto-accept is a trust grant for ONE team's repo. When the active team
  // changes (the user switched, or the agent created/switched one mid-turn),
  // drop it so it never carries auto-approve into a different repo.
  const prevTeam = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const team = settings?.team ?? null;
    if (prevTeam.current !== undefined && prevTeam.current !== team) setAutoAccept(false);
    prevTeam.current = team;
  }, [settings?.team]);

  // On a new conversation (initial load + team switch), reconcile the team's tmp
  // workspace with main. If there's un-published work it surfaces a Keep / Fresh /
  // Publish prompt; otherwise (aligned / local / offline) it stays silent.
  const checkReconcile = useCallback(async () => {
    try {
      const r = (await fetch("/api/reconcile").then((res) => res.json())) as {
        status: string;
        summary: string | null;
        mainMoved: boolean;
      };
      setReconcile(r.status === "diverged" ? { summary: r.summary, mainMoved: r.mainMoved } : null);
    } catch {
      setReconcile(null);
    }
  }, []);
  useEffect(() => {
    void checkReconcile();
  }, [settings?.team, checkReconcile]);

  const resolveReconcile = useCallback(
    async (action: "keep" | "fresh" | "publish") => {
      setReconcileBusy(true);
      try {
        await sendJSON("/api/reconcile", { action });
      } catch {
        /* leave the workspace as-is on error */
      } finally {
        setReconcileBusy(false);
        setReconcile(null);
        if (action !== "keep") refresh();
      }
    },
    [refresh],
  );

  // The agent can create/switch/rename the team mid-turn (via the control
  // bridge). That only updates server-side state, so refresh settings when a
  // turn finishes to keep the visible team indicator in sync.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  // Keep the latest content in view as the turn streams — including when a
  // permission prompt or an ask_user question card appears, so the user always
  // sees the choices they need to act on.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, permission, question, busy]);

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
      if (name === "plan") {
        setPlanMode((v) => !v);
        setDraft("");
        return;
      }
      if (name === "auto") {
        setAutoAccept((v) => !v);
        setDraft("");
        return;
      }
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
          send(prompt, text, planMode, autoAccept);
        } catch {
          send(text, undefined, planMode, autoAccept);
        }
        return;
      }
    }
    send(text, undefined, planMode, autoAccept);
    setDraft("");
  }, [draft, busy, send, skills, runCommand, planMode, autoAccept]);

  const model = settings?.model ?? DEFAULT_MODEL;
  const empty = items.length === 0;
  const lastId = items[items.length - 1]?.id;

  // The two turn modifiers (plan-first / auto-accept) live right under the
  // composer as clear square pills with a gold "on" state — shown in BOTH the
  // empty Home and an ongoing thread, since they're bundled into `composer`.
  const toggleCls = (active: boolean) =>
    `inline-flex items-center gap-1.5 border px-2.5 py-1 text-[12.5px] transition-colors ${
      active
        ? "border-sun/40 bg-sun-soft font-medium text-sun"
        : "border-border text-ink-3 hover:bg-raised hover:text-ink-2"
    }`;

  const reconcilePrompt =
    reconcile && !permission ? (
      <div className="perm mb-2.5">
        <div className="perm-head">
          <CornerDownRight size={16} className="perm-icon" />
          <span>
            You have <strong>un-published prototype changes</strong> from a previous session
            {reconcile.mainMoved ? " (and main has moved on since)" : ""}.
          </span>
        </div>
        {reconcile.summary && <div className="perm-preview">Changed: {reconcile.summary}</div>}
        <div className="perm-actions">
          <Button size="sm" disabled={reconcileBusy} onClick={() => resolveReconcile("keep")}>
            Keep iterating
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={reconcileBusy}
            onClick={() => resolveReconcile("fresh")}
          >
            Start fresh from main
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={reconcileBusy}
            onClick={() => resolveReconcile("publish")}
          >
            Publish to main
          </Button>
        </div>
      </div>
    ) : null;

  const composer = (
    <>
      {reconcilePrompt}
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        busy={busy}
        onStop={stop}
        disabled={!!permission || !!question}
        model={model}
        onModelChange={setModel}
        autoFocus
        commands={COMMANDS.map((c) => ({ name: c.name, desc: c.desc }))}
        skills={skills}
        onRunCommand={runCommand}
      />
      <div className="mt-2.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <button
            className={toggleCls(planMode)}
            onClick={() => setPlanMode((v) => !v)}
            title="Plan-first: the agent proposes a plan and waits for your approval before doing anything"
          >
            <ClipboardList size={13} />
            {planMode ? "Plan-first: on" : "Plan-first"}
          </button>
          <button
            className={toggleCls(autoAccept)}
            onClick={() => setAutoAccept((v) => !v)}
            title="Auto-accept: run tools without asking. Per-team — resets when you switch teams."
          >
            <Zap size={13} />
            {autoAccept ? "Auto-accept: on" : "Auto-accept"}
          </button>
        </div>
        {lastCost && (
          <button
            className="inline-flex items-center gap-1 text-xs text-ink-4 hover:text-ink-2"
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
    </>
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
      <Sheet open={panel !== null && panel !== "memory"} onOpenChange={(o) => !o && setPanel(null)}>
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
            {panel === "atlas" && (
              <Suspense fallback={<p className="text-sm text-ink-3">Loading the globe…</p>}>
                <GlobePanel
                  open
                  onOpenChange={(o) => !o && setPanel(null)}
                  focusId={focusMonument}
                />
              </Suspense>
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
        {panel === "memory" ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-ink-3">
                Loading memory…
              </div>
            }
          >
            <MemoryView />
          </Suspense>
        ) : empty ? (
          <Home name={settings?.user ?? null} team={settings?.team ?? null} onPick={setDraft}>
            {composer}
          </Home>
        ) : (
          <>
            <div className="scroll" ref={scrollRef}>
              <div className="thread">
                {items.map((it) => (
                  <Item
                    key={it.id}
                    item={it}
                    streaming={busy && it.id === lastId}
                    onOpenAtlas={openAtlas}
                  />
                ))}

                {busy && !permission && items[items.length - 1]?.kind !== "agent" && (
                  <div className="thinking">
                    <StatusWord />
                  </div>
                )}

                {permission && permission.name === "ExitPlanMode" && (
                  <div className="perm">
                    <div className="perm-head">
                      <ClipboardList size={16} className="perm-icon" />
                      <span>
                        Hemiunu proposed a plan — <strong>ready to proceed?</strong>
                      </span>
                    </div>
                    <div className="perm-actions">
                      <Button
                        size="sm"
                        onClick={() => {
                          setPlanMode(false);
                          setAutoAccept(true);
                          respond("plan-auto");
                        }}
                      >
                        Yes — auto-accept edits
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setPlanMode(false);
                          respond("plan-manual");
                        }}
                      >
                        Yes — approve each step
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => respond("plan-refine")}>
                        No, keep planning
                      </Button>
                    </div>
                  </div>
                )}

                {permission && permission.name !== "ExitPlanMode" && (
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

                {question && (
                  <div className="perm">
                    <div className="perm-head">
                      <CircleHelp size={16} className="perm-icon" />
                      <span>
                        {question.header ? <strong>{question.header} — </strong> : null}
                        {question.question}
                      </span>
                    </div>
                    <div className="perm-actions flex-col items-stretch">
                      {question.options.map((o) => (
                        <Button
                          key={o.label}
                          size="sm"
                          variant="secondary"
                          className="h-auto min-h-9 w-full justify-start whitespace-normal py-2 text-left leading-snug"
                          onClick={() => answerQuestion(o.label)}
                          title={o.description}
                        >
                          <span>
                            <strong className="font-medium">{o.label}</strong>
                            {o.description ? (
                              <span className="text-ink-3"> — {o.description}</span>
                            ) : null}
                          </span>
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-auto min-h-9 w-full justify-start whitespace-normal py-2 text-left leading-snug"
                        onClick={() =>
                          answerQuestion(
                            "(the user wants to specify something else — ask them in plain text)",
                          )
                        }
                      >
                        Other / something else
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-gradient-to-b from-transparent to-ground px-7 pb-4 pt-2.5">
              <div className="mx-auto max-w-[760px]">{composer}</div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// A subagent's full final answer — the handoff it returned to the coordinator.
// Collapsed by default (the main agent's reply usually summarizes it); click to
// expand and read exactly what the specialist produced, rendered as markdown.
function AnswerItem({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  const agent = item.name ?? "subagent";
  const label = `${agent.charAt(0).toUpperCase()}${agent.slice(1)}'s answer`;
  return (
    <div className="activity-group answer-block">
      <button
        type="button"
        className="activity activity-summary expandable"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronDown size={14} className={`activity-chevron${open ? " open" : ""}`} />
        <FileText size={15} className="activity-icon" />
        <span className="activity-label">{label}</span>
        <span className="activity-hint">{open ? "hide" : "read"}</span>
      </button>
      {open && (
        <div className="answer-body">
          <Markdown text={item.text} />
        </div>
      )}
    </div>
  );
}

// A coalesced activity run: one summary row (icon + "Reading your files · 9 —
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

function Item({
  item,
  streaming,
  onOpenAtlas,
}: {
  item: ChatItem;
  streaming: boolean;
  onOpenAtlas: (monumentId: string | null) => void;
}) {
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
    case "answer":
      return <AnswerItem item={item} />;
    case "subagent":
      return <div className="subagent">{item.text}</div>;
    case "artifact":
      return item.url ? <ArtifactCard url={item.url} title={item.text} /> : null;
    case "atlas":
      return (
        <div className="atlas-card">
          <MapPin size={16} className="atlas-card-icon" />
          <span className="atlas-card-text">{item.text}</span>
          <button
            type="button"
            className="atlas-card-open"
            onClick={() => onOpenAtlas(item.monumentId ?? null)}
          >
            Open in your atlas →
          </button>
        </div>
      );
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
