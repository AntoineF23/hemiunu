// --- scrollback items ---
export type Item =
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
