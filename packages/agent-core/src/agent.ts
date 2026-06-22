import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config";
import { createMemoryServer, createModelsServer } from "./tools";
import { createPrototypeServer } from "./prototype";

/** Minimal default persona if context/soul.md is empty/missing. */
const DEFAULT_SOUL =
  "You are Hemiunu, a product agent for a product team. Be professional and concise, with simple, precise vocabulary. If you lack information, say so in one line.";

const MEMORY_TOOLS = "mcp__hemiunu-memory__*";
/** ask_model — one-shot calls to non-Claude models on the proxy. */
const MODEL_TOOLS = "mcp__hemiunu-models__*";
/** save_prototype — writes a wireframe into the prototypes/ sandbox. */
const PROTOTYPE_TOOLS = "mcp__hemiunu-prototype__*";
/** Built-in tool the main loop uses to delegate to a subagent (resolved id is "Task"). */
const DELEGATE_TOOL = "Task";

/** System prompt for the `researcher` subagent (runs on the cheaper retrieval tier). */
const RESEARCHER_PROMPT = `You are Hemiunu's research subagent. The coordinator delegates a research request to you; your job is to gather grounded information from the connected data sources so the coordinator can answer.

- Search the available sources (Notion, local files, and any other connected MCP servers) thoroughly. Run several searches/reads as needed — don't stop at the first hit.
- Return only what you actually found, each point attributed to its source (page title, file path, URL).
- If the sources do not contain the answer, say so plainly. Never invent facts or fill gaps from general knowledge.
- Output a concise findings brief (short bullets or sections) for the coordinator to synthesize. Do not address the end user directly.`;

/** System prompt for the `prototyper` subagent (generates low-fi HTML wireframes). */
const PROTOTYPER_PROMPT = `You are Hemiunu's prototyper subagent. The coordinator hands you a brief — goal, primary user, the screen(s) to build, their sections/components, and real content. Turn it into a single self-contained low-fidelity HTML wireframe and save it with the save_prototype tool.

Rules:
- LOW-FIDELITY ONLY: grayscale (white/greys/black text), system font, no brand colours, no images (use labelled placeholder boxes). The goal is structure and flow, not visual design.
- Use REAL content from the brief — real labels, headings, field names, sample rows — never lorem ipsum.
- One self-contained index.html: all CSS inline in a <style> tag. NO external requests — no CDNs, fonts, images, or JS frameworks. Plain fl/grid CSS for layout is fine.
- Represent rich components as simple bordered boxes with a label (e.g. a chart → a box labelled "Line chart: paid net adds over time"; a table → a box with a few header cells and sample rows). Show key states (empty/loading) only if the brief calls for them.
- Build only the screen(s) in the brief. Add small annotation notes sparingly where they aid understanding.
- Save via save_prototype with a kebab-case slug and an index.html file. Then tell the coordinator in one or two lines what you built and the saved path. Do not address the end user directly.`;

export interface RunTurnOptions {
  prompt: string;
  /** Main / synthesis model override (defaults to config/env HEMIUNU_MODEL). */
  model?: string;
  /** Retrieval-tier model for the researcher subagent (defaults to config/env HEMIUNU_MODEL_RESEARCH). */
  researchModel?: string;
  /** System prompt, normally built from context/ (soul + user + memory). */
  systemPrompt?: string;
  /** Session id to resume a prior conversation. */
  resume?: string;
  /** Extra MCP servers to connect (from the mcp.json registry). */
  mcpServers?: Record<string, unknown>;
  /** Tool-availability wildcards for the extra servers, e.g. `mcp__notion__*`. */
  toolPatterns?: string[];
  /** Interactive permission callback (yes / always / no). If omitted, tools are auto-approved. */
  canUseTool?: Options["canUseTool"];
  /** Abort controller to stop the turn mid-flight (Esc to interrupt). */
  abortController?: AbortController;
}

/**
 * Runs one agent turn and yields the raw SDK message stream.
 * Always connects the in-process `remember` tool; merges any registry servers.
 */
export async function* runTurn(opts: RunTurnOptions) {
  const cfg = loadConfig();
  const sourceTools = opts.toolPatterns ?? [];
  // A researcher only earns its keep when there are sources to search. With
  // none connected, the main loop just answers directly (still has memory).
  const hasSources = sourceTools.length > 0;

  // Subagent tools must also be in the parent allowlist to exist in the session
  // (so subagents can inherit them); soul.md steers the main loop to delegate
  // rather than do the heavy work itself. The `prototyper` is always available;
  // the `researcher` only when there are sources to search.
  const tools = [
    MEMORY_TOOLS,
    MODEL_TOOLS,
    PROTOTYPE_TOOLS,
    ...sourceTools,
    DELEGATE_TOOL,
  ];

  const agents: Record<string, AgentDefinition> = {
    // Generation tier: runs on the main/synthesis model; scoped to the
    // prototype writer only — it works from the brief, not from sources.
    prototyper: {
      description:
        "Turns a brief (goal, user, screens, sections, components, content) into a self-contained low-fidelity HTML wireframe and saves it. Delegate once you have a clear brief and the user wants something built/visualised.",
      prompt: PROTOTYPER_PROMPT,
      model: opts.model ?? cfg.model,
      tools: [PROTOTYPE_TOOLS],
    },
  };
  if (hasSources) {
    // Retrieval tier: the researcher runs on the cheaper model, scoped to the
    // source tools only — no memory writes, no nested delegation.
    agents.researcher = {
      description:
        "Searches the connected data sources (Notion, local files, and any other connected MCP servers) and returns grounded findings with citations. Delegate any question that needs looking things up, or any non-trivial product/research question.",
      prompt: RESEARCHER_PROMPT,
      model: opts.researchModel ?? cfg.researchModel,
      tools: sourceTools,
    };
  }

  const q = query({
    prompt: opts.prompt,
    options: {
      model: opts.model ?? cfg.model,
      thinking: cfg.thinking,
      systemPrompt: opts.systemPrompt ?? DEFAULT_SOUL,
      // Context is fully ours — don't load filesystem .claude/ config.
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: cfg.baseUrl,
        ANTHROPIC_API_KEY: cfg.apiKey,
      } as Record<string, string>,
      mcpServers: {
        "hemiunu-memory": createMemoryServer(),
        "hemiunu-models": createModelsServer(),
        "hemiunu-prototype": createPrototypeServer(),
        ...(opts.mcpServers ?? {}),
      } as Options["mcpServers"],
      agents,
      // Restrict the available toolset (default loads ~29 built-ins, whose
      // schemas are billed every turn). Only our in-process tools + enabled
      // source servers + the delegate tool for subagents.
      tools,
      // With a permission callback, every tool use is gated (yes/always/no).
      // Without one, pre-approve our tools so non-interactive runs don't block.
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : { allowedTools: tools }),
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  });

  for await (const message of q) {
    yield message;
  }
}
