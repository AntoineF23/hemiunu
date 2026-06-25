import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { asStream } from "./messages";
import { SOURCE_TOOLS, loadSourceMaps } from "./sources";
import { createToolCapHook } from "./toolcap";

/** save_prototype tool pattern (the prototyper's only tool). */
const PROTOTYPE_TOOLS = "mcp__hemiunu-prototype__*";

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

export type SubagentName = "researcher" | "prototyper" | "strategist" | "analyst";

/** System prompt for the `researcher` subagent (runs on the cheaper retrieval tier). */
export const RESEARCHER_PROMPT = `You are Hemiunu's research subagent. The coordinator delegates a research request to you; your job is to gather grounded information from the connected data sources so the coordinator can answer.

- Search the available sources (Notion, local files, and any other connected MCP servers) thoroughly. Run several searches/reads as needed — don't stop at the first hit.
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
      "Searches the connected data sources (Notion, local files, and any other connected MCP servers) and returns grounded findings with citations. Delegate any question that needs looking things up, or any non-trivial product/research question.",
    prompt: RESEARCHER_PROMPT,
    tier: "research",
    tools: (sourceTools) => [...sourceTools, SOURCE_TOOLS],
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
      hooks: createToolCapHook(),
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: ctx.apiKey,
        ...(ctx.baseUrl ? { ANTHROPIC_BASE_URL: ctx.baseUrl } : {}),
      } as Record<string, string>,
      mcpServers: ctx.mcpServers,
      tools,
      allowedTools: tools,
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
