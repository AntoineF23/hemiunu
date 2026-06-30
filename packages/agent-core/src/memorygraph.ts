import { listCustomAgents } from "./agents";
import { configDir } from "./config";
import { listAttachments, hasKnowledgeOverride } from "./overlay";
import { loadSkills } from "./skills";
import { loadSourceMaps } from "./sources";
import { SUBAGENTS, SUBAGENT_NAMES } from "./subagents";

/**
 * Builds the data behind the web app's 3D memory graph: every agent and memory
 * file is a node, and every "agent X can access file Y" relationship is a link.
 *
 * The graph is computed from the REAL structures (the SUBAGENTS registry + the
 * on-disk files) so it can never drift from how memory actually works. Agents
 * are enumerated as data (built-in subagents now), so user-defined subagents
 * (a fast-follow) will appear with no changes here.
 */

export type MemoryNodeKind =
  | "agent"
  | "persona"
  | "user"
  | "knowledge"
  | "skill"
  | "source"
  | "prototype"
  | "context";

export interface MemoryNode {
  id: string;
  kind: MemoryNodeKind;
  label: string;
  /** Whether the panel may edit this node's underlying file. */
  editable: boolean;
  /** Knowledge packs only: true when a user override is in effect. */
  customized?: boolean;
  description?: string;
}

export interface MemoryLink {
  source: string;
  target: string;
  /** read/write = file access; delegate = the main agent hands off to a subagent. */
  access: "read" | "write" | "delegate";
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  links: MemoryLink[];
}

export interface MemoryGraphOptions {
  /** Currently-connected MCP server names. When provided, only source maps for
   *  a connected server are shown (matching what the agent actually surfaces) —
   *  stale scan files for disconnected servers are hidden. Omit to show all. */
  connectedServers?: string[];
}

export function buildMemoryGraph(
  root: string = configDir(),
  opts: MemoryGraphOptions = {},
): MemoryGraph {
  const nodes: MemoryNode[] = [];
  const links: MemoryLink[] = [];
  const has = (id: string) => nodes.some((n) => n.id === id);
  const add = (n: MemoryNode) => {
    if (!has(n.id)) nodes.push(n);
  };
  const link = (agent: string, target: string, access: "read" | "write" | "delegate") =>
    links.push({ source: `agent:${agent}`, target, access });

  // --- Agents (data-driven): the coordinator + each built-in subagent. ---
  add({
    id: "agent:main",
    kind: "agent",
    label: "main",
    editable: false,
    description: "The coordinator — talks to you and delegates.",
  });
  for (const name of SUBAGENT_NAMES) {
    add({
      id: `agent:${name}`,
      kind: "agent",
      label: name,
      editable: false,
      description: SUBAGENTS[name].description,
    });
    // The coordinator delegates to each subagent — show that hub relationship.
    link("main", `agent:${name}`, "delegate");
  }

  // User-defined subagents — editable nodes the coordinator can also summon.
  for (const a of listCustomAgents(root)) {
    add({
      id: `agent:${a.name}`,
      kind: "agent",
      label: a.name,
      editable: true,
      description: a.description,
    });
    link("main", `agent:${a.name}`, "delegate");
  }

  // --- Persona + global user memory (main only; subagents don't inherit them). ---
  add({
    id: "persona:soul",
    kind: "persona",
    label: "soul.md",
    editable: false,
    description: "The agent's persona (shipped, view-only).",
  });
  link("main", "persona:soul", "read");
  add({
    id: "user:user",
    kind: "user",
    label: "user.md",
    editable: true,
    description: "What the agent has learned about you.",
  });
  link("main", "user:user", "write");

  // --- Active feature knowledge (main; content loaded on click). ---
  add({
    id: "prototype:active",
    kind: "prototype",
    label: "PROTOTYPE.md",
    editable: true,
    description: "The active feature's brief & memory.",
  });
  link("main", "prototype:active", "write");

  // --- Knowledge packs → their one subagent (override-aware). ---
  for (const name of SUBAGENT_NAMES) {
    const k = SUBAGENTS[name].knowledge;
    if (!k) continue;
    const id = `knowledge:${k.name}`;
    add({
      id,
      kind: "knowledge",
      label: `${k.name}.md`,
      editable: true,
      customized: hasKnowledgeOverride(k.name, root),
      description: k.header,
    });
    link(name, id, "read");
  }

  // --- Skills (main). ---
  for (const s of loadSkills(root)) {
    const id = `skill:${s.name}`;
    add({ id, kind: "skill", label: s.name, editable: true, description: s.description });
    link("main", id, "write");
  }

  // --- Source maps (main + researcher). ---
  const hasResearcher = (SUBAGENT_NAMES as string[]).includes("researcher");
  const connected = opts.connectedServers;
  for (const m of loadSourceMaps(root)) {
    if (connected && !connected.includes(m.mcp)) continue; // hide stale/disconnected maps
    const id = `source:${m.mcp}`;
    add({ id, kind: "source", label: m.mcp, editable: true, description: m.description });
    link("main", id, "write");
    if (hasResearcher) link("researcher", id, "write");
  }

  // --- User context attachments → each agent they're attached to. ---
  const allAgents = nodes.filter((n) => n.kind === "agent").map((n) => n.id.slice("agent:".length));
  for (const a of listAttachments(root)) {
    const id = `context:${a.slug}`;
    add({ id, kind: "context", label: a.title, editable: true, description: a.description });
    const targets = a.agents.includes("*") || a.agents.includes("all") ? allAgents : a.agents;
    for (const t of targets) if (has(`agent:${t}`)) link(t, id, "read");
  }

  return { nodes, links };
}
