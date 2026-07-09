import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV4GenerateResult, LanguageModelV4Usage } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelEntry, ResolvedModel } from "./models";
import { generateTitle, titleModelEntry, TITLE_SYSTEM_PROMPT } from "./title";

// --- fixtures -------------------------------------------------------------

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function generateResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

function entryFor(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "mock-title-model",
    label: "Mock title model",
    provider: "openai",
    model: "mock",
    contextWindow: 128_000,
    supports: { tools: true },
    ...over,
  };
}

function resolvedFor(model: MockLanguageModelV4): ResolvedModel {
  return { entry: entryFor(), languageModel: model };
}

// --- tests ----------------------------------------------------------------

test("title: prompt assembly — verbatim system prompt, trimmed 2000-char user message, 24-token cap", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [generateResult("Planning The Giza Site")] });
  const long = `  ${"x".repeat(2500)}  `;
  const title = await generateTitle(long, { resolvedModel: resolvedFor(model) });

  assert.equal(title, "Planning The Giza Site");
  const call = model.doGenerateCalls[0];
  assert.equal(call.maxOutputTokens, 24);
  assert.equal(call.prompt[0].role, "system");
  assert.equal(call.prompt[0].content, TITLE_SYSTEM_PROMPT);
  const userPart = call.prompt[1].content as { type: string; text?: string }[];
  assert.equal(userPart[0].text?.length, 2000); // trimmed, then sliced
});

test("title: output is cleaned — quotes stripped, whitespace collapsed, capped at 60 chars", async () => {
  const noisy = `"' ${"Grand ".repeat(20)}Plan '"`;
  const model = new MockLanguageModelV4({ doGenerate: [generateResult(`"A  Fine\n Title"`)] });
  assert.equal(await generateTitle("hi", { resolvedModel: resolvedFor(model) }), "A Fine Title");

  const longModel = new MockLanguageModelV4({ doGenerate: [generateResult(noisy)] });
  const long = await generateTitle("hi", { resolvedModel: resolvedFor(longModel) });
  assert.ok(long !== null && long.length <= 60);
  assert.ok(!long.startsWith('"') && !long.endsWith('"'));
});

test("title: empty or whitespace-only message returns null without a model call", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [generateResult("unused")] });
  assert.equal(await generateTitle("   ", { resolvedModel: resolvedFor(model) }), null);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("title: any failure returns null so the caller keeps its fallback", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      throw new Error("provider down");
    },
  });
  assert.equal(await generateTitle("hello there", { resolvedModel: resolvedFor(model) }), null);

  const blank = new MockLanguageModelV4({ doGenerate: [generateResult("   ")] });
  assert.equal(await generateTitle("hello there", { resolvedModel: resolvedFor(blank) }), null);
});

test("titleModelEntry: picks the title-tagged entry; HEMIUNU_TITLE_MODEL overrides by registry id", () => {
  const registry: ModelEntry[] = [
    entryFor({ id: "big-model", tags: ["synthesis"] }),
    entryFor({ id: "small-model", tags: ["title"] }),
  ];
  const saved = process.env.HEMIUNU_TITLE_MODEL;
  try {
    delete process.env.HEMIUNU_TITLE_MODEL;
    assert.equal(titleModelEntry(registry).id, "small-model");

    process.env.HEMIUNU_TITLE_MODEL = "big-model";
    assert.equal(titleModelEntry(registry).id, "big-model");

    process.env.HEMIUNU_TITLE_MODEL = "not-in-registry";
    assert.equal(titleModelEntry(registry).id, "small-model"); // unknown ids fall through

    // No title tag anywhere → the registry head serves titles.
    assert.equal(titleModelEntry([entryFor({ id: "only-model" })]).id, "only-model");
  } finally {
    if (saved === undefined) delete process.env.HEMIUNU_TITLE_MODEL;
    else process.env.HEMIUNU_TITLE_MODEL = saved;
  }
});
