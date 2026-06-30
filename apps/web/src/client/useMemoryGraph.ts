import { useCallback, useEffect, useState } from "react";
import { getJSON } from "./lib/api";

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
  editable: boolean;
  customized?: boolean;
  description?: string;
  // react-force-graph mutates nodes with simulation coordinates at runtime.
  x?: number;
  y?: number;
  z?: number;
}

export interface MemoryLink {
  // Strings on the wire; the force sim swaps in node refs after first render.
  source: string | MemoryNode;
  target: string | MemoryNode;
  access: "read" | "write" | "delegate";
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  links: MemoryLink[];
}

/** Fetch the agent's memory graph (agents + files + access edges). */
export function useMemoryGraph() {
  const [graph, setGraph] = useState<MemoryGraph>({ nodes: [], links: [] });

  const refresh = useCallback(async () => {
    try {
      setGraph(await getJSON<MemoryGraph>("/api/memory/graph"));
    } catch {
      /* worker not up yet — leave the last graph */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { graph, refresh };
}
