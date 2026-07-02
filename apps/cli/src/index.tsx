import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  runTurn,
  applyMcpOAuth,
  startMcpAuth,
  completeMcpAuth,
  probeMcpServer,
  mcpOAuthStatus,
  REMEMBER_TOOL_ID,
  ASK_USER_TOOL_ID,
  resolveToolPolicy,
  setToolPolicy,
  PARALLEL_TOOL_ID,
  configDir,
  hasApiKey,
  writeUserEnv,
  upsertUserEnv,
  loadSkills,
  loadSkill,
  expandSkill,
  loadSourceMaps,
  runScan,
  SAVE_SOURCE_MAP_TOOL_ID,
  GET_SOURCE_MAP_TOOL_ID,
  resolveGithubToken,
  addTeam,
  removeTeam,
  cycleTeam,
  listTeams,
  currentTeam,
  setCurrentTeam,
  createRepo,
  renameRepo,
  renameTeam,
  renameWorkspace,
  repoExists,
  pruneTeams,
  migrateLocalIntoTeam,
  checkpointWorkspace,
  discardWorkspace,
  reconcileWorkspace,
  freshenWorkspace,
  publishWorkspace,
  askAnthropic,
  normalizeRepo,
  githubViewer,
  githubClientId,
  requestDeviceCode,
  pollDeviceToken,
  syncGithubStatus,
  connectGithubAccount,
  switchGithubAccount,
  disconnectGithub,
  listTrash,
  restoreTrash,
  setLocalSession,
  stopPreview,
  cloudflareConfigured,
  fetchCloudflareAccountId,
  setControlHandler,
  atlasUrl,
  addTeammate,
  removeTeammate,
  listOrgMembers,
  asStream,
  addPrototypeNote,
  type PermissionUpdate,
} from "@hemiunu/agent-core";
import { spawn } from "node:child_process";
import {
  clip,
  title,
  prettyTool,
  resultText,
  resultTextRaw,
  toolPreview,
  cleanResultPreview,
  reduceActivity,
  summarizeGroup,
  type ActivityGroup,
  type ActivityEvent,
} from "@hemiunu/format";
import { isBuiltinServer, loadMcpRegistry, sandboxStdioCwd } from "@hemiunu/mcp";
import {
  buildSystemPrompt,
  ConversationStore,
  loadContext,
  seedContextFiles,
} from "@hemiunu/memory";
import { Box, render, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useRef, useState } from "react";

// --- ancient-Egypt palette: gold leaf, lapis/faience, sandstone, papyrus ---
const SAND = "#d7af87"; // gold ochre — accents, the name, prompts
const SAGE = "#87af87"; // faded faience green — assistant voice
const STONE = "#9c8f78"; // weathered sandstone — carved boxes & borders
const PAPYRUS = "#c9b386"; // aged papyrus — secondary text
const LAPIS = "#7fa8c9"; // lapis lazuli — the `#` PROTOTYPE.md note command

// Retrieval tier the `researcher` subagent runs on (mirrors agent-core config).
const RESEARCH_MODEL = process.env.HEMIUNU_MODEL_RESEARCH ?? "claude-sonnet-4.6";

const LOGO = String.raw`
                                          _L/L
                                        _LT/l_L_
                                      _LLl/L_T_lL_
                  _T/L              _LT|L/_|__L_|_L_
                _Ll/l_L_          _TL|_T/_L_|__T__|_l_
              _TLl/T_l|_L_      _LL|_Tl/_|__l___L__L_|L_
            _LT_L/L_|_L_l_L_  _'|_|_|T/_L_l__T _ l__|__|L_
          _Tl_L|/_|__|_|__T _LlT_|_Ll/_l_ _|__[ ]__|__|_l_L_
   jjs_ _LT_l_l/|__|__l_T _T_L|_|_|l/___|__ | _l__|_ |__|_T_L_  __

                          nn_r   nn_r                 __
                    __   /l(\   /l)\      nn_r
              __                         /\(\    __`;

// The pyramid logo + the name, with an Egyptian-tinted subtitle.
function Banner() {
  return (
    <Box flexDirection="column">
      <Text color={SAND}>{LOGO}</Text>
      <Text>
        <Text color={SAND} bold>
          {"   HEMIUNU"}
        </Text>
        <Text color={PAPYRUS}>{"  ☥  product agent"}</Text>
      </Text>
    </Box>
  );
}

const HELP = [
  "Chat        /new  /clear  /compact  /list  /resume <id>",
  "Modes       /plan  /auto",
  "Setup       /models  /settings  /setup  /trust",
  "Sources     /mcp  /mcp-auth  /scan  /skills",
  "Connect     /github  /cloudflare",
  "Teams       /team  /team-new  /team-rename  /team-add  /team-remove",
  "Misc        /restore  /exit",
  "",
  "# <note>    save a line to the current team's PROTOTYPE.md",
].join("\n");

// Built-in commands, with one-line descriptions for the slash menu.
const BUILTIN_COMMANDS: { name: string; desc: string }[] = [
  { name: "new", desc: "start a new conversation" },
  { name: "clear", desc: "clear context and the screen" },
  { name: "compact", desc: "summarise & compact the context" },
  { name: "plan", desc: "toggle plan-first mode (propose a plan, then execute on approval)" },
  { name: "auto", desc: "toggle auto-accept for this team (run tools without asking)" },
  { name: "models", desc: "switch the model" },
  { name: "settings", desc: "view all settings (model, team, connections…)" },
  { name: "setup", desc: "show config & keys" },
  { name: "trust", desc: "toggle file access for this folder" },
  { name: "list", desc: "list saved conversations" },
  { name: "resume", desc: "resume a conversation by id" },
  { name: "mcp", desc: "show connected MCP servers" },
  { name: "mcp-auth", desc: "sign in to a remote MCP server (OAuth)" },
  { name: "scan", desc: "map connected sources (/scan or /scan <name>)" },
  { name: "skills", desc: "list saved skills" },
  { name: "github", desc: "connect / switch / disconnect GitHub accounts" },
  { name: "cloudflare", desc: "connect Cloudflare (for sharing): /cloudflare <api-token>" },
  { name: "team", desc: "switch team (feature/repo)" },
  { name: "team-new", desc: "new feature (name → create) or add a repo by URL" },
  { name: "team-rename", desc: "rename the current team's repo" },
  { name: "team-add", desc: "add a teammate to the current team (github username)" },
  { name: "team-remove", desc: "remove a teammate (needs owner rights)" },
  { name: "restore", desc: "recover files from the recycle bin" },
  { name: "help", desc: "show all commands" },
  { name: "exit", desc: "quit Hemiunu" },
];

// How many slash-menu rows are visible at once (the window scrolls past this).
const SLASH_MENU_ROWS = 8;

// Compacting prompt (Hermes-style structured state) — improve over time.
const COMPACT_PROMPT = `Compress the conversation so far into a compact brief that preserves all state needed to continue. If an earlier summary is present, fold it in and update it. Then stop.

Use these headings; keep each to short bullets and omit any that are empty:
- Goal: what the user is trying to achieve.
- Completed actions: what has been done, with outcomes.
- Active state: what is in progress right now.
- Blockers: anything stuck or waiting on input.
- Key decisions: choices made and the reasoning.
- Resolved questions: questions answered, and the answer.
- Relevant files / sources: files or data referenced.
- Open questions / next steps: what remains.

Be factual and concise. Output only the summary — no preamble.`;

// Context window adapts to the model (override with HEMIUNU_CONTEXT_WINDOW).
const ENV_WINDOW = process.env.HEMIUNU_CONTEXT_WINDOW
  ? Number(process.env.HEMIUNU_CONTEXT_WINDOW)
  : undefined;
function contextWindowFor(model: string): number {
  if (ENV_WINDOW) return ENV_WINDOW;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("grok")) return 256_000;
  if (m.includes("qwen")) return 256_000;
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3")) return 128_000;
  if (m.includes("llama") || m.includes("mistral") || m.includes("deepseek")) return 128_000;
  return 128_000;
}
const COMPACT_THRESHOLD = Number(process.env.HEMIUNU_COMPACT_THRESHOLD ?? 0.5);
// Guard against a non-numeric override: NaN would propagate through Math.min/max
// and make `ctxTokens >= ctxWindow * COMPACT_AT` always false, silently disabling
// auto-compaction until the context overflows.
const COMPACT_AT = Math.min(
  0.95,
  Math.max(0.1, Number.isFinite(COMPACT_THRESHOLD) ? COMPACT_THRESHOLD : 0.5),
);
const kfmt = (n: number) => `${Math.round(n / 1000)}k`;
/** A displayable message for an unknown thrown value. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Hieroglyph spinner (a glyph is "carved" each tick) + status words.
// NB: these live in the Egyptian Hieroglyphs Unicode block — if your terminal
// font lacks it they show as □; swap this set for supported symbols then.
const HIERO = ["𓂀", "𓁹", "𓆣", "𓇳", "𓋹", "𓊽", "𓅓", "𓏏", "𓃭", "𓎼", "𓊃", "𓉔"];
const WORDS = [
  "Excavating",
  "Deciphering",
  "Unearthing",
  "Decoding",
  "Surveying",
  "Translating",
  "Restoring",
  "Inscribing",
  "Exhuming",
  "Reconstructing",
  "Divining",
  "Charting",
  "Unrolling",
  "Aligning",
  "Quarrying",
  "Consulting",
  "Unsealing",
  "Transcribing",
  "Mapping",
  "Summoning",
];

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function tokfmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Open a URL in the OS default browser (best-effort). */
function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort — the URL is shown in the prompt regardless
  }
}

type PermValue = "yes" | "always" | "no" | "plan-auto" | "plan-manual" | "plan-refine";
const MENU_CHOICES: { label: string; value: PermValue }[] = [
  { label: "Yes", value: "yes" },
  { label: "Always allow this tool", value: "always" },
  { label: "No, and tell the agent what to do differently", value: "no" },
];
// Plan-approval menu (ExitPlanMode), matching Claude Code: accept and auto-run,
// accept but approve each step, or keep planning to refine with the agent.
const PLAN_CHOICES: { label: string; value: PermValue }[] = [
  { label: "Yes, and auto-accept edits", value: "plan-auto" },
  { label: "Yes, and manually approve edits", value: "plan-manual" },
  { label: "No, keep planning", value: "plan-refine" },
];

// Presentation formatters are shared with the web worker via @hemiunu/format
// (imported above) — one source of truth, no hand-kept duplication.

// Minimal inline markdown → Ink nodes: **bold**, `code`.
function mdInline(line: string, li: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[2] !== undefined)
      out.push(
        <Text key={`b${li}-${k}`} bold>
          {m[2]}
        </Text>,
      );
    else if (m[3] !== undefined)
      out.push(
        <Text key={`c${li}-${k}`} color={SAGE}>
          {m[3]}
        </Text>,
      );
    last = m.index + m[0].length;
    k++;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// Render text as markdown: # headers (bold) + inline bold/code.
function md(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  text.split("\n").forEach((line, li) => {
    if (li > 0) nodes.push("\n");
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      nodes.push(
        <Text key={`h${li}`} bold color={SAND}>
          {h[2]}
        </Text>,
      );
    } else {
      nodes.push(...mdInline(line, li));
    }
  });
  return nodes;
}

// --- scrollback items ---
type Item =
  | { kind: "banner" }
  | { kind: "user"; text: string }
  | { kind: "text"; text: string; sub?: boolean }
  | { kind: "tool"; name: string; input: string; sub?: boolean; delegate?: boolean }
  // A coalesced run of tool calls / one collapsed delegation, committed once the
  // group closes. `delegate` styles it like a delegation (the ⌂ glyph).
  | { kind: "group"; text: string; delegate?: boolean }
  | { kind: "result"; text: string; sub?: boolean }
  // A subagent's full final answer (the handoff it returned to the coordinator),
  // printed under the delegation so you can see what the specialist produced.
  | { kind: "answer"; agent: string; text: string }
  | { kind: "perm"; text: string; ok: boolean }
  | { kind: "cost"; text: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string };

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "banner":
      return <Banner />;
    case "user":
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={SAND} bold>
              {"› "}
            </Text>
            {item.text}
          </Text>
        </Box>
      );
    case "text":
      // A subagent's own narration — what it's looking for / what it found.
      // This is the meaningful explanation, so keep it readable (NOT dimmed,
      // unlike the surrounding tool lines); a sage marker + indent ties it to
      // the delegation while still standing apart from the main agent's answer.
      if (item.sub)
        return (
          <Box marginLeft={2}>
            <Text wrap="wrap">
              <Text color={SAGE} bold>
                {"› "}
              </Text>
              {item.text}
            </Text>
          </Box>
        );
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={SAGE} bold>
              {"⏺ "}
            </Text>
            {md(item.text)}
          </Text>
        </Box>
      );
    case "tool":
      // Delegation to a subagent — distinct glyph + the researcher's tier.
      if (item.delegate)
        return (
          <Box marginTop={1}>
            <Text>
              <Text color={SAND} bold>
                {"⌂ "}
              </Text>
              <Text color={SAND} bold>
                {prettyTool(item.name)}
              </Text>
              <Text dimColor>{` ${item.input}`}</Text>
            </Text>
          </Box>
        );
      // A tool the researcher ran — indented under the delegation, dimmer.
      if (item.sub)
        return (
          <Text dimColor>
            {"    ⌕ "}
            <Text color={SAGE}>{prettyTool(item.name)}</Text>
            {` ${item.input}`}
          </Text>
        );
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={SAGE} bold>
              {"⏺ "}
            </Text>
            <Text color={SAND} bold>
              {prettyTool(item.name)}
            </Text>
            <Text dimColor>{` ${item.input}`}</Text>
          </Text>
        </Box>
      );
    case "group":
      // A coalesced activity run, committed as one summary line.
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={item.delegate ? SAND : SAGE} bold>
              {item.delegate ? "⌂ " : "⏺ "}
            </Text>
            <Text dimColor>{item.text}</Text>
          </Text>
        </Box>
      );
    case "result":
      return <Text dimColor>{`${item.sub ? "      " : "  "}⎿ ${item.text}`}</Text>;
    case "answer": {
      // The subagent's full answer, printed under its delegation. A sand header
      // names the specialist; the body is indented and markdown-rendered so the
      // findings read cleanly, set apart from the main agent's own reply.
      const who = `${item.agent.charAt(0).toUpperCase()}${item.agent.slice(1)}`;
      return (
        <Box marginTop={1} marginLeft={2} flexDirection="column">
          <Text>
            <Text color={SAND} bold>
              {"⌂ "}
            </Text>
            <Text color={SAND} bold>
              {`${who}'s answer`}
            </Text>
          </Text>
          <Box marginLeft={2}>
            <Text wrap="wrap">{md(item.text)}</Text>
          </Box>
        </Box>
      );
    }
    case "perm":
      return (
        <Text>
          {"  "}
          <Text color={item.ok ? SAGE : SAND}>{item.ok ? "✓" : "✗"}</Text>
          <Text dimColor>{` ${item.text}`}</Text>
        </Text>
      );
    case "cost":
      return <Text dimColor>{`  ${item.text}`}</Text>;
    case "note":
      return (
        <Box marginTop={1}>
          <Text color={SAND}>{item.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color={SAND}>{`✗ ${item.text}`}</Text>
        </Box>
      );
  }
}

function App({
  store,
  registry,
  systemPrompt,
  initialModel,
  initialTeam,
  onClear,
}: {
  store: ConversationStore;
  registry: ReturnType<typeof loadMcpRegistry>;
  systemPrompt: string;
  initialModel: string;
  /** Team chosen at launch ("owner/repo"), or null for no-team/local. Pins this
   *  process in-memory, so a second terminal on another team can't change it. */
  initialTeam: string | null;
  onClear: () => void;
}) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([{ kind: "banner" }]);
  const [live, setLive] = useState("");
  // The active (still-open) activity group, mirrored in state so the live region
  // repaints as its count grows. Committed to <Static> as one line when it closes.
  const [group, setGroup] = useState<ActivityGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusLabel, setStatusLabel] = useState("thinking");
  const [permission, setPermission] = useState<{
    name: string;
    /** Menu options for this prompt (defaults to MENU_CHOICES; ExitPlanMode uses PLAN_CHOICES). */
    choices?: { label: string; value: PermValue }[];
    onChoice: (c: PermValue) => void;
  } | null>(null);
  const [sel, setSel] = useState(0);
  const [value, setValue] = useState("");
  const [sessionCost, setSessionCost] = useState(0);
  const [ctx, setCtx] = useState(0);
  const [epoch, setEpoch] = useState(0); // bump to remount <Static> (clear/compact)
  const [model, setModel] = useState(initialModel);
  // Plan-first mode (/plan): when on, every turn starts READ-ONLY — the agent
  // proposes a plan and executes nothing until you approve it. Persists until
  // toggled off; shown in the footer.
  const [planMode, setPlanMode] = useState(false);
  // Auto-accept mode: approve every gated tool without prompting (set by
  // accepting a plan with "auto", or toggled via /auto). It is PER-TEAM — saved
  // in each team's workspace snapshot and restored on switch — so an auto grant
  // for one repo never leaks into another. The ref is read inside canUseTool
  // (always current, even mid-turn); the state drives the footer indicator.
  const autoAcceptRef = useRef(false);
  const [autoAccept, setAutoAcceptState] = useState(false);
  const setAuto = (v: boolean) => {
    autoAcceptRef.current = v;
    setAutoAcceptState(v);
  };
  const [picker, setPicker] = useState<{
    title: string;
    options: string[];
    onChoice: (v: string | null) => void;
  } | null>(null);
  const [skills, setSkills] = useState(() => loadSkills());
  const [cmdSel, setCmdSel] = useState(0); // highlighted row in the slash menu
  const [memberSel, setMemberSel] = useState(0); // highlighted teammate suggestion
  const [orgMembers, setOrgMembers] = useState<string[]>([]); // members of the current team's org
  const memberCache = useRef<Map<string, string[]>>(new Map()); // org → members, fetched once
  const [teams, setTeams] = useState<string[]>(() => listTeams());
  const [team, setTeam] = useState<string | undefined>(initialTeam ?? undefined);
  const [device, setDevice] = useState<{ userCode: string; url: string } | null>(null);
  const githubLoginCancel = useRef(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null); // active GitHub account (footer)

  // Keep the footer's GitHub account label current after any auth change.
  const refreshGithubLogin = () => {
    // syncGithubStatus adopts an existing env/`gh` identity into the store so the
    // footer shows it (and it becomes switchable), then returns the active login.
    // Best-effort: a network/`gh` failure just leaves the footer label unchanged.
    void (async () => {
      try {
        setGithubLogin((await syncGithubStatus()).login ?? null);
      } catch {
        /* offline or gh unavailable — keep the current label */
      }
    })();
  };
  useEffect(refreshGithubLogin, []);

  // Detect a local filesystem server (it grants access to the launch folder).
  // It's a built-in capability, so it's gated by folder-trust and hidden from
  // the user-facing /mcp + /settings server lists (see hiddenServer below).
  const fsName = Object.keys(registry.mcpServers).find((n) =>
    isBuiltinServer(n, registry.mcpServers[n]),
  );
  const [fsTrust, setFsTrust] = useState<boolean | null>(() =>
    fsName ? (store.getFolderTrust(process.cwd()) ?? null) : true,
  );

  const ctxWindow = contextWindowFor(model);

  // Only expose the filesystem server once the user has trusted this folder.
  const fsOn = fsTrust === true || !fsName;
  const activeServers = fsOn
    ? registry.mcpServers
    : Object.fromEntries(Object.entries(registry.mcpServers).filter(([n]) => n !== fsName));
  const activePatterns = fsOn
    ? registry.toolPatterns
    : registry.toolPatterns.filter((p) => !p.startsWith(`mcp__${fsName}__`));

  const sessionId = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const liveRef = useRef("");
  const groupRef = useRef<ActivityGroup | null>(null);
  const alwaysAllow = useRef(new Set<string>());
  const permChain = useRef<Promise<unknown>>(Promise.resolve());
  const compactedRef = useRef(""); // summary injected after /compact
  const justCompactedRef = useRef(false); // skip auto-compact the turn right after one
  // Each project (= team/repo) keeps its own foreground context; switching swaps
  // the whole lot. The active project lives in the React state/refs above; the
  // others are parked here, keyed by repo.
  const workspaces = useRef(
    new Map<
      string,
      {
        items: Item[];
        sessionId?: string;
        compacted: string;
        ctx: number;
        cost: number;
        autoAccept?: boolean;
      }
    >(),
  );
  const currentProjectRef = useRef<string | undefined>(initialTeam ?? undefined);
  const turnStartRef = useRef(0); // ms timestamp when the current turn began
  const turnTokensRef = useRef(0); // estimated output tokens this turn
  const [, setTick] = useState(0); // drives the live status-line animation

  // Animate the status line while a turn is running.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 140);
    return () => clearInterval(id);
  }, [busy]);

  const push = (it: Item) => setItems((prev) => [...prev, it]);

  // Commit the open activity group (if any) to scrollback as one summary line.
  // <Static> never re-renders a committed item, so the group lives in the live
  // region while open and only lands here when it closes.
  const flushGroup = () => {
    const g = groupRef.current;
    if (g) push({ kind: "group", text: summarizeGroup(g), delegate: g.kind === "delegation" });
    groupRef.current = null;
    setGroup(null);
  };

  // Fold one normalized activity event into the open group, committing the prior
  // group first when this event starts a different one.
  const feedActivity = (e: ActivityEvent) => {
    const { group: next, flushed } = reduceActivity(groupRef.current, e);
    if (flushed)
      push({
        kind: "group",
        text: summarizeGroup(flushed),
        delegate: flushed.kind === "delegation",
      });
    groupRef.current = next;
    setGroup(next);
  };

  // Open the folder-trust prompt (also used by /trust) and remember the choice.
  function promptTrust() {
    setSel(0);
    setPicker({
      title: `Allow Hemiunu to read & write files in this folder?\n  ${process.cwd()}`,
      options: ["Yes, allow file access", "No, keep files private"],
      onChoice: (v) => {
        setPicker(null);
        const ok = !!v && v.startsWith("Yes");
        setFsTrust(ok);
        store.setFolderTrust(process.cwd(), ok);
        push({
          kind: "note",
          text: ok
            ? "· file access allowed (remembered for this folder)"
            : "· file access disabled (remembered for this folder)",
        });
      },
    });
  }

  // On a new conversation, reconcile the selected team's tmp workspace with main.
  // Because a validated publish clears the workspace, a surviving one means there's
  // un-published work — so if it diverges from main, ask whether to keep iterating,
  // start fresh from main, or publish it now. No-op for local (no-team) prototypes
  // (no main to pull) and when offline / not signed in.
  async function promptReconcile() {
    const team = currentProjectRef.current;
    if (!team) return;
    const token = resolveGithubToken();
    if (!token) return;
    let rec: Awaited<ReturnType<typeof reconcileWorkspace>>;
    try {
      rec = await reconcileWorkspace(team, { token });
    } catch {
      return;
    }
    if (rec.status !== "diverged") return;
    const KEEP = "Keep iterating on the un-published work";
    const FRESH = "Start fresh from main (current work → recycle bin)";
    const PUBLISH = "Publish the un-published work to main now";
    setSel(0);
    setPicker({
      title: `${team}: you have un-published prototype changes from a previous session${
        rec.mainMoved ? " (and main has moved on since)" : ""
      }.${rec.summary ? `\n  Changed: ${clip(rec.summary, 100)}` : ""}\nWhat should I do?`,
      options: [KEEP, FRESH, PUBLISH],
      onChoice: (v) => {
        setPicker(null);
        if (!v || v === KEEP) {
          push({
            kind: "note",
            text: "· keeping your un-published work — picking up where you left off",
          });
          return;
        }
        void (async () => {
          try {
            if (v === FRESH) {
              const { binned } = await freshenWorkspace(team, { token });
              push({
                kind: "note",
                text: `↻ started fresh from main${binned ? " — previous work saved to the recycle bin (/restore)" : ""}`,
              });
            } else if (v === PUBLISH) {
              const login = (await githubViewer(token)) ?? undefined;
              const r = await publishWorkspace(team, { token, login });
              push({
                kind: "note",
                text: r.ok
                  ? `⤴ published your previous work to ${team} (main)`
                  : `couldn't publish: ${r.note}`,
              });
            }
          } catch (e) {
            push({
              kind: "note",
              text: `reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        })();
      },
    });
  }

  // On startup: prompt if this folder hasn't been decided, else note the memory.
  useEffect(() => {
    if (!fsName) return;
    if (fsTrust === null) promptTrust();
    else
      push({
        kind: "note",
        text: `· file access ${fsTrust ? "allowed" : "disabled"} for this folder (remembered — /trust to change)`,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On a fresh launch (a new conversation), reconcile un-published work with main.
  // Skipped on resume, and deferred when the folder-trust prompt owns the picker
  // (they share one slot) — that rare first-decision launch skips the check.
  useEffect(() => {
    if (sessionId.current) return;
    if (fsName && fsTrust === null) return;
    void promptReconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On startup, drop saved teams whose GitHub repos no longer exist / aren't
  // accessible, so the switcher only shows teams that are really there.
  useEffect(() => {
    void syncTeamsWithGithub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Let the agent drive team create/switch (no-team onboarding) via the control
  // bridge, so the footer + conversation + workspace stay consistent.
  useEffect(() => {
    setControlHandler(async (e) => {
      if (e.type === "ask-user") {
        // Ask each question in turn via the picker; collect the chosen labels.
        const answers: string[] = [];
        for (const q of e.questions) {
          const OTHER = "Other / let me type it";
          const choice = await new Promise<string>((resolve) => {
            setSel(0);
            setPicker({
              title: `${q.header ? `${q.header} — ` : ""}${q.question}`,
              options: [...q.options.map((o) => o.label), OTHER],
              onChoice: (v) => {
                setPicker(null);
                resolve(v ?? "(no answer)");
              },
            });
          });
          answers.push(
            choice === OTHER
              ? `${q.header}: (the user wants to specify something else — ask them in plain text)`
              : `${q.header}: ${choice}`,
          );
        }
        return answers.join("\n");
      }
      if (e.type === "create-team") {
        return await createAndAdoptTeam(e.name);
      }
      if (e.type === "rename-team") {
        return await renameCurrentTeam(e.name);
      }
      if (e.type === "discovery") {
        // A monument earned by publishing to main — announce it and link to the
        // Atlas (the web app's world map) focused on the new find.
        push({ kind: "note", text: e.line });
        push({ kind: "note", text: `🗺️  Open it in your atlas → ${atlasUrl(e.monumentId)}` });
        return "Announced the discovery to the user.";
      }
      const repo = normalizeRepo(e.repo);
      if (!listTeams().includes(repo)) {
        return `'${repo}' isn't one of the user's teams — use create_team, or they can add it with /team-new ${repo}.`;
      }
      await bringLocalWorkInto(repo); // carry any local work into the repo first
      adoptTeam(repo);
      push({ kind: "note", text: `· team set to ${repo}` });
      return `Now working in ${repo}.`;
    });
    return () => setControlHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // System prompt = soul/user/memory + connected sources (active) + skills + compacted summary.
  const effectiveSystem = () => {
    const names = Object.keys(activeServers);
    const sources = names.length
      ? `\n\n## Connected data sources\nThese tools/data sources are connected right now: ${names.join(", ")}. When asked about anything you can't answer from general knowledge, search them before responding, and ground your answer in what you find.`
      : "";
    // Surface saved skills (name + description only — progressive disclosure) so
    // the agent can discover when one applies. Read fresh so newly-saved skills
    // appear without a restart. The full body is loaded only when a skill runs.
    const skills = loadSkills();
    const skillList = skills.length
      ? `\n\n## Skills (saved, reusable procedures)\nThe user has saved skills, runnable as /<name>. When a request clearly matches a skill's description, follow that skill: read its full instructions with the get_skill tool and carry them out. Don't force a skill when none fits. Available:\n${skills
          .map((s) => `- /${s.name} — ${s.description || "(no description)"}`)
          .join("\n")}`
      : "";
    // Surface source maps (frontmatter only — progressive disclosure) for the
    // sources connected right now, so the agent knows what's inside each and can
    // pull the full map (page/db ids, how to query) on demand with get_source_map.
    const maps = loadSourceMaps().filter((m) => names.includes(m.mcp));
    const mapped = new Set(maps.map((m) => m.mcp));
    const unmapped = names.filter((n) => !mapped.has(n));
    const sourceMaps = maps.length
      ? `\n\n## Source maps (what's inside each connected source)\nBefore searching a source, consult its map with get_source_map (it has key page/database ids + how to query) so you go straight to the right place. Keep maps current: if you find one is out of date, fix it with save_source_map.${
          unmapped.length
            ? ` Connected sources with no map yet: ${unmapped.join(", ")} — suggest /scan to map them.`
            : ""
        }\n${maps.map((m) => `- ${m.mcp} — ${m.description || "(no description)"}`).join("\n")}`
      : "";
    const summary = compactedRef.current
      ? `\n\n## Summary of earlier conversation (compacted)\n${compactedRef.current}`
      : "";
    return systemPrompt + sources + skillList + sourceMaps + summary;
  };

  // Permission gate: queued so concurrent requests ask one menu at a time.
  const canUseTool = (toolName: string, input: Record<string, unknown>) => {
    const run = permChain.current.then(
      () =>
        new Promise((resolve) => {
          // The agent's own memory tool is auto-approved (transparent, low-risk):
          // it only appends to context/user.md|memory.md. Shown as a note.
          if (toolName === REMEMBER_TOOL_ID) {
            const tgt = typeof input.target === "string" ? input.target : "";
            const note = typeof input.note === "string" ? input.note : "";
            push({
              kind: "note",
              text: `✎ remembered${tgt ? ` (${tgt})` : ""}: ${clip(note, 80)}`,
            });
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          // Source-map read/write are local & low-risk (only touch
          // ~/.hemiunu/sources). Auto-approve; a save shows as a note.
          if (toolName === GET_SOURCE_MAP_TOOL_ID) {
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          if (toolName === SAVE_SOURCE_MAP_TOOL_ID) {
            const mcp = typeof input.mcp === "string" ? input.mcp : "";
            push({ kind: "note", text: `✎ source map updated${mcp ? `: ${mcp}` : ""}` });
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          // Asking the user IS the action — never gate it behind a "may I ask?"
          // prompt. Auto-approve; the question itself is the interaction.
          if (toolName === ASK_USER_TOOL_ID) {
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          // Planning tools (built-in). TodoWrite + EnterPlanMode are internal &
          // read-only — auto-approve, shown as a progress note. ExitPlanMode is
          // the plan-approval gate: render the plan, then fall through to the
          // normal yes/no prompt below.
          if (toolName === "TodoWrite") {
            const todos = Array.isArray(input.todos)
              ? (input.todos as { status?: string; activeForm?: string; content?: string }[])
              : [];
            const done = todos.filter((t) => t?.status === "completed").length;
            const active = todos.find((t) => t?.status === "in_progress");
            const label = active?.activeForm || active?.content || "";
            push({
              kind: "note",
              text: `◷ plan · ${done}/${todos.length}${label ? ` — ${clip(label, 60)}` : ""}`,
            });
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          if (toolName === "EnterPlanMode") {
            push({ kind: "note", text: "◷ planning — researching before proposing an approach…" });
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          // ExitPlanMode: the plan-approval gate. Render the plan, then show the
          // three-way Claude-Code menu (auto-accept / manual / keep planning).
          if (toolName === "ExitPlanMode") {
            const plan = typeof input.plan === "string" ? input.plan : "";
            if (plan) push({ kind: "note", text: `Proposed plan:\n${plan}` });
            flushGroup();
            setSel(0);
            setPermission({
              name: toolName,
              choices: PLAN_CHOICES,
              onChoice: (choice) => {
                setPermission(null);
                if (choice === "plan-refine") {
                  push({ kind: "perm", ok: false, text: "keep planning — refining the plan" });
                  resolve({
                    behavior: "deny",
                    message:
                      "The user wants to keep refining the plan before any execution. Discuss and revise the plan with them; do not start building yet.",
                  });
                  return;
                }
                // Accepted: leave plan-first mode and exit the SDK's read-only
                // plan mode so the plan executes. "auto" turns on auto-accept
                // (every following tool runs without a prompt — per this team);
                // "manual" approves each step.
                setPlanMode(false);
                if (choice === "plan-auto") setAuto(true);
                push({
                  kind: "perm",
                  ok: true,
                  text:
                    choice === "plan-auto"
                      ? "plan approved — auto-accepting the steps"
                      : "plan approved — approving each step",
                });
                resolve({
                  behavior: "allow",
                  updatedInput: input,
                  updatedPermissions: [
                    { type: "setMode", mode: "default", destination: "session" },
                  ],
                });
              },
            });
            return;
          }
          // Auto-accept mode: approve every gated tool without a prompt (covers
          // the MCP write tools that `acceptEdits` alone wouldn't). The ref is
          // current even within the turn a plan was just approved in.
          if (autoAcceptRef.current) {
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          // Persistent per-tool policy — an "always allow" is saved here, so it
          // survives across turns, auto-compaction, and restarts (the session Set
          // alone was lost when the session reset mid-conversation). "block" hard-
          // denies. resolveToolPolicy reads fresh each call.
          const policy = resolveToolPolicy(toolName);
          if (policy === "block") {
            push({ kind: "perm", ok: false, text: `blocked ${prettyTool(toolName)}` });
            resolve({ behavior: "deny", message: "Blocked in your tool settings." });
            return;
          }
          if (policy === "allow" || alwaysAllow.current.has(toolName)) {
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          // Commit any open activity group so its line orders above the prompt.
          flushGroup();
          setSel(0);
          setPermission({
            name: toolName,
            onChoice: (choice) => {
              setPermission(null);
              if (choice === "always") {
                alwaysAllow.current.add(toolName); // immediate
                setToolPolicy(toolName, "allow"); // persist — "always" must stick
              }
              push({
                kind: "perm",
                ok: choice !== "no",
                text: `${choice === "always" ? "always allowed" : choice === "yes" ? "allowed" : "denied"} ${prettyTool(toolName)}`,
              });
              resolve(
                choice === "no"
                  ? { behavior: "deny", message: "Denied by user." }
                  : { behavior: "allow", updatedInput: input },
              );
            },
          });
        }),
    );
    permChain.current = run.then(
      () => {},
      () => {},
    );
    return run as Promise<
      | {
          behavior: "allow";
          updatedInput: Record<string, unknown>;
          updatedPermissions?: PermissionUpdate[];
        }
      | { behavior: "deny"; message: string }
    >;
  };

  async function runUserTurn(text: string) {
    const skipAuto = justCompactedRef.current;
    justCompactedRef.current = false;
    turnStartRef.current = Date.now();
    turnTokensRef.current = 0;
    push({ kind: "user", text });
    setBusy(true);
    setStatusLabel("thinking");
    liveRef.current = "";
    setLive("");
    const ac = new AbortController();
    abortRef.current = ac;
    // If the team we'd run in was deleted on GitHub, drop to local and continue.
    if (currentProjectRef.current && !(await ensureTeamAlive(currentProjectRef.current)))
      switchProject(null);
    let cost: number | null = null;
    let usage: Record<string, number> | undefined;
    let fullText = "";
    // Tool-call ids of delegations (Task/parallel) → the subagent that ran them.
    // Their results are the subagent's final answer; we print it in full as an
    // `answer` block under the delegation rather than dumping a raw brief line.
    const delegateIds = new Map<string, string>();

    try {
      for await (const m of runTurn({
        prompt: text,
        model,
        systemPrompt: effectiveSystem(),
        resume: sessionId.current,
        canUseTool,
        ...(planMode ? { permissionMode: "plan" as const } : {}),
        mcpServers: await applyMcpOAuth(activeServers),
        toolPatterns: activePatterns,
        abortController: ac,
        // Pin this turn to the team it started in, so its file/GitHub tools
        // target that repo even if the foreground team is switched mid-turn.
        workspace: { repo: currentProjectRef.current || null },
        // Live visibility into parallel subtasks (otherwise opaque).
        onSubagentEvent: (e) => {
          // Fold parallel-fan-out progress into the single delegation group rather
          // than pushing a line per task-start/tool/done.
          if (e.type === "task-start") {
            feedActivity({ type: "delegate", agent: e.agent, label: "Working in parallel" });
          } else if (e.type === "task-tool") {
            feedActivity({ type: "subtool", taskLabel: e.label, toolLabel: prettyTool(e.tool) });
          } else {
            feedActivity({ type: "subdone", taskLabel: e.label, ok: e.ok });
          }
          setStatusLabel("parallel");
        },
      })) {
        const msg = asStream(m);
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId.current = msg.session_id;
        } else if (msg.type === "assistant") {
          const sub = !!msg.parent_tool_use_id;
          for (const b of msg.message?.content ?? []) {
            if (b.type === "text") {
              const txt = b.text ?? "";
              // A subagent's step narration ("Building the Header", "Fixing …").
              // Surface it as a readable, indented step line under the delegation
              // (kind:"text"+sub) so the build is legible — not saved to the
              // transcript, not folded into the bare step count.
              if (sub) {
                const tx = txt.trim();
                if (tx) push({ kind: "text", text: clip(tx, 200), sub: true });
                continue;
              }
              // Top-level prose resumes — close any open activity group first so
              // it lands in scrollback above the answer.
              if (txt.trim()) flushGroup();
              fullText += txt;
              liveRef.current += txt;
              turnTokensRef.current += Math.ceil(txt.length / 4);
              setLive(liveRef.current);
            } else if (b.type === "tool_use") {
              if (liveRef.current.trim()) push({ kind: "text", text: liveRef.current });
              liveRef.current = "";
              setLive("");
              if (b.name === PARALLEL_TOOL_ID) {
                if (b.id) delegateIds.set(b.id, "parallel");
                feedActivity({ type: "delegate", agent: "parallel", label: "Working in parallel" });
                setStatusLabel("parallel");
              } else if (b.name === "Agent" || b.name === "Task") {
                const who = String(b.input?.subagent_type ?? "subagent");
                if (b.id) delegateIds.set(b.id, who);
                const LABELS: Record<string, string> = {
                  researcher: "Researcher",
                  prototyper: "Prototyper",
                  designer: "Designer",
                };
                const STATUS: Record<string, string> = {
                  prototyper: "prototyping",
                  designer: "designing",
                };
                const label = LABELS[who] ?? who;
                feedActivity({ type: "delegate", agent: who, label });
                setStatusLabel(STATUS[who] ?? "researching");
              } else if (sub) {
                // A nested tool from an SDK-delegated subagent — fold into the group.
                feedActivity({
                  type: "subtool",
                  taskLabel:
                    groupRef.current?.kind === "delegation" ? groupRef.current.agent : "subagent",
                  toolLabel: prettyTool(b.name ?? "tool"),
                  preview: toolPreview(b.input),
                });
                setStatusLabel("researching");
              } else {
                feedActivity({
                  type: "tool",
                  label: prettyTool(b.name ?? "tool"),
                  preview: toolPreview(b.input),
                });
                setStatusLabel("running");
              }
            }
          }
        } else if (msg.type === "user") {
          const sub = !!msg.parent_tool_use_id;
          for (const b of msg.message?.content ?? []) {
            if (b.type === "tool_result") {
              // A delegation's result is the subagent's final answer — print it in
              // full as an `answer` block (keyed to the subagent) rather than
              // dropping it or flattening it into a one-line summary.
              if (b.tool_use_id && delegateIds.has(b.tool_use_id)) {
                const agent = delegateIds.get(b.tool_use_id) ?? "subagent";
                const answer = resultTextRaw(b.content);
                if (answer) {
                  flushGroup();
                  push({ kind: "answer", agent, text: answer });
                }
                continue;
              }
              const t = resultText(b.content);
              if (!t) continue;
              // Only a CLEAN structured summary (count / title / file tally) is
              // worth showing; raw dumps, oversized output and errors are dropped
              // so they never flood the activity stream.
              const summary = cleanResultPreview(t);
              if (!summary || sub) continue;
              const g = groupRef.current;
              // Fold the result into the live group as its latest detail (a
              // top-level tool-run shows the result inline), not a separate line.
              if (g && g.kind === "tool-run") {
                const next = { ...g, preview: summary };
                groupRef.current = next;
                setGroup(next);
              } else if (!g) {
                push({ kind: "result", text: summary });
              }
            }
          }
          setStatusLabel(sub ? "researching" : "thinking");
        } else if (msg.type === "result") {
          cost = msg.total_cost_usd ?? null;
          usage = msg.usage;
        }
      }
      flushGroup();
      if (liveRef.current.trim()) push({ kind: "text", text: liveRef.current });
    } catch (e) {
      // Commit the partial group so the work-so-far survives an interrupt/error.
      flushGroup();
      if (ac.signal.aborted) push({ kind: "note", text: "⎯ interrupted" });
      else push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
      liveRef.current = "";
      setLive("");
      groupRef.current = null;
      setGroup(null);
      setBusy(false);
    }

    if (cost != null) {
      push({ kind: "cost", text: `$${cost.toFixed(4)} · ${usage?.output_tokens ?? 0} out` });
      setSessionCost((c) => c + (cost as number));
    }
    const ctxTokens =
      (usage?.input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0);
    if (ctxTokens) setCtx(ctxTokens);

    const sid = sessionId.current;
    if (sid) {
      store.ensureConversation(sid, title(text), model);
      store.addMessage(sid, "user", text);
      store.addMessage(sid, "assistant", fullText, cost);
    }

    // Auto-checkpoint prototype work to the team's checkpoint branch so it always
    // reaches GitHub (no-op if there's no team, no checkout, or nothing changed —
    // the default branch stays clean; publishing there is an explicit step).
    const team = currentProjectRef.current;
    if (team) {
      const token = resolveGithubToken();
      const login = token ? ((await githubViewer(token)) ?? undefined) : undefined;
      const cp = await checkpointWorkspace(team, {
        token,
        login,
        message: title(text),
      });
      if (cp.pushed) push({ kind: "note", text: `⤴ progress saved (not yet published to main)` });
    }

    // Auto-compact when context crosses the threshold (Hermes-style). Done
    // silently in the background — no note and no summary shown; only an
    // explicit /compact surfaces the result.
    if (!skipAuto && ctxTokens >= ctxWindow * COMPACT_AT) {
      await runCompact({ silent: true });
    }
  }

  // Switch the foreground project: park the current context and restore the
  // target's (scrollback, conversation/session, compaction, context, cost). A
  // never-seen project starts fresh. The footer reflects the new project.
  function switchProject(target: string | null) {
    const key = target ?? ""; // "" = no team / local
    const fromKey = currentProjectRef.current ?? "";
    if (key === fromKey) return;
    stopPreview(); // the previous team's localhost preview is no longer current
    workspaces.current.set(fromKey, {
      items,
      sessionId: sessionId.current,
      compacted: compactedRef.current,
      ctx,
      cost: sessionCost,
      autoAccept: autoAcceptRef.current,
    });
    setCurrentTeam(target); // persist so the agent's tools follow the selection
    const ws = workspaces.current.get(key);
    currentProjectRef.current = key;
    setTeam(target ?? undefined);
    sessionId.current = ws?.sessionId;
    compactedRef.current = ws?.compacted ?? "";
    justCompactedRef.current = false;
    setCtx(ws?.ctx ?? 0);
    setSessionCost(ws?.cost ?? 0);
    // Auto-accept is per-team: restore the target team's grant (default off), so
    // switching into a different repo never inherits another team's auto-approve.
    setAuto(ws?.autoAccept ?? false);
    setItems(
      ws?.items ?? [
        { kind: "banner" },
        { kind: "note", text: target ? `· team ${target}` : "· no team — working locally" },
      ],
    );
    setEpoch((e) => e + 1);
  }

  // Re-scan all saved teams against GitHub; drop dead ones; refresh the switcher;
  // fall the current selection back to local if it was removed. No-op offline.
  async function syncTeamsWithGithub(): Promise<void> {
    const token = resolveGithubToken();
    if (!token) return;
    // Best-effort startup cleanup — a GitHub outage must not crash the app.
    let removed: string[];
    try {
      removed = await pruneTeams(token);
    } catch {
      return;
    }
    if (!removed.length) return;
    setTeams(listTeams());
    if (currentProjectRef.current && removed.includes(currentProjectRef.current))
      switchProject(null);
    push({
      kind: "note",
      text: `· removed ${removed.length} team${removed.length > 1 ? "s" : ""} no longer on GitHub: ${removed.join(", ")}`,
    });
  }

  // Verify one team's repo still exists before switching into / running it.
  // Gone → prune, refresh, note, return false so the caller can drop to local.
  // Returns true when alive OR unverifiable (offline → don't block the user).
  async function ensureTeamAlive(repo: string): Promise<boolean> {
    const token = resolveGithubToken();
    if (!token) return true;
    if (await repoExists(token, repo)) return true;
    removeTeam(repo);
    discardWorkspace(repo, "team repo no longer on GitHub"); // clean its tmp workspace (binned, /restore)
    setTeams(listTeams());
    push({ kind: "note", text: `· ${repo} no longer on GitHub — working locally` });
    return false;
  }

  // Switch into a team: verify its repo is alive, carry any local work into the
  // checkout, then make it current. Drops to local if the repo is gone. Wrapped
  // so a network/git failure surfaces as an error item instead of an unhandled
  // rejection (these run detached from the render as fire-and-forget IIFEs).
  async function enterTeam(target: string, opts: { note?: boolean } = {}): Promise<void> {
    try {
      if (!(await ensureTeamAlive(target))) {
        switchProject(null);
        return;
      }
      await bringLocalWorkInto(target);
      switchProject(target);
      if (opts.note) push({ kind: "note", text: `· switched to team ${target}` });
    } catch (e) {
      push({ kind: "error", text: `✗ couldn't switch to ${target}: ${errText(e)}` });
    }
  }

  // Set the current team WITHOUT resetting the conversation — used by the
  // no-team onboarding flow to promote the ongoing chat into a team and continue.
  function adoptTeam(repo: string) {
    setCurrentTeam(repo);
    currentProjectRef.current = repo;
    setTeam(repo);
    setTeams(listTeams());
  }

  // AI cleanup for a PROTOTYPE.md merge: when the adopted repo already has a
  // knowledge file, fold it with the local one — drop superseded entries, merge
  // duplicates, keep everything still relevant. Runs through askAnthropic, which
  // uses the brain's own key/endpoint, so it works for every user (proxy OR
  // direct Anthropic). Best-effort: returns null on any failure so the migration
  // falls back to a lossless textual concat and never loses team knowledge.
  async function reconcilePrototype({
    local,
    remote,
  }: {
    local: string;
    remote: string;
  }): Promise<string | null> {
    const res = await askAnthropic({
      model: RESEARCH_MODEL,
      maxTokens: 4000,
      system:
        "You merge two versions of a feature's PROTOTYPE.md knowledge file into one. " +
        "Keep the YAML frontmatter (use the most recent `updated` date). Preserve every still-relevant " +
        "decision, open question, and piece of feedback. Drop entries a later one clearly supersedes, and " +
        "fold duplicates or near-duplicates together. Do not invent content. " +
        "Return ONLY the merged Markdown file — no commentary, no code fences.",
      prompt: `# Existing repo PROTOTYPE.md\n\n${remote}\n\n---\n\n# Local session PROTOTYPE.md\n\n${local}`,
    });
    if ("error" in res) {
      push({
        kind: "note",
        text: `· PROTOTYPE.md merged (AI cleanup skipped: ${res.error.slice(0, 80)})`,
      });
      return null;
    }
    const cleaned = res.text
      .replace(/^```(?:markdown|md)?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    return cleaned || null;
  }

  // Bring the current local (no-team) work into `repo` before entering it, so
  // nothing made while working locally is left behind. No-ops unless this session
  // is actually local — safe to call before any adopt/switch. PROTOTYPE.md is
  // merged (AI-reconciled) into the repo's existing one rather than overwritten.
  async function bringLocalWorkInto(repo: string): Promise<void> {
    if ((currentProjectRef.current ?? "") !== "") return; // only when coming FROM local
    const token = resolveGithubToken();
    if (!token) {
      push({
        kind: "note",
        text: `· can't move local work into ${repo} — not signed in to GitHub (/github)`,
      });
      return;
    }
    const login = (await githubViewer(token)) ?? undefined;
    const mig = await migrateLocalIntoTeam(repo, { token, login, reconcile: reconcilePrototype });
    if (mig.migrated.length)
      push({
        kind: "note",
        text: `· moved your local work into ${repo} (${mig.migrated.join(", ")})${mig.pushed ? "" : ` — ${mig.note}`}`,
      });
  }

  // Create a private repo for the current work, push any LOCAL prototype work
  // into it, and adopt it as the team — all without resetting the conversation
  // or redrawing the banner. Pushes a progress note; returns a summary string.
  async function createAndAdoptTeam(name: string): Promise<string> {
    const token = resolveGithubToken();
    if (!token) {
      const m = "Not signed in to GitHub — run /github first.";
      push({ kind: "note", text: `· ${m}` });
      return m;
    }
    push({ kind: "note", text: `· creating private repo ${name}…` });
    const r = await createRepo(token, name, { private: true });
    if ("error" in r) {
      const m = `couldn't create repo: ${r.error}`;
      push({ kind: "error", text: m });
      return m;
    }
    const repo = addTeam(r.repo);
    const login = (await githubViewer(token)) ?? undefined;
    const mig = await migrateLocalIntoTeam(repo, { token, login, reconcile: reconcilePrototype });
    adoptTeam(repo);
    const summary = mig.migrated.length
      ? `created ${repo} (private) and pushed your local work (${mig.migrated.join(", ")})${mig.pushed ? "" : ` — note: ${mig.note}`}`
      : `created ${repo} (private)`;
    push({ kind: "note", text: `· ${summary} — now your team` });
    return summary;
  }

  // Rename the CURRENT team: rename its GitHub repo (owner unchanged), update the
  // saved team + the local checkout, and adopt the new id — without resetting the
  // conversation. Driven by the agent's rename_team tool via the control bridge.
  async function renameCurrentTeam(name: string): Promise<string> {
    const current = currentProjectRef.current;
    if (!current) {
      const m =
        "There's no team to rename — you're working locally. Create one first with /team-new.";
      push({ kind: "note", text: `· ${m}` });
      return m;
    }
    const token = resolveGithubToken();
    if (!token) {
      const m = "Not signed in to GitHub — run /github first.";
      push({ kind: "note", text: `· ${m}` });
      return m;
    }
    push({ kind: "note", text: `· renaming ${current} → ${name}…` });
    const r = await renameRepo(token, current, name);
    if ("error" in r) {
      const taken = /\b422\b|already exists/i.test(r.error);
      const m = taken
        ? `couldn't rename: you already have a repo called "${name}". Pick a different name.`
        : `couldn't rename repo: ${r.error}`;
      push({ kind: "error", text: m });
      return m;
    }
    const newRepo = r.repo;
    stopPreview(); // the old checkout dir is about to move
    renameTeam(current, newRepo);
    await renameWorkspace(current, newRepo);
    // Carry the in-window workspace state (scrollback, session, cost) to the new key.
    const ws = workspaces.current.get(current);
    if (ws) {
      workspaces.current.delete(current);
      workspaces.current.set(newRepo, ws);
    }
    setCurrentTeam(newRepo);
    currentProjectRef.current = newRepo;
    setTeam(newRepo);
    setTeams(listTeams());
    push({ kind: "note", text: `· renamed to ${newRepo}` });
    return `Renamed the team to ${newRepo}. The conversation and your work carried over.`;
  }

  async function runCompact({ silent = false }: { silent?: boolean } = {}) {
    turnStartRef.current = Date.now();
    turnTokensRef.current = 0;
    setBusy(true);
    setStatusLabel("compacting");
    const ac = new AbortController();
    abortRef.current = ac;
    let summary = "";
    try {
      for await (const m of runTurn({
        prompt: COMPACT_PROMPT,
        model,
        systemPrompt: effectiveSystem(),
        resume: sessionId.current,
        mcpServers: await applyMcpOAuth(activeServers),
        toolPatterns: activePatterns,
        abortController: ac,
        workspace: { repo: currentProjectRef.current || null },
      })) {
        const msg = asStream(m);
        if (msg.type === "assistant")
          for (const b of msg.message?.content ?? [])
            if (b.type === "text") {
              const txt = b.text ?? "";
              summary += txt;
              turnTokensRef.current += Math.ceil(txt.length / 4);
            }
      }
    } catch (e) {
      // A silent (auto) compaction stays quiet on failure too — context just
      // isn't reset this turn, and it'll retry next turn.
      if (!silent) push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
    if (summary.trim()) {
      compactedRef.current = summary.trim();
      sessionId.current = undefined; // drop the long session; continue from summary
      justCompactedRef.current = true; // don't auto-compact again next turn
      setCtx(0);
      // Only an explicit /compact shows the result. Auto-compaction is silent:
      // the screen is left as-is, just the model's context is reset behind it.
      if (!silent) {
        setEpoch((e) => e + 1);
        // Keep the banner out — it's a mid-session continuation, not a fresh
        // start, so re-showing the logo is just noise.
        setItems([
          { kind: "note", text: "✦ Context compacted — continuing from this summary:" },
          { kind: "text", text: summary.trim() },
        ]);
      }
    }
  }

  // Map one or more connected sources: run the scanner subagent (cheap tier)
  // per server, concurrently. The user typing /scan is the gate, so the
  // scanner's tools are auto-approved inside each run.
  async function runScans(targets: string[]) {
    turnStartRef.current = Date.now();
    turnTokensRef.current = 0;
    setBusy(true);
    setStatusLabel("scanning");
    push({
      kind: "note",
      text: `· scanning ${targets.length > 1 ? `${targets.length} sources` : targets[0]}: ${targets.join(", ")}`,
    });
    try {
      await Promise.all(
        targets.map(async (mcp) => {
          push({ kind: "tool", name: mcp, input: "→ scanner · running", sub: true });
          try {
            const summary = await runScan({
              mcp,
              mcpServers: await applyMcpOAuth(activeServers),
              onTool: (t) =>
                push({ kind: "tool", name: `${mcp} · ${prettyTool(t)}`, input: "", sub: true }),
            });
            push({
              kind: "result",
              text: `${mcp} mapped${summary ? ` — ${clip(summary, 100)}` : ""}`,
              sub: true,
            });
          } catch (e) {
            push({
              kind: "result",
              text: `${mcp} scan failed: ${e instanceof Error ? e.message : String(e)}`,
              sub: true,
            });
          }
        }),
      );
      push({
        kind: "note",
        text: "· source maps saved to ~/.hemiunu/sources/ — use /scan again to refresh",
      });
    } finally {
      setBusy(false);
    }
  }

  async function showModels() {
    // Default to Anthropic direct; a gateway is used only if one is configured.
    const gateway = process.env.ANTHROPIC_BASE_URL?.trim();
    const base = (gateway || "https://api.anthropic.com").replace(/\/+$/, "");
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    // Anthropic direct authenticates with x-api-key; a gateway/proxy typically
    // takes a Bearer token.
    const headers: Record<string, string> = gateway
      ? { Authorization: `Bearer ${key}` }
      : { "x-api-key": key, "anthropic-version": "2023-06-01" };
    let ids: string[] = [];
    try {
      const res = await fetch(`${base}/v1/models`, { headers });
      const json = (await res.json()) as { data?: { id?: string }[] };
      ids = (json.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    } catch (e) {
      push({
        kind: "error",
        text: `couldn't fetch models: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    // The main loop must be a Claude model, so offer the Claude ids your key exposes.
    const claude = ids.filter((i) => i.toLowerCase().includes("claude")).sort();
    const options = claude.length ? claude : ids.sort();
    if (!options.length) return push({ kind: "note", text: "· no models returned" });
    setSel(Math.max(0, options.indexOf(model)));
    setPicker({
      title: "Select model  (↑/↓ · Enter · Esc to cancel)",
      options,
      onChoice: (v) => {
        setPicker(null);
        if (v && v !== model) {
          setModel(v);
          upsertUserEnv("HEMIUNU_MODEL", v); // remember it for next launch
          sessionId.current = undefined; // fresh session for the new model
          setCtx(0);
          push({ kind: "note", text: `· model set to ${v} (saved)` });
        }
      },
    });
  }

  // Connect a GitHub account via OAuth device flow — entirely in the CLI, no
  // `gh` and no hand-made token. Shows a code + URL, opens the browser, polls
  // until the user authorizes, then saves the token (remembered).
  async function startGithubLogin() {
    githubLoginCancel.current = false;
    let dc: Awaited<ReturnType<typeof requestDeviceCode>>;
    try {
      dc = await requestDeviceCode();
    } catch (e) {
      return push({
        kind: "error",
        text: `GitHub sign-in: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    setDevice({ userCode: dc.userCode, url: dc.verificationUri });
    openUrl(dc.verificationUri);

    let interval = dc.interval;
    const deadline = Date.now() + dc.expiresIn * 1000;
    while (!githubLoginCancel.current && Date.now() < deadline) {
      await sleep(interval * 1000);
      if (githubLoginCancel.current) break;
      const poll = await pollDeviceToken(dc.deviceCode);
      if (poll.status === "authorized") {
        const login = await githubViewer(poll.token);
        if (!login) {
          setDevice(null);
          return push({
            kind: "error",
            text: "GitHub sign-in: the token was rejected — try again",
          });
        }
        connectGithubAccount(login, poll.token);
        setDevice(null);
        refreshGithubLogin();
        return push({ kind: "note", text: `· connected to GitHub as ${login}` });
      }
      if (poll.status === "slow_down") {
        interval = poll.interval;
      } else if (poll.status === "error") {
        setDevice(null);
        return push({ kind: "error", text: `GitHub sign-in: ${poll.message}` });
      }
      // "pending" → keep polling
    }
    setDevice(null);
    push({
      kind: "note",
      text: githubLoginCancel.current
        ? "· GitHub sign-in cancelled"
        : "· GitHub sign-in timed out — /github to retry",
    });
  }

  // Authorize a remote MCP server via OAuth from the CLI: spin a throwaway
  // loopback server to catch the browser redirect (same pattern as preview.ts),
  // open the consent page, then exchange the code and store the token.
  async function runMcpAuth(server: string) {
    const cfg = (registry.mcpServers as Record<string, { url?: string }>)[server];
    const url = typeof cfg?.url === "string" ? cfg.url : undefined;
    if (!url) {
      return push({
        kind: "note",
        text: `· '${server}' isn't a remote (http/sse) server — nothing to authorize`,
      });
    }
    let settled = false;
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">You can close this tab and return to Hemiunu.</body>',
      );
      if (settled) return;
      settled = true;
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      void (async () => {
        try {
          if (!code || !state) throw new Error("missing code/state in redirect");
          await completeMcpAuth(state, code);
          push({ kind: "note", text: `· connected to ${server} (authorized)` });
        } catch (e) {
          push({
            kind: "error",
            text: `MCP authorize: ${e instanceof Error ? e.message : String(e)}`,
          });
        } finally {
          srv.close();
        }
      })();
    });
    srv.listen(0, "127.0.0.1", () => {
      void (async () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        try {
          const { authUrl } = await startMcpAuth(server, url, `http://127.0.0.1:${port}/callback`);
          openUrl(authUrl);
          push({ kind: "note", text: `· authorize ${server} in your browser…` });
        } catch (e) {
          srv.close();
          push({
            kind: "error",
            text: `MCP authorize: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      })();
    });
    // Stop waiting after 5 minutes if the user never finishes.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        srv.close();
      }
    }, 5 * 60_000).unref();
  }

  // Connect Cloudflare (BYO account) by pasting a "Pages: Edit" API token. We
  // resolve the account ID from the token via the Cloudflare API, then persist
  // both to ~/.hemiunu/.env so every prototype deploys into that account's one
  // dashboard — whoever runs the deploy. One-time, machine-wide.
  async function connectCloudflare(apiToken: string, accountId?: string) {
    let acct = accountId?.trim();
    if (!acct) {
      push({ kind: "note", text: "· verifying Cloudflare token…" });
      const res = await fetchCloudflareAccountId(apiToken);
      if ("error" in res) {
        return push({
          kind: "note",
          text: `· Cloudflare: ${res.error}. You can also pass the account ID explicitly: /cloudflare <token> <account-id> (find it in the dashboard URL, dash.cloudflare.com/<account-id>).`,
        });
      }
      acct = res.accountId;
    }
    upsertUserEnv("CLOUDFLARE_API_TOKEN", apiToken);
    const path = upsertUserEnv("CLOUDFLARE_ACCOUNT_ID", acct);
    push({ kind: "note", text: `· connected to Cloudflare (saved to ${path})` });
  }

  // `# <note>` — quick-save a line to the CURRENT team's PROTOTYPE.md (or the
  // local one when no team), without going through the agent. Mirrors Claude
  // Code's `#` memory shortcut. Uses the same backend as add_prototype_note, so
  // it lands under the right heading with frontmatter — never a raw edit.
  function handleHashNote(text: string) {
    const note = text.replace(/^#+\s*/, "").trim();
    if (!note) {
      return push({
        kind: "note",
        text: "· type # then your note — e.g. “# prospects are 40+” — it's saved to this team's PROTOTYPE.md",
      });
    }
    push({ kind: "user", text });
    const team = currentProjectRef.current || undefined;
    void (async () => {
      try {
        // addPrototypeNote already returns user-facing text for the team case
        // (incl. the commit URL) and for errors; only the local case needs a
        // friendlier line than its agent-facing nudge.
        const result = await addPrototypeNote("note", note, { repo: team });
        push({
          kind: "note",
          text: team
            ? `✎ ${result}`
            : "✎ saved to local PROTOTYPE.md — /team-new to create a team and push it",
        });
      } catch (e) {
        push({
          kind: "error",
          text: `Couldn't save to PROTOTYPE.md: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
  }

  function handleCommand(text: string) {
    const [cmd, ...rest] = text.slice(1).split(" ");
    if (cmd === "exit" || cmd === "quit") return exit();
    if (cmd === "help") return push({ kind: "note", text: HELP });
    if (cmd === "models") return void showModels();
    if (cmd === "new") {
      sessionId.current = undefined;
      return push({ kind: "note", text: "· started a new conversation" });
    }
    if (cmd === "clear") {
      sessionId.current = undefined;
      compactedRef.current = "";
      setCtx(0);
      onClear();
      setEpoch((e) => e + 1);
      setItems([{ kind: "banner" }, { kind: "note", text: "· context cleared" }]);
      return;
    }
    if (cmd === "compact") return void runCompact();
    if (cmd === "plan") {
      const next = !planMode;
      setPlanMode(next);
      return push({
        kind: "note",
        text: next
          ? "plan-first mode ON — each turn proposes a plan and waits for your approval before doing anything. /plan again to turn off."
          : "plan-first mode OFF — turns execute normally.",
      });
    }
    if (cmd === "auto") {
      const next = !autoAcceptRef.current;
      setAuto(next);
      return push({
        kind: "note",
        text: next
          ? `auto-accept ON for ${currentTeam() ?? "local"} — tools run without asking. It's per-team and resets when you switch. /auto to turn off.`
          : "auto-accept OFF — each tool asks again.",
      });
    }
    if (cmd === "trust") {
      if (!fsName) return push({ kind: "note", text: "· no filesystem server configured" });
      return promptTrust();
    }
    if (cmd === "mcp") {
      const userMcp = join(configDir(), "mcp.json");
      // Hide the built-in filesystem server — it's a launch-folder capability,
      // not a user-added integration, and listing it only confuses users.
      const names = Object.keys(registry.mcpServers).filter(
        (n) => !isBuiltinServer(n, registry.mcpServers[n]),
      );
      push({
        kind: "note",
        text: `mcp connected: ${names.join(", ") || "none"}\nadd your own servers in ${userMcp} (merged over the defaults)`,
      });
      // Probe remote (http/sse) servers and flag any that need authorizing or
      // are offline — so a server with no tools explains itself.
      void (async () => {
        for (const name of names) {
          const cfg = (registry.mcpServers as Record<string, { url?: string }>)[name];
          if (typeof cfg?.url !== "string") continue;
          const p = await probeMcpServer(cfg.url);
          if (p === "needs-auth" && !mcpOAuthStatus(name).authorized) {
            push({ kind: "note", text: `· ${name} needs authorizing — run /mcp-auth ${name}` });
          } else if (p === "unreachable") {
            push({ kind: "note", text: `· ${name} not reachable (is it running?)` });
          }
        }
      })();
      return;
    }
    if (cmd === "mcp-auth") {
      const server = rest.join(" ").trim();
      if (!server)
        return push({
          kind: "note",
          text: "· usage: /mcp-auth <server-name> (sign in to a remote MCP server)",
        });
      void runMcpAuth(server);
      return;
    }
    if (cmd === "setup") {
      const set = (v?: string) => (v && v.trim() ? "✓" : "✗");
      return push({
        kind: "note",
        text:
          `config: ${join(configDir(), ".env")}\n` +
          `  ANTHROPIC_API_KEY ${set(hasApiKey() ? "y" : "")}\n` +
          `edit that file to change keys, then restart hemiunu.`,
      });
    }
    if (cmd === "settings") {
      const yn = (v: boolean) => (v ? "✓" : "✗");
      const teamNow = currentTeam() ?? "none (local)";
      const ghOn = !!resolveGithubToken();
      const cfOn = cloudflareConfigured();
      const trust = fsTrust === true ? "allowed" : fsTrust === false ? "disabled" : "not set";
      const servers =
        Object.keys(registry.mcpServers)
          .filter((n) => !isBuiltinServer(n, registry.mcpServers[n]))
          .join(", ") || "none";
      return push({
        kind: "note",
        text:
          `Settings  (saved across sessions in ${configDir()})\n` +
          `  model            ${model}            → /models (saved)\n` +
          `  research model   ${RESEARCH_MODEL}   → HEMIUNU_MODEL_RESEARCH in .env\n` +
          `  team             ${teamNow}          → /team · shift+tab (saved)\n` +
          `  GitHub           ${ghOn ? "connected" : "not connected"}   → /github\n` +
          `  Cloudflare       ${cfOn ? "connected" : "not connected"}   → /cloudflare\n` +
          `  file access      ${trust} (this folder)   → /trust\n` +
          `  MCP servers      ${servers}   → /mcp\n` +
          `  keys             ANTHROPIC ${yn(hasApiKey())}   → /setup\n` +
          `  thinking budget  ${process.env.HEMIUNU_THINKING_BUDGET ?? "0"}   context window ${process.env.HEMIUNU_CONTEXT_WINDOW ?? "auto"}   → .env`,
      });
    }
    if (cmd === "list") {
      const rows = store.listConversations();
      if (!rows.length) return push({ kind: "note", text: "· no conversations yet" });
      return push({
        kind: "note",
        text: rows.map((r) => `${r.id.slice(0, 8)}  ${r.title}`).join("\n"),
      });
    }
    if (cmd === "resume") {
      const id = rest.join(" ").trim();
      const msgs = store.getMessages(id);
      if (!msgs.length) return push({ kind: "note", text: `· no conversation "${id}"` });
      sessionId.current = id;
      return push({ kind: "note", text: `· resumed ${id.slice(0, 8)} (${msgs.length} messages)` });
    }
    if (cmd === "skills") {
      const skills = loadSkills();
      if (!skills.length)
        return push({
          kind: "note",
          text: `· no skills yet — ask me to create one, or add a .md in ${join(configDir(), "skills")}`,
        });
      return push({
        kind: "note",
        text: skills.map((s) => `/${s.name}  —  ${s.description || "(no description)"}`).join("\n"),
      });
    }
    if (cmd === "github") {
      const arg = rest.join(" ").trim();
      // Explicit sub-commands / token paste.
      if (arg === "logout" || arg === "disconnect") {
        disconnectGithub();
        refreshGithubLogin();
        return push({ kind: "note", text: "· disconnected from GitHub" });
      }
      if (arg && arg !== "connect" && arg !== "switch") {
        // Treat any other arg as a pasted token (power-user / no-OAuth fallback).
        void (async () => {
          const login = await githubViewer(arg);
          if (!login)
            return push({
              kind: "error",
              text: "that token didn't work — make sure it has repo contents read/write, then /github <token>",
            });
          connectGithubAccount(login, arg);
          refreshGithubLogin();
          push({ kind: "note", text: `· connected to GitHub as ${login}` });
        })();
        return;
      }

      const CONNECT = "＋ Connect another account";
      const CONNECT_FIRST = "＋ Connect a GitHub account";
      const DISCONNECT = "✕ Disconnect";

      // Resolve (and adopt) the current identity first, so a user signed in via
      // env/`gh` shows as a real, switchable account rather than "not connected".
      void (async () => {
        const status = await syncGithubStatus();
        refreshGithubLogin();

        // Nothing connectable yet → connect straight away (device flow).
        if (!status.accounts.length && !status.connected) {
          if (githubClientId()) void startGithubLogin();
          else
            push({
              kind: "note",
              text:
                "· not connected to GitHub.\n" +
                "  device sign-in isn't configured (no OAuth client id) — paste a token instead:\n" +
                "  create a fine-grained token (repo contents: read & write) and run /github <token>.",
            });
          return;
        }

        // Otherwise show the account manager: switch / connect / disconnect.
        const accountRows = status.accounts.map(
          (login) => `${status.connected && login === status.login ? "● " : "○ "}${login}`,
        );
        const options = [
          ...accountRows,
          status.accounts.length ? CONNECT : CONNECT_FIRST,
          ...(status.connected ? [DISCONNECT] : []),
        ];
        const active = accountRows.findIndex((r) => r.startsWith("● "));
        setSel(active >= 0 ? active : 0);
        setPicker({
          title: status.connected
            ? `GitHub · connected as ${status.login}  (↑/↓ · Enter · Esc)`
            : "GitHub · not connected  (↑/↓ · Enter · Esc)",
          options,
          onChoice: (v) => {
            setPicker(null);
            if (v === null) return;
            if (v === CONNECT || v === CONNECT_FIRST) {
              if (githubClientId()) void startGithubLogin();
              else
                push({
                  kind: "note",
                  text: "· device sign-in isn't configured — paste a token with /github <token>.",
                });
              return;
            }
            if (v === DISCONNECT) {
              disconnectGithub();
              refreshGithubLogin();
              push({ kind: "note", text: "· disconnected from GitHub" });
              return;
            }
            const login = v.replace(/^[●○]\s*/, "");
            if (login === status.login && status.connected) return; // already active
            if (switchGithubAccount(login)) {
              refreshGithubLogin();
              push({ kind: "note", text: `· switched GitHub account to ${login}` });
            }
          },
        });
      })();
      return;
    }
    if (cmd === "cloudflare") {
      const parts = rest.join(" ").trim().split(/\s+/).filter(Boolean);
      if (parts.length) {
        void connectCloudflare(parts[0], parts[1]); // token, optional explicit account ID
        return;
      }
      if (cloudflareConfigured()) {
        return push({ kind: "note", text: "· Cloudflare: connected" });
      }
      return push({
        kind: "note",
        text:
          "Connect Cloudflare to share prototypes (free):\n" +
          "  1. https://dash.cloudflare.com/profile/api-tokens → Create Token\n" +
          "     → Create Custom Token, add permission: Account · Cloudflare Pages · Edit\n" +
          "     (or use the “Edit Cloudflare Workers” template — it covers Pages too)\n" +
          "  2. Run  /cloudflare <api-token>   (add the account ID if the lookup fails)\n" +
          "Everyone on your team can paste the same token to share one dashboard.",
      });
    }
    if (cmd === "restore") {
      const id = rest.join(" ").trim();
      const entries = listTrash();
      if (!id) {
        if (!entries.length) return push({ kind: "note", text: "· recycle bin is empty" });
        return push({
          kind: "note",
          text:
            "recycle bin (newest first):\n" +
            entries.map((e) => `  ${e.id}\n    ${e.repo} · ${e.reason}`).join("\n") +
            "\n/restore <id> to recover its files",
        });
      }
      try {
        const dest = restoreTrash(id);
        return push({ kind: "note", text: `· restored to ${dest}` });
      } catch (e) {
        return push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    }
    if (cmd === "team-new") {
      const arg = rest.join(" ").trim();
      if (!arg)
        return push({
          kind: "note",
          text: "· usage: /team-new <name> (create a private repo) or /team-new <github-url> (add an existing repo)",
        });
      const token = resolveGithubToken();
      if (!token) return push({ kind: "note", text: "· sign in first with /github" });
      // A URL or owner/repo → adopt an existing repo; a bare name → create one.
      if (arg.includes("/") || arg.includes("github.com")) {
        const repo = normalizeRepo(arg);
        push({ kind: "note", text: `· checking ${repo}…` });
        void (async () => {
          if (await repoExists(token, repo)) {
            addTeam(repo);
            setTeams(listTeams());
            await bringLocalWorkInto(repo); // carry any local work into the repo first
            adoptTeam(repo); // keep the conversation; no banner reset
            push({ kind: "note", text: `· added team ${repo} — now your team` });
          } else {
            push({
              kind: "error",
              text: `couldn't find ${repo} on GitHub (or you don't have access)`,
            });
          }
        })();
        return;
      }
      void createAndAdoptTeam(arg); // create + migrate local work + adopt (no reset)
      return;
    }
    if (cmd === "team-rename") {
      const arg = rest.join(" ").trim();
      if (!arg)
        return push({
          kind: "note",
          text: "· usage: /team-rename <new-name> (renames the current team's repo)",
        });
      void renameCurrentTeam(arg); // rename repo + state + local checkout (no reset)
      return;
    }
    if (cmd === "team-add") {
      const u = rest.join(" ").trim();
      if (!u) return push({ kind: "note", text: "· usage: /team-add <github-username>" });
      void (async () => push({ kind: "note", text: `· ${await addTeammate(u)}` }))();
      return;
    }
    if (cmd === "team-remove") {
      const u = rest.join(" ").trim();
      if (!u) return push({ kind: "note", text: "· usage: /team-remove <github-username>" });
      void (async () => push({ kind: "note", text: `· ${await removeTeammate(u)}` }))();
      return;
    }
    if (cmd === "team") {
      const arg = rest.join(" ").trim();
      // No arg → open the team switcher (arrow-select). Shift+Tab cycles too.
      // "No team" is always an option → work locally.
      if (!arg) {
        const NONE = "○ No team (work locally)";
        const options = [NONE, ...listTeams()];
        const cur = currentTeam();
        setSel(cur ? Math.max(0, options.indexOf(cur)) : 0);
        setPicker({
          title: "Switch team  (↑/↓ · Enter · Esc)",
          options,
          onChoice: (v) => {
            setPicker(null);
            if (v === null) return;
            const target = v === NONE ? null : v;
            if (target === null) {
              switchProject(null);
              return;
            }
            // Verify the repo still exists, then carry local work in and switch.
            void enterTeam(target);
          },
        });
        return;
      }
      const repo = addTeam(arg);
      setTeams(listTeams());
      void enterTeam(repo, { note: true });
      return;
    }
    if (cmd === "scan") {
      const connected = Object.keys(activeServers);
      if (!connected.length) {
        return push({ kind: "note", text: "· no connected sources to scan (see /mcp)" });
      }
      const named = rest[0]?.trim();
      if (named && !connected.includes(named)) {
        return push({
          kind: "note",
          text: `· '${named}' isn't a connected source. Connected: ${connected.join(", ")}`,
        });
      }
      return void runScans(named ? [named] : connected);
    }
    // Not a built-in: is it a saved skill? Read fresh so file edits apply now.
    const skill = loadSkill(cmd);
    if (skill) {
      push({ kind: "note", text: `· running skill /${skill.name}` });
      return void runUserTurn(expandSkill(skill, rest.join(" ")));
    }
    push({ kind: "note", text: `· unknown command: /${cmd} (/skills to list saved skills)` });
  }

  // --- slash-command menu: a live list of commands + skills while typing "/" ---
  const inputActive = !busy && !permission && !picker && !device;
  // The line is a `#` PROTOTYPE.md note (drives the lapis prompt + the hint).
  const isNote = value.startsWith("#");
  const slashToken =
    inputActive && value.startsWith("/") && !value.includes(" ")
      ? value.slice(1).toLowerCase()
      : null;
  const slashItems =
    slashToken !== null
      ? [
          ...BUILTIN_COMMANDS.map((c) => ({ name: c.name, desc: c.desc, skill: false })),
          ...skills.map((s) => ({ name: s.name, desc: s.description || "skill", skill: true })),
        ].filter((c) => c.name.toLowerCase().startsWith(slashToken))
      : [];
  const showMenu = slashItems.length > 0;
  const menuSel = Math.min(cmdSel, Math.max(0, slashItems.length - 1));
  // Scroll the visible window so the highlighted row stays in view.
  const menuStart =
    slashItems.length <= SLASH_MENU_ROWS
      ? 0
      : Math.max(
          0,
          Math.min(menuSel - Math.floor(SLASH_MENU_ROWS / 2), slashItems.length - SLASH_MENU_ROWS),
        );

  // Keep the highlight on the top match as the filter narrows; refresh the
  // skills list whenever the user enters slash mode (picks up newly-saved ones).
  useEffect(() => setCmdSel(0), [slashToken]);
  const inSlash = value.startsWith("/");
  useEffect(() => {
    if (inSlash) setSkills(loadSkills());
  }, [inSlash]);

  // Teammate autocomplete: while typing `/team-add <partial>` or
  // `/team-remove <partial>`, suggest members of the current team's org so the
  // user doesn't have to remember exact usernames. Only shows for org-owned repos.
  const teammateMatch = inputActive ? /^\/(team-add|team-remove)\s+(.*)$/.exec(value) : null;
  const teammatePartial = teammateMatch ? teammateMatch[2] : null;
  const inTeammateMode = teammatePartial !== null;
  const teamOwner = currentProjectRef.current ? currentProjectRef.current.split("/")[0] : null;
  // Fetch org members once per org when the user enters teammate mode (cached).
  useEffect(() => {
    if (!inTeammateMode || !teamOwner) return;
    const cached = memberCache.current.get(teamOwner);
    if (cached) {
      setOrgMembers(cached);
      return;
    }
    const token = resolveGithubToken();
    if (!token) return;
    let cancelled = false;
    void (async () => {
      const members = await listOrgMembers(token, teamOwner); // [] if not an org / no access
      if (cancelled) return;
      memberCache.current.set(teamOwner, members);
      setOrgMembers(members);
    })();
    return () => {
      cancelled = true;
    };
  }, [inTeammateMode, teamOwner]);
  const memberItems =
    teammatePartial !== null
      ? orgMembers
          .filter(
            (l) =>
              l.toLowerCase().startsWith(teammatePartial.toLowerCase()) &&
              l.toLowerCase() !== teammatePartial.toLowerCase(),
          )
          .slice(0, SLASH_MENU_ROWS)
      : [];
  const showMembers = inputActive && !showMenu && memberItems.length > 0;
  const memberSelClamped = Math.min(memberSel, Math.max(0, memberItems.length - 1));
  useEffect(() => setMemberSel(0), [teammatePartial]);

  const onSubmit = (v: string) => {
    const text = v.trim();
    if (!text) {
      setValue("");
      return;
    }
    // With the menu open, Enter ACCEPTS the highlighted command into the input
    // (like Tab) rather than running it — so the user can add arguments first
    // (e.g. /team-new <name>). Run it with a second Enter once it's typed out.
    if (showMenu) {
      setValue(`/${slashItems[menuSel].name} `);
      setCmdSel(0);
      return;
    }
    // A teammate suggestion is highlighted → complete the username into the input
    // (run it with a second Enter), mirroring the slash-menu behaviour.
    if (showMembers && teammateMatch) {
      setValue(`/${teammateMatch[1]} ${memberItems[memberSelClamped]}`);
      return;
    }
    setValue("");
    setCmdSel(0);
    if (text.startsWith("#")) handleHashNote(text);
    else if (text.startsWith("/")) handleCommand(text);
    else void runUserTurn(text);
  };

  useInput(
    (_input, key) => {
      if (permission) {
        const choices = permission.choices ?? MENU_CHOICES;
        const n = choices.length;
        if (key.upArrow) setSel((s) => (s - 1 + n) % n);
        else if (key.downArrow) setSel((s) => (s + 1) % n);
        else if (key.return) permission.onChoice(choices[sel].value);
        // Esc = the last (decline) option: "No" normally, "keep planning" for a plan.
        else if (key.escape) permission.onChoice(choices[n - 1].value);
        return;
      }
      if (picker) {
        const n = picker.options.length;
        if (key.upArrow) setSel((s) => (s - 1 + n) % n);
        else if (key.downArrow) setSel((s) => (s + 1) % n);
        else if (key.return) picker.onChoice(picker.options[sel]);
        else if (key.escape) picker.onChoice(null);
        return;
      }
      if (device && key.escape) {
        githubLoginCancel.current = true;
        return;
      }
      if (busy && key.escape) abortRef.current?.abort();
    },
    { isActive: busy || !!permission || !!picker || !!device },
  );

  // While the slash menu is open: ↑/↓ move the highlight, Tab completes it.
  // (TextInput ignores arrows/Tab, so normal typing is unaffected.)
  useInput(
    (_input, key) => {
      const n = slashItems.length;
      if (!n) return;
      if (key.upArrow) setCmdSel((s) => (Math.min(s, n - 1) - 1 + n) % n);
      else if (key.downArrow) setCmdSel((s) => (Math.min(s, n - 1) + 1) % n);
      else if (key.tab && !key.shift) {
        setValue(`/${slashItems[menuSel].name} `);
        setCmdSel(0);
      }
    },
    { isActive: showMenu },
  );

  // While teammate suggestions are open: ↑/↓ move the highlight, Tab completes
  // the username into the input.
  useInput(
    (_input, key) => {
      const n = memberItems.length;
      if (!n || !teammateMatch) return;
      if (key.upArrow) setMemberSel((s) => (Math.min(s, n - 1) - 1 + n) % n);
      else if (key.downArrow) setMemberSel((s) => (Math.min(s, n - 1) + 1) % n);
      else if (key.tab && !key.shift)
        setValue(`/${teammateMatch[1]} ${memberItems[memberSelClamped]}`);
    },
    { isActive: showMembers },
  );

  // Shift+Tab cycles between teams (a team ≈ one prototype repo). TextInput
  // ignores shift+tab, so this works even while typing or with the menu open.
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) {
        const next = cycleTeam(); // "" = no team, repo = a team, null = none to cycle
        // Switch silently — the footer already shows the current selection. Only
        // speak up when there's nothing to cycle to.
        if (next === null)
          push({ kind: "note", text: "· no teams yet — /team-new <name> to create one" });
        else {
          const target = next === "" ? null : next;
          if (target === null) switchProject(null);
          // Verify the repo still exists, then carry local work in and switch.
          else void enterTeam(target);
        }
      }
    },
    { isActive: inputActive },
  );

  const ctxStr = ctx
    ? `ctx ${kfmt(ctx)}/${kfmt(ctxWindow)} (${Math.round((ctx / ctxWindow) * 100)}%)`
    : `ctx ${kfmt(ctxWindow)}`;

  // Current team shown under the chat (a team ≈ one prototype repo).
  const teamShort = team ? (team.split("/")[1] ?? team) : null;
  const teamIdx = team ? teams.indexOf(team) : -1;
  const teamLabel = teamShort
    ? `⌂ ${teamShort}${teams.length > 1 && teamIdx >= 0 ? ` ${teamIdx + 1}/${teams.length}` : ""}`
    : "⌂ no team";

  const elapsed = busy ? Date.now() - turnStartRef.current : 0;
  // Spinner: a single hieroglyph, changing each beat.
  const glyph = HIERO[Math.floor(elapsed / 220) % HIERO.length];
  const word =
    statusLabel === "compacting"
      ? "Compacting"
      : statusLabel === "researching"
        ? "Researching"
        : statusLabel === "prototyping"
          ? "Prototyping"
          : statusLabel === "parallel"
            ? "Orchestrating"
            : statusLabel === "scanning"
              ? "Scanning"
              : WORDS[Math.floor(elapsed / 4000) % WORDS.length];

  return (
    <Box flexDirection="column">
      <Static key={epoch} items={items}>
        {(item, i) => <ItemView key={i} item={item} />}
      </Static>

      {live ? (
        <Box marginTop={1}>
          <Text>
            <Text color={SAGE} bold>
              {"⏺ "}
            </Text>
            {live}
          </Text>
        </Box>
      ) : null}

      {/* The open activity group, updating live until it closes into scrollback. */}
      {group && !live ? (
        <Box marginTop={1}>
          <Text>
            <Text color={group.kind === "delegation" ? SAND : SAGE} bold>
              {group.kind === "delegation" ? "⌂ " : "⏺ "}
            </Text>
            <Text dimColor>{summarizeGroup(group)}</Text>
          </Text>
        </Box>
      ) : null}

      {busy && !permission && !picker ? (
        <Box marginTop={1}>
          <Text color={SAND} bold>
            {`${glyph}  ${word}… `}
          </Text>
          <Text dimColor>
            {`(${fmtElapsed(elapsed)} · ↑ ${tokfmt(turnTokensRef.current)} tokens · esc to interrupt)`}
          </Text>
        </Box>
      ) : null}

      {permission ? (
        <Box flexDirection="column" marginTop={1}>
          {permission.choices ? (
            <Text>
              <Text color={SAGE}>{"⚙ "}</Text>
              <Text color={SAND} bold>
                Ready to proceed with this plan?
              </Text>
            </Text>
          ) : (
            <Text>
              <Text color={SAGE}>{"⚙ "}</Text>
              {"Allow "}
              <Text color={SAND} bold>
                {prettyTool(permission.name)}
              </Text>
              {"?"}
            </Text>
          )}
          {(permission.choices ?? MENU_CHOICES).map((c, i) => (
            <Text key={c.value} color={i === sel ? SAGE : undefined} dimColor={i !== sel}>
              {i === sel ? "❯ " : "  "}
              {c.label}
            </Text>
          ))}
        </Box>
      ) : null}

      {picker ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={SAGE} bold wrap="wrap">
            {picker.title}
          </Text>
          {/* Each option: a fixed marker column + a flexible, wrapping label, so a
              long choice wraps with a hanging indent instead of overflowing. */}
          {picker.options.map((opt, i) => (
            <Box key={opt}>
              <Text color={i === sel ? SAGE : undefined} dimColor={i !== sel}>
                {i === sel ? "❯ " : "  "}
              </Text>
              <Box flexGrow={1}>
                <Text color={i === sel ? SAGE : undefined} dimColor={i !== sel} wrap="wrap">
                  {opt}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}

      {showMenu ? (
        <Box flexDirection="column" marginTop={1}>
          {menuStart > 0 ? <Text dimColor>{`  ↑ ${menuStart} more`}</Text> : null}
          {slashItems.slice(menuStart, menuStart + SLASH_MENU_ROWS).map((it, i) => {
            const idx = menuStart + i;
            return (
              <Text
                key={it.name}
                color={idx === menuSel ? SAGE : undefined}
                dimColor={idx !== menuSel}
              >
                {idx === menuSel ? "❯ " : "  "}
                <Text color={idx === menuSel ? SAGE : SAND} bold>{`/${it.name}`}</Text>
                {it.skill ? <Text dimColor>{"  · skill"}</Text> : null}
                <Text dimColor>{`  —  ${it.desc}`}</Text>
              </Text>
            );
          })}
          {slashItems.length - (menuStart + SLASH_MENU_ROWS) > 0 ? (
            <Text dimColor>{`  ↓ ${slashItems.length - (menuStart + SLASH_MENU_ROWS)} more`}</Text>
          ) : null}
          <Text dimColor>{"  ↑/↓ select · Tab/Enter insert · Enter again to run"}</Text>
        </Box>
      ) : null}

      {showMembers ? (
        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>{`teammates in ${teamOwner}`}</Text>
          {memberItems.map((m, i) => (
            <Text
              key={m}
              color={i === memberSelClamped ? SAGE : SAND}
              dimColor={i !== memberSelClamped}
            >
              {i === memberSelClamped ? "❯ " : "  "}
              {m}
            </Text>
          ))}
          <Text dimColor>{"  ↑/↓ select · Tab/Enter insert · Enter again to run"}</Text>
        </Box>
      ) : null}

      {device ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={SAGE}>{"⌂ "}</Text>
            <Text color={SAND} bold>
              Connect GitHub
            </Text>
          </Text>
          <Text dimColor>
            {"  1. opening "}
            <Text color={SAGE}>{device.url}</Text>
            {" in your browser"}
          </Text>
          <Text>
            {"  2. enter this code:  "}
            <Text color={SAND} bold>
              {device.userCode}
            </Text>
          </Text>
          <Text dimColor>{"  waiting for you to authorize…  (Esc to cancel)"}</Text>
        </Box>
      ) : null}

      {inputActive ? (
        <Box marginTop={1} borderStyle="single" borderColor={isNote ? LAPIS : STONE} paddingX={1}>
          {/* The prompt glyph turns lapis with a # when the line is a PROTOTYPE.md
              note, so it's visibly a command rather than a message to the agent. */}
          <Text color={isNote ? LAPIS : SAND} bold>
            {isNote ? "# " : "☥ "}
          </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={onSubmit}
            placeholder="Ask Hemiunu…  (/help for commands · # to note in PROTOTYPE.md)"
          />
        </Box>
      ) : null}

      {inputActive && isNote ? (
        <Box paddingX={1}>
          <Text color={LAPIS}>{"# "}</Text>
          <Text dimColor>
            {`saves this line to ${teamShort ? `${teamShort}'s` : "the local"} PROTOTYPE.md — Enter to save`}
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={SAND} bold>
            {teamLabel}
          </Text>
          {teams.length >= 1 ? <Text dimColor>{"  · shift+tab to switch"}</Text> : null}
          <Text dimColor>
            {"   "}
            {githubLogin ? `⎇ ${githubLogin}` : "⎇ no GitHub"}
            {"  · /github"}
          </Text>
        </Text>
        <Text
          color={SAGE}
        >{`${model}${planMode ? " · plan-first" : ""}${autoAccept ? " · auto-accept" : ""} · ${ctxStr} · session $${sessionCost.toFixed(2)}`}</Text>
      </Box>
    </Box>
  );
}

// --- first-run setup: collect keys without making the user edit a file ---

interface SetupValues {
  apiKey: string;
  baseUrl: string;
}
const SETUP_FIELDS: {
  key: keyof SetupValues;
  label: string;
  hint: string;
  mask?: boolean;
  required?: boolean;
}[] = [
  {
    key: "apiKey",
    label: "Anthropic API key",
    hint: "the Claude brain — required",
    mask: true,
    required: true,
  },
  {
    key: "baseUrl",
    label: "Gateway base URL",
    hint: "optional — Enter for Anthropic direct, or a proxy URL",
  },
];

function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState("");
  const valuesRef = useRef<SetupValues>({
    apiKey: "",
    baseUrl: "",
  });
  const field = SETUP_FIELDS[step];

  const submit = (raw: string) => {
    const v = raw.trim();
    if (field.required && !v) return; // a required field can't be skipped
    valuesRef.current[field.key] = v;
    setValue("");
    if (step + 1 < SETUP_FIELDS.length) {
      setStep(step + 1);
    } else {
      const vals = valuesRef.current;
      writeUserEnv({
        apiKey: vals.apiKey,
        baseUrl: vals.baseUrl || undefined,
      });
      onDone();
    }
  };

  return (
    <Box flexDirection="column">
      <Banner />
      <Box marginTop={1} marginLeft={3}>
        <Text color={SAND} bold>
          Welcome to Hemiunu — let's get you set up.
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={3}>
        <Text>
          <Text color={SAGE} bold>{`${field.label}: `}</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={submit}
            mask={field.mask ? "•" : undefined}
          />
        </Text>
      </Box>
      <Box marginLeft={3}>
        <Text
          dimColor
        >{`${field.hint}  ·  ${step + 1}/${SETUP_FIELDS.length}  ·  saved to ${join(configDir(), ".env")}`}</Text>
      </Box>
    </Box>
  );
}

function runSetup(): Promise<void> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <Setup
        onDone={() => {
          unmount();
          resolve();
        }}
      />,
    );
  });
}

// Launch-time "which team?" picker. One team per terminal — pick here, and for
// parallel work just open another terminal and pick a different team. Arrow to
// move, Enter to choose. The first option is "work locally (no team)".
function LaunchPicker({
  teams,
  current,
  onChoice,
}: {
  teams: string[];
  current: string | null;
  onChoice: (team: string | null) => void;
}) {
  const options: { label: string; value: string | null }[] = [
    { label: "Work locally (no team)", value: null },
    ...teams.map((t) => ({ label: t, value: t })),
  ];
  const initial = Math.max(
    0,
    options.findIndex((o) => o.value === current),
  );
  const [sel, setSel] = useState(initial);
  useInput((_input, key) => {
    const n = options.length;
    if (key.upArrow) setSel((s) => (s - 1 + n) % n);
    else if (key.downArrow) setSel((s) => (s + 1) % n);
    else if (key.return) onChoice(options[sel].value);
  });
  return (
    <Box flexDirection="column">
      <Banner />
      <Box marginTop={1} marginLeft={3} flexDirection="column">
        <Text color={SAND} bold>
          Which team do you want to work on?
        </Text>
        <Text dimColor>{"Open another terminal to work on a second team in parallel."}</Text>
      </Box>
      <Box marginTop={1} marginLeft={3} flexDirection="column">
        {options.map((o, i) => (
          <Text key={o.value ?? "local"} color={i === sel ? SAGE : undefined} dimColor={i !== sel}>
            {i === sel ? "❯ " : "  "}
            {o.label}
          </Text>
        ))}
      </Box>
      <Box marginLeft={3} marginTop={1}>
        <Text dimColor>{"↑/↓ select · Enter to start"}</Text>
      </Box>
    </Box>
  );
}

function runLaunchPicker(teams: string[], current: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <LaunchPicker
        teams={teams}
        current={current}
        onChoice={(team) => {
          unmount();
          resolve(team);
        }}
      />,
    );
  });
}

/**
 * Resolve the team to start in. A CLI arg pins it non-interactively (handy for
 * opening a second terminal already on another team):
 *   hemiunu                 → pick interactively (if any teams exist)
 *   hemiunu owner/repo       → start on that team (added if new)
 *   hemiunu local | none     → start with no team (local)
 * With no arg and no teams yet, start local (the onboarding flow takes over).
 */
async function resolveStartTeam(): Promise<string | null> {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (arg) {
    const a = arg.trim().toLowerCase();
    if (a === "local" || a === "none") return null;
    if (arg.includes("/")) return addTeam(arg); // normalizes + selects + persists
    // A bare name: match a known team by its repo name, else treat as local.
    const match = listTeams().find((t) => (t.split("/")[1] ?? t).toLowerCase() === a);
    return match ?? null;
  }
  const teams = listTeams();
  if (!teams.length) return null; // fresh user → local; onboarding offers a team
  return runLaunchPicker(teams, currentTeam() ?? null);
}

function printHelp(): void {
  // process.env.HEMIUNU_VERSION is injected at bundle time (see build-release.mjs);
  // undefined when running buildless via tsx in dev.
  const version = process.env.HEMIUNU_VERSION ?? "dev";
  console.log(`hemiunu ${version} — product agent for your terminal

Usage:
  hemiunu                 start, picking a team interactively
  hemiunu owner/repo      start on a specific team (added if new)
  hemiunu local           start with no team (a local workspace)

Options:
  -v, --version           print version and exit
  -h, --help              show this help and exit

First run asks for your Anthropic API key and saves it to ~/.hemiunu/.env.
Models are bring-your-own. Docs: https://github.com/AntoineF23/hemiunu`);
}

async function main() {
  // Non-interactive flags short-circuit before any TTY/render or setup so
  // `hemiunu --version` works in scripts and on a fresh machine.
  const flags = process.argv.slice(2);
  if (flags.includes("--version") || flags.includes("-v")) {
    console.log(process.env.HEMIUNU_VERSION ?? "dev");
    return;
  }
  if (flags.includes("--help") || flags.includes("-h")) {
    printHelp();
    return;
  }
  // Hemiunu's HOME (its config: soul.md, mcp.json, context/) is the install
  // dir when launched via the `hemiunu` command, else the current dir (running
  // from the repo). This is separate from the launch dir, which the agent reads
  // files from via the filesystem MCP (${CWD}) — so `hemiunu` works in any folder.
  const home = process.env.HEMIUNU_HOME ?? process.cwd();
  // The user's config + state (keys, conversations, folder-trust) live in one
  // place — NOT in the cloned code, so updates never clobber them.
  const dataDir = configDir();
  mkdirSync(dataDir, { recursive: true });
  // A per-run id for the local (no-team) workspace folder under ~/.hemiunu/tmp/local.
  setLocalSession(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  // First run: if no key is configured, ask for it (and optional tokens) inline
  // and write ~/.hemiunu/.env — no file editing required.
  if (!hasApiKey()) await runSetup();
  // Pick the team for this terminal (one team per process). Pin it in-memory
  // and persist it as the next-launch default — the running session resolves its
  // repo from this pin (not the shared team.json), so a second terminal on a
  // different team can't change it underneath us.
  const startTeam = await resolveStartTeam();
  setCurrentTeam(startTeam);
  const store = new ConversationStore(join(dataDir, "hemiunu.db"));
  // App default mcp.json + the user's own overlay (~/.hemiunu/mcp.json).
  const registry = loadMcpRegistry(home, join(dataDir, "mcp.json"));
  // Confine every spawned stdio server to a throwaway cwd under
  // ~/.hemiunu/tmp/mcp/<name>, so a server that writes relative files (e.g.
  // Playwright snapshots) can't litter the user's launch folder. The filesystem
  // server is exempt — reading the launch project is its whole job.
  registry.mcpServers = sandboxStdioCwd(registry.mcpServers, {
    shimPath: join(home, "bin", "mcp-in-dir.mjs"),
    rootDir: join(dataDir, "tmp", "mcp"),
  });
  const model = process.env.HEMIUNU_MODEL ?? "claude-opus-4.8";
  // Context: soul.md ships with the app (home); the global user.md lives in the
  // user data dir (~/.hemiunu). First run seeds user.md from the committed
  // template. Feature/project memory is NOT here — it's the team's PROTOTYPE.md
  // (team repo, or a local file only when no team), so nothing is written into
  // an unrelated launch folder.
  const contextRoots = { appRoot: home, userRoot: dataDir };
  seedContextFiles(contextRoots);
  const systemPrompt = buildSystemPrompt(loadContext(contextRoots));

  const handle: { clear: () => void } = { clear: () => {} };
  const app = render(
    <App
      store={store}
      registry={registry}
      systemPrompt={systemPrompt}
      initialModel={model}
      initialTeam={startTeam}
      onClear={() => handle.clear()}
    />,
  );
  handle.clear = () => app.clear();
  await app.waitUntilExit();
  stopPreview(); // tear down any running localhost preview
  store.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
