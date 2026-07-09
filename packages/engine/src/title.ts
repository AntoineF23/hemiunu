// Conversation title generation, rewired to the model registry. The old flow
// (agent-core/tools.ts generateTitle) hit the raw Anthropic Messages API with
// HEMIUNU_TITLE_MODEL / retrieval-tier fallbacks; here the model comes from
// the registry's "title" tag instead, so any provider can serve it. Prompt and
// output cleaning are kept verbatim.

import { generateText } from "ai";
import {
  loadModelRegistry,
  modelForTag,
  resolveModel,
  type ModelEntry,
  type ResolvedModel,
} from "./models";

/** The title prompt — same text as the old agent-core generateTitle. */
export const TITLE_SYSTEM_PROMPT =
  "Write a 3–6 word title summarizing the user's message, in Title Case. " +
  "No surrounding quotes, no trailing punctuation, no preamble. Reply with ONLY the title.";

export interface GenerateTitleOptions {
  /** Registry override (default: loadModelRegistry()). */
  registry?: ModelEntry[];
  /** Test/DI seam: use this model instead of resolving the title entry. */
  resolvedModel?: ResolvedModel;
}

/**
 * The registry entry that serves titles: HEMIUNU_TITLE_MODEL (a registry id)
 * when set and known, else the first "title"-tagged entry, else the registry
 * head. Exported for tests.
 */
export function titleModelEntry(registry: ModelEntry[]): ModelEntry {
  const override = process.env.HEMIUNU_TITLE_MODEL?.trim();
  const overridden = override && registry.find((m) => m.id === override);
  return overridden || modelForTag("title", registry, registry[0].id);
}

/**
 * Generate a short conversation title from the user's first message with the
 * registry's title-tagged (small/cheap) model. Returns null on ANY failure so
 * the caller keeps its fallback title. The result is cleaned to a short,
 * quote-free, single-line title.
 */
export async function generateTitle(
  firstMessage: string,
  opts: GenerateTitleOptions = {},
): Promise<string | null> {
  const prompt = firstMessage.trim().slice(0, 2000);
  if (!prompt) return null;
  try {
    const resolved =
      opts.resolvedModel ??
      (() => {
        const registry = opts.registry ?? loadModelRegistry();
        return resolveModel(titleModelEntry(registry).id, registry);
      })();
    const { text } = await generateText({
      model: resolved.languageModel,
      system: TITLE_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 24,
    });
    const title = text
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 60)
      .trim();
    return title || null;
  } catch {
    return null;
  }
}
