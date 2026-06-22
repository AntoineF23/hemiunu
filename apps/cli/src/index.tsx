import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runTurn, REMEMBER_TOOL_ID } from "@hemiunu/agent-core";
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
  "/new   /clear   /compact   /models   /trust   /list   /resume <id>   /mcp   /exit";

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

  // System prompt = soul/user/memory + connected sources (active) + compacted summary.
  const effectiveSystem = () => {
    const names = Object.keys(activeServers);
    const sources = names.length
      ? `\n\n## Connected data sources\nThese tools/data sources are connected right now: ${names.join(", ")}. When asked about anything you can't answer from general knowledge, search them before responding, and ground your answer in what you find.`
      : "";
    const summary = compactedRef.current
      ? `\n\n## Summary of earlier conversation (compacted)\n${compactedRef.current}`
      : "";
    return systemPrompt + sources + summary;
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
              if (b.name === "Agent" || b.name === "Task") {
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

    // Auto-compact when context crosses the threshold (Hermes-style).
    if (!skipAuto && ctxTokens >= ctxWindow * COMPACT_AT) {
      push({
        kind: "note",
        text: `✦ Context at ${Math.round((ctxTokens / ctxWindow) * 100)}% — compacting…`,
      });
      await runCompact();
    }
  }

  async function runCompact() {
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
      push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
    if (summary.trim()) {
      compactedRef.current = summary.trim();
      sessionId.current = undefined; // drop the long session; continue from summary
      justCompactedRef.current = true; // don't auto-compact again next turn
      setCtx(0);
      setEpoch((e) => e + 1);
      setItems([
        { kind: "banner" },
        { kind: "note", text: "✦ Context compacted — continuing from this summary:" },
        { kind: "text", text: summary.trim() },
      ]);
    }
  }

  async function showModels() {
    const base = (process.env.ANTHROPIC_BASE_URL ?? "https://models.thiga.co").replace(
      /\/+$/,
      "",
    );
    let ids: string[] = [];
    try {
      const res = await fetch(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${process.env.ANTHROPIC_API_KEY ?? ""}` },
      });
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
      return push({ kind: "note", text: `mcp connected: ${names}` });
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
    push({ kind: "note", text: `· unknown command: /${cmd}` });
  }

  const onSubmit = (v: string) => {
    const text = v.trim();
    setValue("");
    if (!text) return;
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
      if (busy && key.escape) abortRef.current?.abort();
    },
    { isActive: busy || !!permission || !!picker },
  );

  const ctxStr = ctx
    ? `ctx ${kfmt(ctx)}/${kfmt(ctxWindow)} (${Math.round((ctx / ctxWindow) * 100)}%)`
    : `ctx ${kfmt(ctxWindow)}`;

  const elapsed = busy ? Date.now() - turnStartRef.current : 0;
  const frame = PYRAMID[Math.floor(elapsed / 160) % PYRAMID.length];
  const word =
    statusLabel === "compacting"
      ? "Compacting"
      : statusLabel === "researching"
        ? "Researching"
        : statusLabel === "prototyping"
          ? "Prototyping"
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

      {!busy && !permission && !picker ? (
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
        <Text color={SAGE}>{` ${model} · ${ctxStr} · session $${sessionCost.toFixed(2)}`}</Text>
      </Box>
    </Box>
  );
}

async function main() {
  // The agent's own state (conversations, folder-trust) lives in one global
  // place — NOT in whatever folder you launch from. File access stays scoped
  // to the launch dir via the filesystem MCP (${CWD}).
  const dataDir = join(homedir(), ".hemiunu");
  mkdirSync(dataDir, { recursive: true });
  const store = new ConversationStore(join(dataDir, "hemiunu.db"));
  const registry = loadMcpRegistry();
  const model = process.env.HEMIUNU_MODEL ?? "claude-opus-4.8";
  // First run: seed each user's own (gitignored) user.md / memory.md from the
  // committed *.example templates, so a fresh clone starts with blank memory.
  seedContextFiles();
  const systemPrompt = buildSystemPrompt(loadContext());

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
  store.close();
}

main();
