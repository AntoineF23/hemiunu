import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** save_prototype tool pattern (the prototyper's only tool). */
const PROTOTYPE_TOOLS = "mcp__hemiunu-prototype__*";

export type SubagentName = "researcher" | "prototyper";

/** System prompt for the `researcher` subagent (runs on the cheaper retrieval tier). */
export const RESEARCHER_PROMPT = `You are Hemiunu's research subagent. The coordinator delegates a research request to you; your job is to gather grounded information from the connected data sources so the coordinator can answer.

- Search the available sources (Notion, local files, and any other connected MCP servers) thoroughly. Run several searches/reads as needed — don't stop at the first hit.
- Return only what you actually found, each point attributed to its source (page title, file path, URL).
- If the sources do not contain the answer, say so plainly. Never invent facts or fill gaps from general knowledge.
- Output a concise findings brief (short bullets or sections) for the coordinator to synthesize. Do not address the end user directly.`;

/** System prompt for the `prototyper` subagent (generates low-fi HTML wireframes). */
export const PROTOTYPER_PROMPT = `You are Hemiunu's prototyper subagent. The coordinator hands you a brief — goal, primary user, the screen(s) to build, their sections/components, and real content. Turn it into a single self-contained low-fidelity HTML wireframe and save it with the save_prototype tool.

Rules:
- LOW-FIDELITY ONLY: grayscale (white/greys/black text), system font, no brand colours, no images (use labelled placeholder boxes). The goal is structure and flow, not visual design.
- Use REAL content from the brief — real labels, headings, field names, sample rows — never lorem ipsum.
- One self-contained index.html: all CSS inline in a <style> tag. NO external requests — no CDNs, fonts, images, or JS frameworks. Plain fl/grid CSS for layout is fine.
- Represent rich components as simple bordered boxes with a label (e.g. a chart → a box labelled "Line chart: paid net adds over time"; a table → a box with a few header cells and sample rows). Show key states (empty/loading) only if the brief calls for them.
- Build only the screen(s) in the brief. Add small annotation notes sparingly where they aid understanding.
- Save via save_prototype with a kebab-case slug and an index.html file. Then tell the coordinator in one or two lines what you built and the saved path. Do not address the end user directly.`;

export interface SubagentSpec {
  description: string;
  prompt: string;
  /** Which model tier this subagent runs on. */
  tier: "research" | "synthesis";
  /** The tool patterns this subagent may use, given the connected source tools. */
  tools: (sourceTools: string[]) => string[];
}

/** Single source of truth for subagents — used both for the SDK `agents`
 *  option (delegation via Task) and for code-level parallel fan-out. */
export const SUBAGENTS: Record<SubagentName, SubagentSpec> = {
  researcher: {
    description:
      "Searches the connected data sources (Notion, local files, and any other connected MCP servers) and returns grounded findings with citations. Delegate any question that needs looking things up, or any non-trivial product/research question.",
    prompt: RESEARCHER_PROMPT,
    tier: "research",
    tools: (sourceTools) => sourceTools,
  },
  prototyper: {
    description:
      "Turns a brief (goal, user, screens, sections, components, content) into a self-contained low-fidelity HTML wireframe and saves it. Delegate once you have a clear brief and the user wants something built/visualised.",
    prompt: PROTOTYPER_PROMPT,
    tier: "synthesis",
    tools: () => [PROTOTYPE_TOOLS],
  },
};

export const SUBAGENT_NAMES = Object.keys(SUBAGENTS) as SubagentName[];

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
  baseUrl: string;
  apiKey: string;
  thinking: Options["thinking"];
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
): Promise<string> {
  const spec = SUBAGENTS[name];
  const tools = spec.tools(ctx.sourceTools);
  let text = "";
  for await (const m of query({
    prompt,
    options: {
      model: modelFor(spec, ctx),
      thinking: ctx.thinking,
      systemPrompt: spec.prompt,
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: ctx.baseUrl,
        ANTHROPIC_API_KEY: ctx.apiKey,
      } as Record<string, string>,
      mcpServers: ctx.mcpServers,
      tools,
      allowedTools: tools,
    },
  })) {
    const msg = m as Record<string, unknown>;
    if (msg.type === "result" && typeof msg.result === "string") text = msg.result;
  }
  return text;
}
