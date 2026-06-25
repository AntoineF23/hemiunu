import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK streams a wide discriminated union (`SDKMessage`). Consumers used to
 * reach into it via `as any` / `Record<string, any>`, which loses every field
 * type and hides shape drift. This module gives ONE audited cast (`asStream`)
 * and typed accessors, so call sites read fields with real types instead of
 * `any` while staying tolerant of additive SDK changes.
 */

/** A content block inside an assistant/user message (the fields we read). */
export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

/** Narrow, read-only view of the stream messages Hemiunu actually consumes. */
export interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  result?: unknown;
  total_cost_usd?: number | null;
  usage?: Record<string, number>;
  message?: { content?: ContentBlock[] };
}

/** View an SDK message through the narrow StreamMessage lens (the one cast). */
export function asStream(m: SDKMessage | unknown): StreamMessage {
  return m as StreamMessage;
}

/** The content blocks of an assistant message (empty for other message types). */
export function assistantBlocks(m: StreamMessage): ContentBlock[] {
  return m.type === "assistant" ? (m.message?.content ?? []) : [];
}
