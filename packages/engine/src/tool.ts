// The frozen tool interface. Every capability the agent has — builtin tools,
// MCP tools, subagent spawners — implements HemiTool. The engine's loop (P1)
// only ever sees this shape; providers never do (tools are adapted to the AI
// SDK at the loop boundary).

import type { z } from "zod";
import type { ToolOutput, TurnEvent } from "./events";

/** Permission behavior for the whole turn. */
export type PermissionMode = "default" | "plan" | "acceptEdits";

/**
 * Everything a tool may touch at execution time. Deliberately minimal: the
 * engine must not depend on @hemiunu/agent-core (agent-core will depend on the
 * engine), so `workspace` is the minimal structural shape — agent-core's
 * richer WorkspaceContext is structurally compatible.
 */
export interface ToolContext {
  /** The workspace the conversation is bound to, if any. */
  workspace?: { repo: string; localSessionId?: string };
  /** Aborts when the user cancels the turn — long tools must honor it. */
  signal: AbortSignal;
  conversationId: string;
  /** Id of the tool call being executed (set by the executor per call). A
   *  delegating tool uses it as the `parent` stamp on subagent events. */
  toolCallId?: string;
  /** Emit a runtime event (progress, subagent output, todos, …). */
  emit(e: TurnEvent): void;
  /** Current permission mode. */
  mode(): PermissionMode;
  /** Switch permission mode (e.g. leaving plan mode after approval). */
  setMode(m: PermissionMode): void;
}

/**
 * Raw JSON Schema carrier for tools whose schema arrives off the wire (MCP
 * `tools/list`). It is NOT round-tripped through zod: the schema goes to the
 * provider verbatim (loop.ts wraps it with the AI SDK's `jsonSchema()`), and
 * validation is the light structural check in `validateToolInput` — the MCP
 * server remains the authority on its own schema.
 */
export interface JsonSchemaInput {
  /** The tool's input schema as plain JSON Schema (usually `type: "object"`). */
  jsonSchema: Record<string, unknown>;
}

/** A HemiTool's input schema: a zod schema (owned tools) OR raw JSON Schema (MCP). */
export type ToolInputSchema<I> = z.ZodType<I> | JsonSchemaInput;

/** True when the schema is the raw-JSON-Schema variant (an MCP tool's). */
export function isJsonSchemaInput(schema: ToolInputSchema<unknown>): schema is JsonSchemaInput {
  return typeof schema === "object" && schema !== null && "jsonSchema" in schema;
}

/** Outcome of validating a tool call's input against its schema. */
export type ToolInputValidation<I> = { ok: true; data: I } | { ok: false; issues: string };

/** Format zod issues into the self-repair message the model can act on. */
function zodIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/**
 * Validate a tool call's input against either schema variant. Zod schemas
 * parse as before (same issue formatting the pipeline always produced). Raw
 * JSON Schema gets a light structural check — object-ness and required keys —
 * and otherwise passes through untouched: the MCP server validates its own
 * inputs authoritatively, so a deep client-side validator would only drift.
 */
export function validateToolInput<I>(
  schema: ToolInputSchema<I>,
  input: unknown,
): ToolInputValidation<I> {
  if (!isJsonSchemaInput(schema)) {
    const parsed = schema.safeParse(input);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, issues: zodIssues(parsed.error) };
  }
  const js = schema.jsonSchema;
  if (js.type === "object") {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, issues: "expected an object of arguments" };
    }
    const record = input as Record<string, unknown>;
    // A required field that is absent, null, or an empty/whitespace string is
    // missing either way — weak models routinely send `""` for fields they
    // failed to fill, and the targeted message names exactly what to provide.
    const isEmpty = (v: unknown) =>
      v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    const required = Array.isArray(js.required) ? js.required : [];
    const missing = required.filter(
      (k): k is string => typeof k === "string" && isEmpty(record[k]),
    );
    if (missing.length) {
      return {
        ok: false,
        issues: missing
          .map((k) => `${k}: required${k in record ? " (was empty — provide a real value)" : ""}`)
          .join("; "),
      };
    }
  }
  return { ok: true, data: input as I };
}

export interface HemiTool<I = unknown> {
  /** Tool name; MCP tools keep the mcp__<server>__<tool> convention. */
  name: string;
  description: string;
  /** The tool's input schema — validated (validateToolInput) before execute. */
  inputSchema: ToolInputSchema<I>;
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>;
  /** "auto" runs without asking; "ask" (the default) needs permission. */
  permission?: "auto" | "ask";
  /** Read-only tools are the only ones kept in plan mode. */
  readOnly?: boolean;
  /** Input keys that are write destinations (workspace-guard confinement). */
  writeDestKeys?: string[];
}
