import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { sdkConfigDir } from "./config";
import { asStream } from "./messages";
import { SOURCE_TOOLS, loadSourceMaps } from "./sources";
import { createAgentHooks } from "./toolcap";

/** save_prototype tool pattern (the prototyper's only tool). */
const PROTOTYPE_TOOLS = "mcp__hemiunu-prototype__*";

/** Workspace tools (list/read/write_workspace_file, iterate_prototype) — the
 *  designer reads the wireframe and edits the multi-file hi-fi project with them. */
const WORKSPACE_TOOLS = "mcp__hemiunu-workspace__*";

/**
 * Load a domain knowledge doc from context/knowledge/<name>.md ("" if absent).
 * These are committed app assets, so resolve them against HEMIUNU_HOME (the
 * install dir) rather than the launch folder — otherwise running hemiunu from
 * any other directory silently drops them (e.g. the prototyper's design guide).
 */
function knowledge(name: string, root: string = process.env.HEMIUNU_HOME ?? process.cwd()): string {
  const path = join(root, "context", "knowledge", `${name}.md`);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/**
 * Resolve a subagent's full system prompt. Each subagent can declare a domain
 * knowledge pack (`context/knowledge/<name>.md`) that's injected ONLY into its
 * own prompt — so the team scales (add a pack + point a subagent at it) without
 * bloating the always-on coordinator prompt. See context/knowledge/README.md.
 * The researcher additionally gets the live list of connected source maps.
 */
export function subagentPrompt(name: SubagentName): string {
  const spec = SUBAGENTS[name];
  let prompt = spec.prompt;

  // Researcher: the live source-map list (dynamic, not a file).
  if (name === "researcher") {
    const maps = loadSourceMaps();
    if (maps.length) {
      const list = maps
        .map((m) => `- ${m.mcp} — ${m.description || "(no description)"}`)
        .join("\n");
      prompt += `

# Source maps
Some connected sources have a saved map of what's inside them. Before searching a source, consult its map with get_source_map (it gives key page/database ids + how to query) so you go straight to the right place. If you find the map is out of date, fix it with save_source_map (correct/remove only what you can verify; leave anything you can't confirm). Sources with a map:
${list}`;
    }
  }

  // Any subagent's declared knowledge pack (committed under context/knowledge/).
  if (spec.knowledge) {
    const doc = knowledge(spec.knowledge.name);
    if (doc) {
      const intro = spec.knowledge.intro ? `\n\n${spec.knowledge.intro}` : "";
      prompt += `\n\n# ${spec.knowledge.header}${intro}\n\n${doc}`;
    }
  }
  return prompt;
}

export type SubagentName = "researcher" | "prototyper" | "designer" | "strategist" | "analyst";

/**
 * The SDK's built-in server-side web tools (run on Anthropic's infrastructure;
 * no MCP server or API key). The only built-ins we opt into — every use still
 * flows through the yes/always/no permission prompt on the main loop. NB: like
 * MCP tool search, server-side tools may not forward through an Anthropic-
 * compatible gateway (ANTHROPIC_BASE_URL); they work talking to Anthropic direct.
 */
export const WEB_TOOLS = ["WebSearch", "WebFetch"];

/**
 * The SDK's built-in planning tools, to lift output quality on complex,
 * multi-step work: the model can lay out a structured plan before building
 * (EnterPlanMode → research read-only → ExitPlanMode presents the plan for
 * approval) and track execution with a todo list (TodoWrite). Main loop only —
 * subagents are already scoped, single-purpose delegations. Gating: TodoWrite +
 * EnterPlanMode are auto-approved (internal, read-only), while ExitPlanMode
 * keeps the permission prompt — it's the plan-approval gate.
 */
export const PLANNING_TOOLS = ["EnterPlanMode", "ExitPlanMode", "TodoWrite"];

/** System prompt for the `researcher` subagent (runs on the cheaper retrieval tier). */
export const RESEARCHER_PROMPT = `You are Hemiunu's research subagent. The coordinator delegates a research request to you; your job is to gather grounded information from the connected data sources so the coordinator can answer.

- Search the available sources (local files and any connected MCP servers) thoroughly. Run several searches/reads as needed — don't stop at the first hit.
- Use the RIGHT tool for each source: read local files with the filesystem read tools (read_text_file / search_files), fetch design data with the connected design tools (e.g. Figma), search docs with the connected document/knowledge sources or the web. NEVER use a browser / web-automation tool (whatever it's called — Playwright or another) or its evaluate/run-script function to read or write local files: a browser page has no filesystem access, and it pops a browser window. Reserve any browser tool strictly for inspecting a live web page.
- Narrate as you go, so your work is transparent: before a search or read, write ONE short line on what you're looking for; right after, ONE short line on what you found (a key result, or that it was empty) and what you'll check next. Keep each to a single line — these are progress notes, not the report.
- Return only what you actually found, each point attributed to its source (page title, file path, URL).
- If the sources do not contain the answer, say so plainly. Never invent facts or fill gaps from general knowledge.
- End with a concise findings brief (short bullets or sections) for the coordinator to synthesize. Do not address the end user directly.`;

/** System prompt for the `prototyper` subagent (generates low-fi HTML wireframes). */
export const PROTOTYPER_PROMPT = `You are Hemiunu's prototyper subagent. The coordinator hands you a brief — goal, primary user, the screen(s) to build, their sections/components, and real content. Turn it into a single self-contained low-fidelity HTML wireframe and save it with the save_prototype tool.

Rules:
- LOW-FIDELITY ONLY: grayscale (white/greys/black text), system font, no brand colours, no images (use labelled placeholder boxes). The goal is structure and flow, not visual design.
- Use REAL content from the brief — real labels, headings, field names, sample rows — never lorem ipsum.
- One self-contained index.html: all CSS inline in a <style> tag. NO external requests — no CDNs, fonts, images, or JS frameworks. Plain fl/grid CSS for layout is fine.
- Represent rich components as simple bordered boxes with a label (e.g. a chart → a box labelled "Line chart: paid net adds over time"; a table → a box with a few header cells and sample rows). Show key states (empty/loading) only if the brief calls for them.
- Build only the screen(s) in the brief. Add small annotation notes sparingly where they aid understanding.
- Save via save_prototype with an index.html entry point (and any assets); files are written flat into the prototype workspace, alongside PROTOTYPE.md. Then tell the coordinator in one or two lines what you built and the saved path. Do not address the end user directly.`;

/** System prompt for the `designer` subagent (Stage B — hi-fi, on-brand React + Tailwind; synthesis tier). */
export const DESIGNER_PROMPT = `You are Hemiunu's designer subagent. The coordinator hands you a brief — goal, primary user, the screen(s), their sections/components, real content — and tells you which design system (if any) is connected. Your job is to produce a HIGH-FIDELITY, on-brand, near-production prototype, building it STEP BY STEP so the user can watch it come together (the live preview updates as you go). This is Stage B: real components, real type and colour, real polish — not a grayscale wireframe.

Start from the wireframe when there is one. If a low-fi wireframe already exists in the workspace, read it first (list_workspace_file, then read_workspace_file on index.html) and PRESERVE its structure and flow — you are upgrading fidelity (real components, brand colour, typography, states, motion), not redesigning. If there is no wireframe, build directly from the brief.

Big files & big tool results: never skip something or hand-roll a substitute because it's large. Use search_workspace to find the lines you need, then read_workspace_file with offset/limit to read just that window. If a tool result (e.g. a full DIVE template) is too large and gets SAVED to a file (a path under …/tool-results/…), that's not a dead end — read that file with read_workspace_file + offset/limit, in windows, and use the real thing instead of falling back to piecing it together.

DESIGN SYSTEM FIRST. If a design-system MCP is connected (you'll have its tools — e.g. list_design_system / get_component / design_tokens_css / design_fonts, or Figma get_design_context / get_variable_defs), it is the SINGLE SOURCE OF TRUTH:
- Call it first. Read its overview/tokens/styles guidelines and set up its stack EXACTLY as they prescribe (it will usually be React + TypeScript + Tailwind).
- For every piece of UI, find the matching component and fetch it; recreate every component/asset file it returns at its given path and keep the import lines as-is. Do NOT skip files, redraw SVGs, hand-roll markup, hardcode hex colours, or guess class names.
- Use the DS's real tokens, typography classes, and fonts — without design_fonts (or the DS equivalent) the brand typefaces fall back, so include it.

NO DESIGN SYSTEM → solid default stack. If none is connected, build a real, multi-file **Vite + React + TypeScript + Tailwind v4** project — production quality, not a single-file CDN page. Scaffold:
- package.json — vite, react, react-dom, typescript, tailwindcss v4 + @tailwindcss/vite, @vitejs/plugin-react; a "dev" script ("vite").
- vite.config.ts — react() + @tailwindcss/vite plugins.
- index.html (root entry, loads /src/main.tsx), src/main.tsx, src/App.tsx.
- src/index.css — @import "tailwindcss"; plus a coherent design-token layer (CSS variables for colour, type scale, spacing, radius, shadow) exposed to Tailwind.
- src/components/*.tsx — small, accessible, semantic components.
Quality bar: a consistent token system (don't scatter raw hex/px), clear visual hierarchy, accessible semantics and focus states, responsive layout, real content from the brief (never lorem), and finished empty / loading / hover / disabled states. Apply the Visual Craft and Delight design principles below — colour, type, spacing, motion, and feedback are your job here (they were deferred at the wireframe stage).

BUILD STEP BY STEP — like a developer working in the open, never one big dump. Stage it and narrate it so the user watches the app assemble:
1. SCAFFOLD FIRST: write the project skeleton in ONE save_prototype call — package.json (with the "dev" script), vite.config.ts, index.html, src/main.tsx, src/index.css (the design-token layer), and a minimal src/App.tsx shell. This boots the live preview (the dev server needs package.json present); the first run installs dependencies, so it takes a moment.
2. THEN BUILD INCREMENTALLY with write_workspace_file — ONE file/component per call. Add each component, wire it into App, refine styles, fix issues — each write hot-reloads the preview, so every step shows up live.
3. NARRATE EVERY STEP: right BEFORE each tool call, write ONE short line saying what you're about to do — e.g. "Setting up the Vite + React + Tailwind project", "Building the Header", "Wiring the sidebar into App", "Fixing the import path in App.tsx". One line per step, like a build log — not a report.
NEVER put the whole app in a single save_prototype call: after the scaffold, every component and every fix is its own narrated write_workspace_file step.

When the screen is complete, tell the coordinator in one or two lines what you built and the key decisions. Do NOT publish or commit — the coordinator handles that after the user validates the preview. Do not address the end user directly.`;

/** System prompt for the `strategist` subagent (product judgment; synthesis tier). */
export const STRATEGIST_PROMPT = `You are Hemiunu's product strategist subagent. The coordinator hands you a decision, idea, or trade-off; assess it with sharp product judgment and return a clear recommendation — you do NOT build anything.

- Weigh desirability (do users want it?), viability (does it serve the business?), and feasibility (can we build it?) — name the binding constraint.
- Pressure-test the problem before the solution: whose problem, how painful, how do we know. Call out untested assumptions and the riskiest one.
- Size the opportunity and the cost honestly; prefer the cheapest experiment that would change your mind.
- Be decisive: give a recommendation (do it / don't / validate first), the reasoning in a few bullets, and the single cheapest next step to de-risk it.
- Ground claims in what the coordinator gives you (research, PROTOTYPE.md, data). If evidence is missing, say what you'd need rather than inventing it. Do not address the end user directly.`;

/** System prompt for the `analyst` subagent (data/metrics interpretation; synthesis tier). */
export const ANALYST_PROMPT = `You are Hemiunu's data & insights analyst subagent. The coordinator gives you data, metrics, or a question about them; interpret it rigorously and return the insight that matters.

- Say what the numbers show AND what they don't — segments, time windows, base rates, confounders, sample size. Distinguish correlation from cause.
- Quantify (magnitudes, deltas, %); never invent figures. If a number you need is missing, state exactly what to measure or pull.
- Flag weak or misleading evidence (vanity metrics, survivorship, selection bias) plainly.
- End with the key insight(s) in one or two lines and the recommended action or the metric to track next. Do not address the end user directly.`;

export interface SubagentSpec {
  description: string;
  prompt: string;
  /** Which model tier this subagent runs on. */
  tier: "research" | "synthesis";
  /** The tool patterns this subagent may use, given the connected source tools. */
  tools: (sourceTools: string[]) => string[];
  /** Optional domain knowledge pack injected into this subagent's prompt
   *  (context/knowledge/<name>.md). See context/knowledge/README.md. */
  knowledge?: { name: string; header: string; intro?: string };
  /** Only registered when sources are connected (e.g. the researcher). */
  needsSources?: boolean;
}

/** Single source of truth for subagents — used both for the SDK `agents`
 *  option (delegation via Task) and for code-level parallel fan-out. */
export const SUBAGENTS: Record<SubagentName, SubagentSpec> = {
  researcher: {
    description:
      "Searches the connected data sources (local files and any connected MCP servers) and returns grounded findings with citations. Delegate any question that needs looking things up, or any non-trivial product/research question.",
    prompt: RESEARCHER_PROMPT,
    tier: "research",
    tools: (sourceTools) => [...sourceTools, SOURCE_TOOLS, ...WEB_TOOLS],
    needsSources: true,
  },
  prototyper: {
    description:
      "Turns a brief (goal, user, screens, sections, components, content) into a self-contained low-fidelity HTML wireframe and saves it. Delegate once you have a clear brief and the user wants something built/visualised.",
    prompt: PROTOTYPER_PROMPT,
    tier: "synthesis",
    tools: () => [PROTOTYPE_TOOLS],
    knowledge: {
      name: "design",
      header: "Design principles to apply",
      intro:
        "Apply these when making structural and interaction decisions. At the LOW-FI wireframe stage you are working on, lean on Purpose, Agency (incl. Forgiveness), Familiarity, Flexibility, and especially Simplicity/Clarity — hierarchy via order, spacing, and contrast; every element earns its place. Visual Craft (fonts, colour, motion) and Delight polish belong to the hi-fi stage, not here — keep the wireframe grayscale and structural, but let these principles shape what you include and how you arrange it.",
    },
  },
  designer: {
    description:
      "Upgrades an approved wireframe (or a clear brief) into a high-fidelity, on-brand React + Tailwind prototype — using the connected design system if one is present, else a solid Vite + React + TS + Tailwind v4 stack. Delegate for the hi-fi / styled / 'make it real' stage once structure is settled.",
    prompt: DESIGNER_PROMPT,
    tier: "synthesis",
    tools: (sourceTools) => [PROTOTYPE_TOOLS, WORKSPACE_TOOLS, ...sourceTools],
    knowledge: {
      name: "hifi-design",
      header: "High-fidelity design craft",
      intro:
        "You are at the HI-FI stage, so the Visual Craft and Delight principles are now in scope — colour, typography, spacing, motion, and feedback. Use a design system's real components and tokens when one is connected; otherwise hold the bar below with the Vite + React + TS + Tailwind v4 fallback.",
    },
  },
  strategist: {
    description:
      "Assesses a product decision, idea, or trade-off with strategic judgment (desirability/viability/feasibility, opportunity sizing, prioritisation, risks) and returns a clear recommendation + the cheapest next validation. Delegate prioritisation, 'should we build X', positioning, or scope trade-off questions — give it the relevant context/research.",
    prompt: STRATEGIST_PROMPT,
    tier: "synthesis",
    tools: () => [],
    knowledge: { name: "strategy", header: "Product strategy principles" },
  },
  analyst: {
    description:
      "Interprets data/metrics rigorously — what they show, what they don't, segments, confounders, what to measure next — and returns the key insight + recommended action. Delegate questions about metrics, funnels, experiment results, or 'what does this data mean' — give it the actual numbers/source.",
    prompt: ANALYST_PROMPT,
    tier: "synthesis",
    tools: () => [],
    knowledge: { name: "metrics", header: "Analytics principles" },
  },
};

export const SUBAGENT_NAMES = Object.keys(SUBAGENTS) as SubagentName[];

/** Live progress emitted while parallel subtasks run, for CLI visibility. */
export type SubagentEvent =
  | { type: "task-start"; label: string; agent: SubagentName }
  | { type: "task-tool"; label: string; tool: string }
  | { type: "task-done"; label: string; agent: SubagentName; ok: boolean };

/** Everything a subagent needs to run, resolved for the current turn. */
export interface SubagentRunContext {
  /** Main / synthesis model. */
  model: string;
  /** Cheaper retrieval-tier model. */
  researchModel: string;
  /** Connected source tool patterns (mcp__<name>__*). */
  sourceTools: string[];
  /** MCP servers the subagent can reach (in-process + registry). */
  mcpServers: Options["mcpServers"];
  /** Brain endpoint (undefined = Anthropic direct). */
  baseUrl: string | undefined;
  apiKey: string;
  thinking: Options["thinking"];
  /** Live progress sink for parallel subtasks (CLI visibility). */
  onEvent?: (e: SubagentEvent) => void;
  /** Turn-wide abort signal. Threaded into every sub-run's query so stopping the
   *  turn also cancels in-flight subagents instead of letting them run on. */
  abortController?: AbortController;
}

function modelFor(spec: SubagentSpec, ctx: SubagentRunContext): string {
  return spec.tier === "research" ? ctx.researchModel : ctx.model;
}

/**
 * Run one subagent to completion in its OWN isolated context and return its
 * final text. This is the code-level equivalent of an SDK `Task` delegation —
 * used by the `parallel` orchestrator to fan subagents out concurrently
 * (something the model won't do on its own). Tools are auto-approved inside the
 * sub-run; the gate is approving the orchestrating call.
 */
export async function runSubagent(
  name: SubagentName,
  prompt: string,
  ctx: SubagentRunContext,
  onTool?: (toolName: string) => void,
): Promise<string> {
  const spec = SUBAGENTS[name];
  const tools = spec.tools(ctx.sourceTools);
  let text = "";
  for await (const m of query({
    prompt,
    options: {
      model: modelFor(spec, ctx),
      thinking: ctx.thinking,
      systemPrompt: subagentPrompt(name),
      hooks: createAgentHooks(),
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: ctx.apiKey,
        ...(ctx.baseUrl ? { ANTHROPIC_BASE_URL: ctx.baseUrl } : {}),
        // Keep the SDK's session data under ~/.hemiunu, not ~/.claude.
        CLAUDE_CONFIG_DIR: sdkConfigDir(),
      } as Record<string, string>,
      mcpServers: ctx.mcpServers,
      tools,
      allowedTools: tools,
      ...(ctx.abortController ? { abortController: ctx.abortController } : {}),
    },
  })) {
    const msg = asStream(m);
    if (onTool && msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use" && typeof b.name === "string") onTool(b.name);
      }
    }
    if (msg.type === "result" && typeof msg.result === "string") text = msg.result;
  }
  return text;
}
