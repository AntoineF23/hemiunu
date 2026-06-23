import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  runTurn,
  REMEMBER_TOOL_ID,
  PARALLEL_TOOL_ID,
  configDir,
  hasApiKey,
  writeUserEnv,
  upsertUserEnv,
  loadSkills,
  loadSkill,
  expandSkill,
  resolveGithubToken,
  resolveRepo,
  addTeam,
  cycleTeam,
  listTeams,
  currentTeam,
  setCurrentTeam,
  createRepo,
  githubViewer,
  githubClientId,
  requestDeviceCode,
  pollDeviceToken,
  listTrash,
  restoreTrash,
  stopPreview,
  resolveVercelToken,
  vercelLoggedIn,
  vercelLogin,
} from "@hemiunu/agent-core";
import { spawn } from "node:child_process";
import { loadMcpRegistry } from "@hemiunu/mcp";
import {
  buildSystemPrompt,
  ConversationStore,
  loadContext,
  seedContextFiles,
} from "@hemiunu/memory";
import { Box, render, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useRef, useState } from "react";

// --- desert palette ---
const SAND = "#d7af87";
const SAGE = "#87af87";

// Retrieval tier the `researcher` subagent runs on (mirrors agent-core config).
const RESEARCH_MODEL = process.env.HEMIUNU_MODEL_RESEARCH ?? "claude-sonnet-4.6";
const shortModel = (m: string) => m.replace(/^claude-/, "");

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

const HELP =
  "/new  /clear  /compact  /models  /setup  /trust  /list  /resume <id>  /mcp  /skills  /github  /vercel  /team  /team-new  /restore  /exit";

// Built-in commands, with one-line descriptions for the slash menu.
const BUILTIN_COMMANDS: { name: string; desc: string }[] = [
  { name: "new", desc: "start a new conversation" },
  { name: "clear", desc: "clear context and the screen" },
  { name: "compact", desc: "summarise & compact the context" },
  { name: "models", desc: "switch the model" },
  { name: "setup", desc: "show config & keys" },
  { name: "trust", desc: "toggle file access for this folder" },
  { name: "list", desc: "list saved conversations" },
  { name: "resume", desc: "resume a conversation by id" },
  { name: "mcp", desc: "show connected MCP servers" },
  { name: "skills", desc: "list saved skills" },
  { name: "github", desc: "sign in to GitHub (remembered)" },
  { name: "vercel", desc: "connect Vercel (for sharing)" },
  { name: "team", desc: "switch team (feature/repo)" },
  { name: "team-new", desc: "new feature → creates a private repo + switch" },
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
- Relevant files / sources: files, Notion pages, or data referenced.
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
  if (m.includes("llama") || m.includes("mistral") || m.includes("deepseek"))
    return 128_000;
  return 128_000;
}
const COMPACT_AT = Math.min(
  0.95,
  Math.max(0.1, Number(process.env.HEMIUNU_COMPACT_THRESHOLD ?? 0.5)),
);
const kfmt = (n: number) => `${Math.round(n / 1000)}k`;

// Pyramid spinner (shimmering triangle) + ancient-civilisation status words.
const PYRAMID = ["△", "◭", "▲", "◮"];
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

type PermValue = "yes" | "always" | "no";
const MENU_CHOICES: { label: string; value: PermValue }[] = [
  { label: "Yes", value: "yes" },
  { label: "Always allow this tool", value: "always" },
  { label: "No, and tell the agent what to do differently", value: "no" },
];

function prettyTool(name: string): string {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    if (i >= 0) return `${rest.slice(0, i)}·${rest.slice(i + 2)}`;
  }
  return name;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? (b as { text: string }).text
          : "",
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const previewInput = (input: unknown) => clip(JSON.stringify(input ?? {}), 100);
const title = (p: string) => clip(p.replace(/\s+/g, " ").trim(), 60);

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
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: string; sub?: boolean; delegate?: boolean }
  | { kind: "result"; text: string; sub?: boolean }
  | { kind: "perm"; text: string; ok: boolean }
  | { kind: "cost"; text: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string };

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "banner":
      return (
        <Box flexDirection="column">
          <Text color={SAND}>{LOGO}</Text>
          <Text>
            <Text color={SAND} bold>
              {"   HEMIUNU"}
            </Text>
            <Text dimColor>{"  ·  product agent"}</Text>
          </Text>
        </Box>
      );
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
              <Text color={SAND} bold>{"⌂ "}</Text>
              <Text color={SAND} bold>{prettyTool(item.name)}</Text>
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
    case "result":
      return <Text dimColor>{`${item.sub ? "      " : "  "}⎿ ${item.text}`}</Text>;
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
  onClear,
}: {
  store: ConversationStore;
  registry: ReturnType<typeof loadMcpRegistry>;
  systemPrompt: string;
  initialModel: string;
  onClear: () => void;
}) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([{ kind: "banner" }]);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusLabel, setStatusLabel] = useState("thinking");
  const [permission, setPermission] = useState<{
    name: string;
    onChoice: (c: PermValue) => void;
  } | null>(null);
  const [sel, setSel] = useState(0);
  const [value, setValue] = useState("");
  const [sessionCost, setSessionCost] = useState(0);
  const [ctx, setCtx] = useState(0);
  const [epoch, setEpoch] = useState(0); // bump to remount <Static> (clear/compact)
  const [model, setModel] = useState(initialModel);
  const [picker, setPicker] = useState<{
    title: string;
    options: string[];
    onChoice: (v: string | null) => void;
  } | null>(null);
  const [skills, setSkills] = useState(() => loadSkills());
  const [cmdSel, setCmdSel] = useState(0); // highlighted row in the slash menu
  const [teams, setTeams] = useState<string[]>(() => listTeams());
  const [team, setTeam] = useState<string | undefined>(() => resolveRepo());
  const [device, setDevice] = useState<{ userCode: string; url: string } | null>(null);
  const githubLoginCancel = useRef(false);
  const [paused, setPaused] = useState(false); // hand the terminal to an interactive child (vercel login)

  // Detect a local filesystem server (it grants access to the launch folder).
  const fsName = Object.keys(registry.mcpServers).find(
    (n) =>
      n === "filesystem" ||
      (((registry.mcpServers as Record<string, { args?: unknown[] }>)[n]?.args ?? []) as unknown[]).some(
        (a) => typeof a === "string" && a.includes("server-filesystem"),
      ),
  );
  const [fsTrust, setFsTrust] = useState<boolean | null>(() =>
    fsName ? (store.getFolderTrust(process.cwd()) ?? null) : true,
  );

  const ctxWindow = contextWindowFor(model);

  // Only expose the filesystem server once the user has trusted this folder.
  const fsOn = fsTrust === true || !fsName;
  const activeServers = fsOn
    ? registry.mcpServers
    : Object.fromEntries(
        Object.entries(registry.mcpServers).filter(([n]) => n !== fsName),
      );
  const activePatterns = fsOn
    ? registry.toolPatterns
    : registry.toolPatterns.filter((p) => !p.startsWith(`mcp__${fsName}__`));

  const sessionId = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const liveRef = useRef("");
  const alwaysAllow = useRef(new Set<string>());
  const permChain = useRef<Promise<unknown>>(Promise.resolve());
  const compactedRef = useRef(""); // summary injected after /compact
  const justCompactedRef = useRef(false); // skip auto-compact the turn right after one
  // Each project (= team/repo) keeps its own foreground context; switching swaps
  // the whole lot. The active project lives in the React state/refs above; the
  // others are parked here, keyed by repo.
  const workspaces = useRef(
    new Map<string, { items: Item[]; sessionId?: string; compacted: string; ctx: number; cost: number }>(),
  );
  const currentProjectRef = useRef<string | undefined>(resolveRepo());
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
    const summary = compactedRef.current
      ? `\n\n## Summary of earlier conversation (compacted)\n${compactedRef.current}`
      : "";
    return systemPrompt + sources + skillList + summary;
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
          if (alwaysAllow.current.has(toolName)) {
            resolve({ behavior: "allow", updatedInput: input });
            return;
          }
          setSel(0);
          setPermission({
            name: toolName,
            onChoice: (choice) => {
              setPermission(null);
              if (choice === "always") alwaysAllow.current.add(toolName);
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
      | { behavior: "allow"; updatedInput: Record<string, unknown> }
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
    let cost: number | null = null;
    let usage: Record<string, number> | undefined;
    let fullText = "";

    try {
      for await (const m of runTurn({
        prompt: text,
        model,
        systemPrompt: effectiveSystem(),
        resume: sessionId.current,
        canUseTool,
        mcpServers: activeServers,
        toolPatterns: activePatterns,
        abortController: ac,
        // Live visibility into parallel subtasks (otherwise opaque).
        onSubagentEvent: (e) => {
          if (e.type === "task-start") {
            push({ kind: "tool", name: e.label, input: `→ ${e.agent} · running`, sub: true });
          } else if (e.type === "task-tool") {
            push({ kind: "tool", name: `${e.label} · ${prettyTool(e.tool)}`, input: "", sub: true });
          } else {
            push({ kind: "result", text: `${e.label} ${e.ok ? "done" : "failed"}`, sub: true });
          }
          setStatusLabel("parallel");
        },
      })) {
        const msg = m as any;
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId.current = msg.session_id;
        } else if (msg.type === "assistant") {
          const sub = !!msg.parent_tool_use_id;
          for (const b of msg.message.content) {
            if (b.type === "text") {
              // Suppress the researcher's own narration; only synthesis text shows.
              if (sub) continue;
              fullText += b.text;
              liveRef.current += b.text;
              turnTokensRef.current += Math.ceil(b.text.length / 4);
              setLive(liveRef.current);
            } else if (b.type === "tool_use") {
              if (liveRef.current.trim()) push({ kind: "text", text: liveRef.current });
              liveRef.current = "";
              setLive("");
              if (b.name === PARALLEL_TOOL_ID) {
                const tasks = Array.isArray(b.input?.tasks) ? b.input.tasks : [];
                const summary = tasks
                  .map((t: Record<string, unknown>) => String(t.label ?? t.agent ?? "task"))
                  .join(", ");
                push({
                  kind: "tool",
                  name: "parallel",
                  input: `${tasks.length} task${tasks.length === 1 ? "" : "s"}${summary ? ` · ${clip(summary, 60)}` : ""}`,
                  delegate: true,
                });
                setStatusLabel("parallel");
              } else if (b.name === "Agent" || b.name === "Task") {
                const who = String(b.input?.subagent_type ?? "subagent");
                const desc = clip(String(b.input?.description ?? ""), 56);
                // researcher runs on the cheap retrieval tier; others (e.g.
                // prototyper) on the main model.
                const subModel = who === "researcher" ? RESEARCH_MODEL : model;
                push({
                  kind: "tool",
                  name: who,
                  input: `${shortModel(subModel)}${desc ? ` · ${desc}` : ""}`,
                  delegate: true,
                });
                setStatusLabel(who === "prototyper" ? "prototyping" : "researching");
              } else {
                push({ kind: "tool", name: b.name, input: previewInput(b.input), sub });
                setStatusLabel(sub ? "researching" : "running");
              }
            }
          }
        } else if (msg.type === "user") {
          const sub = !!msg.parent_tool_use_id;
          for (const b of msg.message?.content ?? []) {
            if (b.type === "tool_result") {
              const t = resultText(b.content);
              if (t) push({ kind: "result", text: clip(t, 200), sub });
            }
          }
          setStatusLabel(sub ? "researching" : "thinking");
        } else if (msg.type === "result") {
          cost = msg.total_cost_usd ?? null;
          usage = msg.usage;
        }
      }
      if (liveRef.current.trim()) push({ kind: "text", text: liveRef.current });
    } catch (e) {
      if (ac.signal.aborted) push({ kind: "note", text: "⎯ interrupted" });
      else push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
      liveRef.current = "";
      setLive("");
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
    setItems(
      ws?.items ?? [
        { kind: "banner" },
        { kind: "note", text: target ? `· team ${target}` : "· no team — working locally" },
      ],
    );
    setEpoch((e) => e + 1);
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
        mcpServers: activeServers,
        toolPatterns: activePatterns,
        abortController: ac,
      })) {
        const msg = m as any;
        if (msg.type === "assistant")
          for (const b of msg.message.content)
            if (b.type === "text") {
              summary += b.text;
              turnTokensRef.current += Math.ceil(b.text.length / 4);
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
          sessionId.current = undefined; // fresh session for the new model
          setCtx(0);
          push({ kind: "note", text: `· model set to ${v}` });
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
      return push({ kind: "error", text: `GitHub sign-in: ${e instanceof Error ? e.message : String(e)}` });
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
        upsertUserEnv("GITHUB_TOKEN", poll.token);
        setDevice(null);
        return push({ kind: "note", text: `· signed in to GitHub as ${login ?? "you"} (saved)` });
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
      text: githubLoginCancel.current ? "· GitHub sign-in cancelled" : "· GitHub sign-in timed out — /github to retry",
    });
  }

  // Connect Vercel with its own browser login (no token) — needs the real
  // terminal, so pause the TUI (render nothing) while `vercel login` runs, then
  // resume with all state intact. Remembered machine-wide, so it's a one-time step.
  async function connectVercel() {
    setPaused(true);
    await sleep(80); // let Ink render an empty frame and drop raw mode
    try {
      (process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void }).setRawMode?.(false);
    } catch {
      // ignore — Ink manages raw mode; this is best-effort
    }
    const ok = await vercelLogin();
    setPaused(false);
    push({ kind: "note", text: ok ? "· connected to Vercel" : "· Vercel sign-in was cancelled or didn't complete" });
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
    if (cmd === "trust") {
      if (!fsName) return push({ kind: "note", text: "· no filesystem server configured" });
      return promptTrust();
    }
    if (cmd === "mcp") {
      const names = Object.keys(registry.mcpServers).join(", ") || "none";
      const userMcp = join(configDir(), "mcp.json");
      return push({
        kind: "note",
        text: `mcp connected: ${names}\nadd your own servers in ${userMcp} (merged over the defaults)`,
      });
    }
    if (cmd === "setup") {
      const set = (v?: string) => (v && v.trim() ? "✓" : "✗");
      return push({
        kind: "note",
        text:
          `config: ${join(configDir(), ".env")}\n` +
          `  ANTHROPIC_API_KEY ${set(hasApiKey() ? "y" : "")}   ` +
          `NOTION_TOKEN ${set(process.env.NOTION_TOKEN)}   ` +
          `TAVILY_API_KEY ${set(process.env.TAVILY_API_KEY)}\n` +
          `edit that file to change keys, then restart hemiunu.`,
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
      const token = rest.join(" ").trim();
      // Explicit token paste (fallback) → verify + save.
      if (token) {
        void (async () => {
          const login = await githubViewer(token);
          if (!login)
            return push({
              kind: "error",
              text: "that token didn't work — make sure it has repo contents read/write, then /github <token>",
            });
          const path = upsertUserEnv("GITHUB_TOKEN", token);
          push({ kind: "note", text: `· signed in to GitHub as ${login} (saved to ${path})` });
        })();
        return;
      }
      // Already connected? report who.
      const existing = resolveGithubToken();
      if (existing) {
        void (async () => {
          const login = await githubViewer(existing);
          push({
            kind: "note",
            text: login
              ? `· signed in to GitHub as ${login}`
              : "· a GitHub token is set but was rejected — run /github <token> with a valid one",
          });
        })();
        return;
      }
      // Not connected: prefer the in-CLI device flow; fall back to a pasted token.
      if (githubClientId()) {
        void startGithubLogin();
      } else {
        push({
          kind: "note",
          text:
            "· not signed in to GitHub.\n" +
            "  device sign-in isn't configured (no OAuth client id) — paste a token instead:\n" +
            "  create a fine-grained token (repo contents: read & write) and run /github <token>.",
        });
      }
      return;
    }
    if (cmd === "vercel") {
      const arg = rest.join(" ").trim();
      // A pasted token is still supported as a power-user/CI fallback.
      if (arg && arg !== "login") {
        const path = upsertUserEnv("VERCEL_TOKEN", arg);
        return push({ kind: "note", text: `· Vercel token saved to ${path}` });
      }
      if (arg !== "login" && (resolveVercelToken() || vercelLoggedIn())) {
        return push({ kind: "note", text: "· Vercel: connected" });
      }
      void connectVercel(); // browser login, no token, remembered machine-wide
      return;
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
      const name = rest.join(" ").trim();
      if (!name)
        return push({
          kind: "note",
          text: "· usage: /team-new <name>  (creates a private repo and switches to it)",
        });
      const token = resolveGithubToken();
      if (!token) return push({ kind: "note", text: "· sign in first with /github" });
      push({ kind: "note", text: `· creating private repo ${name}…` });
      void (async () => {
        const r = await createRepo(token, name, { private: true });
        if ("error" in r) return push({ kind: "error", text: `couldn't create repo: ${r.error}` });
        const repo = addTeam(r.repo);
        setTeams(listTeams());
        switchProject(repo);
        push({ kind: "note", text: `· created ${repo} (private) — switched to it` });
      })();
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
            if (v !== null) switchProject(v === NONE ? null : v);
          },
        });
        return;
      }
      const repo = addTeam(arg);
      setTeams(listTeams());
      switchProject(repo);
      return push({ kind: "note", text: `· switched to team ${repo}` });
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
  const inputActive = !busy && !permission && !picker && !device && !paused;
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
          Math.min(
            menuSel - Math.floor(SLASH_MENU_ROWS / 2),
            slashItems.length - SLASH_MENU_ROWS,
          ),
        );

  // Keep the highlight on the top match as the filter narrows; refresh the
  // skills list whenever the user enters slash mode (picks up newly-saved ones).
  useEffect(() => setCmdSel(0), [slashToken]);
  const inSlash = value.startsWith("/");
  useEffect(() => {
    if (inSlash) setSkills(loadSkills());
  }, [inSlash]);

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
    setValue("");
    setCmdSel(0);
    if (text.startsWith("/")) handleCommand(text);
    else void runUserTurn(text);
  };

  useInput(
    (_input, key) => {
      if (permission) {
        const n = MENU_CHOICES.length;
        if (key.upArrow) setSel((s) => (s - 1 + n) % n);
        else if (key.downArrow) setSel((s) => (s + 1) % n);
        else if (key.return) permission.onChoice(MENU_CHOICES[sel].value);
        else if (key.escape) permission.onChoice("no");
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
    { isActive: !paused && (busy || !!permission || !!picker || !!device) },
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
        else switchProject(next === "" ? null : next);
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
  const frame = PYRAMID[Math.floor(elapsed / 160) % PYRAMID.length];
  const word =
    statusLabel === "compacting"
      ? "Compacting"
      : statusLabel === "researching"
        ? "Researching"
        : statusLabel === "prototyping"
          ? "Prototyping"
          : statusLabel === "parallel"
            ? "Orchestrating"
            : WORDS[Math.floor(elapsed / 4000) % WORDS.length];

  // While paused, render nothing so an interactive child (vercel login) owns the
  // terminal; state is preserved and the full UI returns on resume.
  if (paused) return null;

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

      {busy && !permission && !picker ? (
        <Box marginTop={1}>
          <Text color={SAND} bold>
            {`${frame} ${word}… `}
          </Text>
          <Text dimColor>
            {`(${fmtElapsed(elapsed)} · ↑ ${tokfmt(turnTokensRef.current)} tokens · esc to interrupt)`}
          </Text>
        </Box>
      ) : null}

      {permission ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={SAGE}>{"⚙ "}</Text>
            {"Allow "}
            <Text color={SAND} bold>
              {prettyTool(permission.name)}
            </Text>
            {"?"}
          </Text>
          {MENU_CHOICES.map((c, i) => (
            <Text key={c.value} color={i === sel ? SAGE : undefined} dimColor={i !== sel}>
              {i === sel ? "❯ " : "  "}
              {c.label}
            </Text>
          ))}
        </Box>
      ) : null}

      {picker ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={SAGE} bold>
            {picker.title}
          </Text>
          {picker.options.map((opt, i) => (
            <Text key={opt} color={i === sel ? SAGE : undefined} dimColor={i !== sel}>
              {i === sel ? "❯ " : "  "}
              {opt}
            </Text>
          ))}
        </Box>
      ) : null}

      {showMenu ? (
        <Box flexDirection="column" marginTop={1}>
          {menuStart > 0 ? <Text dimColor>{`  ↑ ${menuStart} more`}</Text> : null}
          {slashItems.slice(menuStart, menuStart + SLASH_MENU_ROWS).map((it, i) => {
            const idx = menuStart + i;
            return (
              <Text key={it.name} color={idx === menuSel ? SAGE : undefined} dimColor={idx !== menuSel}>
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

      {device ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={SAGE}>{"⌂ "}</Text>
            <Text color={SAND} bold>Connect GitHub</Text>
          </Text>
          <Text dimColor>{"  1. opening "}<Text color={SAGE}>{device.url}</Text>{" in your browser"}</Text>
          <Text>
            {"  2. enter this code:  "}
            <Text color={SAND} bold>{device.userCode}</Text>
          </Text>
          <Text dimColor>{"  waiting for you to authorize…  (Esc to cancel)"}</Text>
        </Box>
      ) : null}

      {inputActive ? (
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor={SAND}
          borderLeft={false}
          borderRight={false}
        >
          <Text color={SAND} bold>
            {"› "}
          </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={onSubmit}
            placeholder="Ask Hemiunu…  (/help for commands)"
          />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={SAND} bold>{teamLabel}</Text>
        <Text color={SAGE}>{`  ${model} · ${ctxStr} · session $${sessionCost.toFixed(2)}`}</Text>
        {teams.length >= 1 ? <Text dimColor>{"  · ⇧⇥ team"}</Text> : null}
      </Box>
    </Box>
  );
}

// --- first-run setup: collect keys without making the user edit a file ---

interface SetupValues {
  apiKey: string;
  baseUrl: string;
  notionToken: string;
  tavilyKey: string;
}
const SETUP_FIELDS: {
  key: keyof SetupValues;
  label: string;
  hint: string;
  mask?: boolean;
  required?: boolean;
}[] = [
  { key: "apiKey", label: "Anthropic API key", hint: "the Claude brain — required", mask: true, required: true },
  { key: "baseUrl", label: "Gateway base URL", hint: "optional — Enter for Anthropic direct, or a proxy URL" },
  { key: "notionToken", label: "Notion token", hint: "optional — press Enter to skip" },
  { key: "tavilyKey", label: "Tavily key", hint: "optional (web search) — press Enter to skip" },
];

function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState("");
  const valuesRef = useRef<SetupValues>({ apiKey: "", baseUrl: "", notionToken: "", tavilyKey: "" });
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
        notionToken: vals.notionToken || undefined,
        tavilyKey: vals.tavilyKey || undefined,
      });
      onDone();
    }
  };

  return (
    <Box flexDirection="column">
      <Text color={SAND}>{LOGO}</Text>
      <Box marginTop={1} marginLeft={3}>
        <Text color={SAND} bold>Welcome to Hemiunu — let's get you set up.</Text>
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
        <Text dimColor>{`${field.hint}  ·  ${step + 1}/${SETUP_FIELDS.length}  ·  saved to ${join(configDir(), ".env")}`}</Text>
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

async function main() {
  // Hemiunu's HOME (its config: soul.md, mcp.json, context/) is the install
  // dir when launched via the `hemiunu` command, else the current dir (running
  // from the repo). This is separate from the launch dir, which the agent reads
  // files from via the filesystem MCP (${CWD}) — so `hemiunu` works in any folder.
  const home = process.env.HEMIUNU_HOME ?? process.cwd();
  // The user's config + state (keys, conversations, folder-trust) live in one
  // place — NOT in the cloned code, so updates never clobber them.
  const dataDir = configDir();
  mkdirSync(dataDir, { recursive: true });
  // First run: if no key is configured, ask for it (and optional tokens) inline
  // and write ~/.hemiunu/.env — no file editing required.
  if (!hasApiKey()) await runSetup();
  const store = new ConversationStore(join(dataDir, "hemiunu.db"));
  // App default mcp.json + the user's own overlay (~/.hemiunu/mcp.json).
  const registry = loadMcpRegistry(home, join(dataDir, "mcp.json"));
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
      onClear={() => handle.clear()}
    />,
  );
  handle.clear = () => app.clear();
  await app.waitUntilExit();
  stopPreview(); // tear down any running localhost preview
  store.close();
}

main();
